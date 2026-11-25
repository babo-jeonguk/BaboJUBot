import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { awaitedLater } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";
import { readyLine, testFolders } from "@babojubot/process/testing";
import { expect, it } from "vitest";

// 자식의 import에는 파일 주소를 넘긴다. Windows 경로(`C:\\…`)는 ESM import가 받지 않는다.
const testing = new URL("./testing.ts", import.meta.url).href;

// 가짜 HTTP 서버의 처리기가 실패하면 요청한 쪽은 500을 받고, 러너는 잡히지 않은 오류로 그 실패를 받는다(CODING_STANDARDS.md#단언).
// 러너가 받는 것을 보려고 그 서버를 자식 프로그램으로 띄운다. 처리기가 실패하면 자식은 잡히지 않은 오류로 끝난다.
// 자식은 처리기에 닿은 단계를 한 줄씩 알린다(도착 신호).
const script = `
  import http from "node:http";
  import { once } from "node:events";
  const { answering } = await import(${JSON.stringify(testing)});
  const server = http.createServer(
    answering(async (req, res) => {
      if (req.url === "/fail") throw new Error("handler broke");
      if (req.url === "/fail-after-leave") {
        const left = once(res, "close");
        console.log("arrived");
        await left;
        throw new Error("handler broke after the client left");
      }
      if (req.url === "/read-body") {
        req.once("close", () => console.log("request closed"));
        console.log("reading");
        for await (const _ of req);
        res.end("read");
        return;
      }
      res.end("bye", () => process.exit(0));
    })
  );
  server.listen(0, "127.0.0.1", () => console.log(server.address().port + "\\nlistening"));
`;

const programs = testFolders();

/**
 * 가짜 서버 자식을 띄우고 듣는 포트를 받는다. `line(text)`는 자식이 그 줄을 알릴 때까지 기다린다(`readyLine`: 자식이 끝난 뒤에도
 * 출력이 끝날 때까지 읽는다). `ended()`는 자식이 끝나고 출력이 닫힌 것을 함께 본 종료 코드를 상한 안에서 기다린다. 출력(`stderr()`)은
 * 그 뒤에 단언한다.
 */
async function startFake() {
  // 실패를 알리지 않아 끝나지 않으면 시험이 끝날 때 끄고, 끝(exit)과 출력 닫힘(close)을 상한 안에서 확인한다(`ownChild`).
  const child = programs.ownChild(
    spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    })
  );
  // 끝(exit)과 출력의 끝을 함께 본 뒤에 오는 신호. IPC 채널이 없는 자식의 `close`는 끝나고 stdout·stderr가 모두 닫힌 뒤에 온다
  // (Node child_process 'close'). `exit` 때는 stderr의 마지막 조각이 아직 닿지 않았을 수 있다.
  const ended = awaitedLater(
    once(child, "close").then(([code]) => code as number | null)
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const line = (text: string) =>
    readyLine(child, text).catch((error: unknown) => {
      throw new Error(`fake server did not print "${text}": ${stderr}`, {
        cause: error,
      });
    });
  await line("listening");
  return {
    port: Number(stdout.split("\n")[0]),
    ended: () =>
      within(
        ended,
        10_000,
        `fake server ${child.pid} did not end with its output closed`
      ),
    line,
    stderr: () => stderr,
  };
}

/** 요청 머리(와 본문 일부)를 보낸 연결. 끊기는 시험이 정한다. */
async function rawRequest(port: number, text: string) {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(text);
  return socket;
}

it("answers a failed fake-server handler with a 500 and reports the failure as an uncaught error", async () => {
  const fake = await startFake();
  const response = await fetch(`http://127.0.0.1:${fake.port}/fail`);
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("handler broke");
  expect(await fake.ended()).toBe(1);
  expect(fake.stderr()).toContain(
    "가짜 HTTP 서버가 GET /fail을 처리하지 못했다"
  );
  expect(fake.stderr()).toContain("handler broke");
});

it("still reports a handler failure that comes after the client left before the reply", async () => {
  const fake = await startFake();
  const socket = await rawRequest(
    fake.port,
    "GET /fail-after-leave HTTP/1.1\r\nHost: x\r\n\r\n"
  );
  await fake.line("arrived");
  socket.destroy();
  expect(await fake.ended()).toBe(1);
  expect(fake.stderr()).toContain(
    "가짜 HTTP 서버가 GET /fail-after-leave을 처리하지 못했다"
  );
  expect(fake.stderr()).toContain("handler broke after the client left");
});

it("does not report the client's own cancellation while the handler reads the request", async () => {
  const fake = await startFake();
  const socket = await rawRequest(
    fake.port,
    "POST /read-body HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial"
  );
  await fake.line("reading");
  socket.destroy();
  // 서버가 끊긴 요청을 처리한 뒤에 끝내라고 한다. 그 사이 실패를 알렸다면 자식은 그 오류로 먼저 끝난다.
  await fake.line("request closed");
  const bye = await fetch(`http://127.0.0.1:${fake.port}/exit`);
  expect(await bye.text()).toBe("bye");
  expect(await fake.ended()).toBe(0);
  expect(fake.stderr()).not.toContain("처리하지 못했다");
});
