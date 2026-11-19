import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { expect, it, onTestFinished } from "vitest";

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
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

/** 가짜 서버 자식을 띄우고 듣는 포트를 받는다. `line(text)`는 자식이 그 줄을 알릴 때까지 기다린다. */
async function startFake() {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 실패를 알리지 않아 끝나지 않으면 시험이 끝날 때 끈다.
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  const lines = () => stdout.split("\n").map((l) => l.trim());
  const line = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!lines().includes(text)) return;
        child.stdout.off("data", check);
        resolve();
      };
      child.stdout.on("data", check);
      check();
      // 그 줄 없이 끝나면(가져오기 실패 등) 기다리지 않고 그 이유로 실패한다.
      exited.then(
        (code) =>
          reject(
            new Error(
              `fake server exited (${code}) before "${text}": ${stderr}`
            )
          ),
        reject
      );
    });
  child.stdout.on("data", (chunk) => (stdout += chunk));
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!/^\d+\n/.test(stdout)) return;
      child.stdout.off("data", check);
      resolve();
    };
    child.stdout.on("data", check);
    exited.then(
      (code) =>
        reject(
          new Error(`fake server exited (${code}) before listening: ${stderr}`)
        ),
      reject
    );
  });
  return { port: Number(lines()[0]), exited, line, stderr: () => stderr };
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
  expect(await fake.exited).not.toBe(0);
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
  expect(await fake.exited).not.toBe(0);
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
  expect(await fake.exited).toBe(0);
  expect(fake.stderr()).not.toContain("처리하지 못했다");
});
