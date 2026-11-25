import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openCodexConnection,
  ProtocolClosed,
  ProtocolRejection,
  ProtocolTimeout,
} from "./codex-connection.ts";
import { testFolders } from "./test-folders.ts";
import { openLifelines, type Lifelines } from "@babojubot/process/lifelines";
import { lifelineHolder } from "@babojubot/process/test-cleanup";

// 합성 peer(replay.mjs)로 응답·종료를 정한다. 모델·네트워크는 쓰지 않는다.
// 시험이 연 연결은 정리가 닫고 프로그램 정리(done)까지 기다린 뒤에 폴더를 지운다. 단언이 실패하거나 시한을 넘긴 시험도 같다.
const folders = testFolders();
/** 정리가 닫고 끝을 기다리는 연결. */
function openOwned(options: Parameters<typeof openCodexConnection>[0]) {
  const connection = openCodexConnection(options);
  folders.own(async () => {
    connection.close();
    await connection.done;
  }, "Codex connection");
  return connection;
}
// 프로그램이 남긴 자식은 연결을 쥐고 돈다. 끝은 번호가 아니라 연결의 닫힘으로 보고, 시험이 끄지 못한 것은 정리가 연결이 열려 있음을
// 본 직후에만 그 번호로 끈다(`lifelineHolder`). 끝난 번호는 다른 프로그램에 다시 쓰일 수 있다.
let lifelines: Lifelines;
beforeAll(async () => {
  lifelines = await openLifelines();
});
afterAll(() => lifelines.close());
let leftCount = 0;
/**
 * 프로그램이 남기는 자식(`script`, 연결을 쥐고 돈다)과 그 정리(`end`). 자식은 연결을 쥔 뒤 넷째 핸들에 한 줄을 쓴다. 프로그램은 그
 * 줄을 받은 뒤에 자식을 알려, 프로그램이 곧 끝나 자식이 함께 꺼져도 그 끝이 연결 닫힘으로 보인다.
 */
function leftChild(root: string) {
  const name = `left-child-${++leftCount}`;
  const held = lifelineHolder(
    lifelines,
    name,
    path.join(root, `${name}.pid`),
    'require("node:fs").writeSync(3, "connected\\n");'
  );
  return {
    name,
    script: `${held.code} setInterval(() => {}, 1000);`,
    end: held.end,
  };
}
async function peer(steps: unknown[]) {
  const root = await folders.make("codex-connection-");
  const file = path.join(root, "peer.json");
  await writeFile(file, JSON.stringify({ steps }));
  return openOwned({
    command: [process.execPath, path.resolve("test-fixtures/replay.mjs")],
    args: [file],
    cwd: root,
    env: { PATH: process.env.PATH },
  });
}

describe("a Codex app-server connection", () => {
  it("matches each response to its own request whatever the order, and ignores duplicate and unknown ids", async () => {
    const connection = await peer([
      { input: { id: 1, method: "first" } },
      { input: { id: 2, method: "second" } },
      { frame: { id: 2, result: { which: "second" } } },
      { frame: { id: 99, result: { which: "unknown" } } },
      { frame: { id: 1, result: { which: "first" } } },
      { frame: { id: 2, result: { which: "duplicate" } } },
      { input: { id: 3, method: "third" } },
      { frame: { id: 3, result: { which: "third" } } },
    ]);
    const first = connection.request("first", {}, { timeoutMs: 5_000 });
    const second = connection.request("second", {}, { timeoutMs: 5_000 });
    expect(await second).toEqual({ which: "second" });
    expect(await first).toEqual({ which: "first" });
    expect(await connection.request("third", {}, { timeoutMs: 5_000 })).toEqual(
      { which: "third" }
    );
    connection.close();
    await connection.done;
  });

  it("passes an explicit error as a rejection and keeps the connection open", async () => {
    const connection = await peer([
      { input: { id: 1, method: "refused" } },
      { frame: { id: 1, error: { code: -32600, message: "no" } } },
      { input: { id: 2, method: "next" } },
      { frame: { id: 2, result: {} } },
    ]);
    await expect(
      connection.request("refused", {}, { timeoutMs: 5_000 })
    ).rejects.toBeInstanceOf(ProtocolRejection);
    expect(connection.closed).toBe(false);
    expect(await connection.request("next", {}, { timeoutMs: 5_000 })).toEqual(
      {}
    );
    connection.close();
    await connection.done;
  });

  it("fails a request it cannot write with that error and keeps the connection open", async () => {
    // 쓰지 못한 요청(직렬화할 수 없는 값)은 프로그램에 닿지 않았다. 연결이 닫힌 것으로 바꾸지 않고 그 원인으로 실패한다.
    const connection = await peer([
      { input: { id: 2, method: "next" } },
      { frame: { id: 2, result: {} } },
    ]);
    await expect(
      connection.request("unwritable", { size: 1n }, { timeoutMs: 5_000 })
    ).rejects.toBeInstanceOf(TypeError);
    expect(connection.closed).toBe(false);
    expect(await connection.request("next", {}, { timeoutMs: 5_000 })).toEqual(
      {}
    );
    connection.close();
    await connection.done;
  });

  it("times a request out without closing, and a late answer does not complete the next request", async () => {
    const connection = await peer([
      { input: { id: 1, method: "slow" } },
      { input: { id: 2, method: "next" } },
      { frame: { id: 1, result: { which: "late" } } },
      { sleepMs: 100 },
      { frame: { id: 2, result: { which: "next" } } },
    ]);
    await expect(
      connection.request("slow", {}, { timeoutMs: 50 })
    ).rejects.toBeInstanceOf(ProtocolTimeout);
    expect(connection.closed).toBe(false);
    expect(await connection.request("next", {}, { timeoutMs: 5_000 })).toEqual({
      which: "next",
    });
    connection.close();
    await connection.done;
  });

  it("does not send a request whose time is already up", async () => {
    // replay.mjs ends with code 23 if the first line it reads is not this one.
    const connection = await peer([
      { input: { id: 1, method: "sent" } },
      { frame: { id: 1, result: {} } },
    ]);
    await expect(
      connection.request("never", {}, { timeoutMs: 0 })
    ).rejects.toBeInstanceOf(ProtocolTimeout);
    expect(await connection.request("sent", {}, { timeoutMs: 5_000 })).toEqual(
      {}
    );
    connection.close();
    expect((await connection.done).code).toBe(0);
  });

  it("on close, fails every waiting request at once, refuses new ones and ends the process", async () => {
    const connection = await peer([{ input: { id: 1, method: "waiting" } }]);
    const waiting = connection.request("waiting", {}, { timeoutMs: 60_000 });
    const failure = expect(waiting).rejects.toBeInstanceOf(ProtocolClosed);
    connection.close();
    await failure;
    expect(connection.closed).toBe(true);
    await expect(
      connection.request("after", {}, { timeoutMs: 60_000 })
    ).rejects.toBeInstanceOf(ProtocolClosed);
    expect(connection.notify("after")).toBe(false);
    await connection.done;
  });

  it("fails waiting requests as soon as the process dies, before its cleanup finishes", async () => {
    const connection = await peer([
      { input: { id: 1, method: "waiting" } },
      { exit: 3 },
    ]);
    const order: string[] = [];
    const waiting = connection
      .request("waiting", {}, { timeoutMs: 60_000 })
      .catch((error: unknown) => {
        order.push("request");
        return error;
      });
    const cleaned = connection.done.then((exit) => {
      order.push("cleanup");
      return exit;
    });
    expect(await waiting).toBeInstanceOf(ProtocolClosed);
    expect(connection.closed).toBe(true);
    await expect(
      connection.request("after", {}, { timeoutMs: 60_000 })
    ).rejects.toBeInstanceOf(ProtocolClosed);
    expect((await cleaned).code).toBe(3);
    expect(order).toEqual(["request", "cleanup"]);
  });

  // On windows-latest CI the request did not end within 15 s with this program; closing fd 0 most likely does not break the pipe there.
  // Windows write failures stay unchecked here; the rest of the connection runs on every platform.
  it.skipIf(process.platform === "win32")(
    "ends a request as soon as its write fails, while the program is still running, and the connection with it",
    async () => {
      // The program closes its input but keeps running, so writing to it fails (EPIPE).
      const root = await folders.make("codex-connection-");
      let ready!: () => void;
      const closedInput = new Promise<void>((resolve) => {
        ready = resolve;
      });
      // 프로그램은 연결을 쥔 뒤 준비를 알린다. 살아 있음은 그 연결로 본다. 입력이 깨져 연결의 끝은 `broken`이라(제품이 끝을
      // 확인했다는 증거가 없다) 연결 닫기만으로는 프로그램의 끝을 알 수 없다. 프로그램의 끝은 그 연결의 정리가 확인한다: 연결
      // 닫기·끝 기다리기(`openOwned`, 늦게 등록해 먼저 돎) 뒤에 연결의 닫힘을 보고, 남았으면 열려 있음을 본 직후에만 그 번호로 끈다.
      const name = `write-fails-${++leftCount}`;
      const held = lifelineHolder(
        lifelines,
        name,
        path.join(root, `${name}.pid`),
        'console.log(JSON.stringify({ method: "ready", params: {} }));'
      );
      folders.own(held.end, name);
      const connection = openOwned({
        command: [process.execPath],
        args: [
          "-e",
          `require("fs").closeSync(0); ${held.code} setInterval(() => {}, 1000)`,
        ],
        cwd: root,
        env: { PATH: process.env.PATH },
        onNotification: () => ready(),
      });
      await closedInput;
      await expect(
        connection.request("lost", {}, { timeoutMs: 60_000 })
      ).rejects.toBeInstanceOf(ProtocolClosed);
      // The failed write ends the wait at once, not when the program has been stopped about two seconds later.
      expect(lifelines.open(name)).toBe(true);
      expect(connection.closed).toBe(true);
      await expect(
        connection.request("after", {}, { timeoutMs: 60_000 })
      ).rejects.toBeInstanceOf(ProtocolClosed);
      await connection.done;
    },
    15_000
  );

  // Windows cannot find the children of a program that has already ended, so they are only stopped with the whole tree on cancel.
  it.skipIf(process.platform === "win32")(
    "fails waiting requests when the program dies even if a child it left behind keeps its output open, and keeps its last answer",
    async () => {
      const root = await folders.make("codex-connection-");
      // The program starts a child that shares its output and never ends, answers one request, then exits with the other unanswered.
      const left = leftChild(root);
      const program = `
        const child = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(left.script)}], { stdio: ["ignore", "inherit", "ignore", "pipe"] });
        child.stdio[3].once("data", () => console.log(JSON.stringify({ method: "child", params: {} })));
        require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const frame = JSON.parse(line);
          if (frame.method === "answered")
            process.stdout.write(JSON.stringify({ id: frame.id, result: { which: "answered" } }) + "\\n", () => process.exit(3));
        });`;
      let started!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const connection = openOwned({
        command: [process.execPath],
        args: ["-e", program],
        cwd: root,
        env: { PATH: process.env.PATH },
        onNotification: () => started(),
      });
      // 프로그램이 남긴 자식을 연결을 닫기 전에(등록 역순), 시험 폴더를 지우기 전에 끈다.
      folders.own(left.end, "the child the program left");

      await childStarted;
      const waiting = connection.request("waiting", {}, { timeoutMs: 15_000 });
      const failure = expect(waiting).rejects.toBeInstanceOf(ProtocolClosed);
      expect(
        await connection.request("answered", {}, { timeoutMs: 15_000 })
      ).toEqual({ which: "answered" });
      await failure;
      expect((await connection.done).code).toBe(3);
      // 프로그램과 함께 꺼진다. 끝은 자식이 쥔 연결의 닫힘으로 본다.
      await lifelines.closed(left.name);
    },
    30_000
  );

  // A child that left the program's process group cannot be stopped with it (on Windows no child can once the program has ended).
  // The waits still end when the program ends, and its last answer still arrives.
  it("fails waiting requests when the program dies even if a child it cannot stop keeps its output open", async () => {
    const root = await folders.make("codex-connection-");
    // The child runs outside the test folder: on Windows a just-killed process can still hold its folder, which blocks removing it.
    const left = leftChild(root);
    const program = `
      const child = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(left.script)}], { stdio: ["ignore", "inherit", "ignore", "pipe"], detached: true, cwd: require("os").tmpdir() });
      child.stdio[3].once("data", () => console.log(JSON.stringify({ method: "child", params: {} })));
      require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.method === "answered")
          process.stdout.write(JSON.stringify({ id: frame.id, result: { which: "answered" } }) + "\\n", () => process.exit(3));
      });`;
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const connection = openOwned({
      command: [process.execPath],
      args: ["-e", program],
      cwd: root,
      env: { PATH: process.env.PATH },
      onNotification: () => started(),
    });
    // 프로그램이 남긴 자식을 연결을 닫기 전에(등록 역순), 시험 폴더를 지우기 전에 끈다.
    folders.own(left.end, "the child the program left");

    await childStarted;
    const waiting = connection.request("waiting", {}, { timeoutMs: 15_000 });
    const failure = expect(waiting).rejects.toBeInstanceOf(ProtocolClosed);
    expect(
      await connection.request("answered", {}, { timeoutMs: 15_000 })
    ).toEqual({ which: "answered" });
    await failure;
    expect((await connection.done).code).toBe(3);
  }, 30_000);

  it("delivers a response the process wrote right before it exited", async () => {
    const connection = await peer([
      { input: { id: 1, method: "last" } },
      { frame: { id: 1, result: { which: "last" } } },
      { exit: 0 },
    ]);
    expect(await connection.request("last", {}, { timeoutMs: 5_000 })).toEqual({
      which: "last",
    });
    await connection.done;
  });

  it("hands notifications to the caller in order, and runs the handshake", async () => {
    const seen: unknown[] = [];
    const root = await folders.make("codex-connection-");
    const file = path.join(root, "peer.json");
    await writeFile(
      file,
      JSON.stringify({
        steps: [
          { input: { id: 1, method: "initialize" } },
          { frame: { method: "note", params: { n: 1 } } },
          { frame: { id: 7, method: "server/request", params: {} } },
          { frame: { id: 1, result: { ready: true } } },
          { input: { method: "initialized" } },
          { frame: { method: "note", params: { n: 2 } } },
          { exit: 0 },
        ],
      })
    );
    const connection = openOwned({
      command: [process.execPath, path.resolve("test-fixtures/replay.mjs")],
      args: [file],
      cwd: root,
      env: { PATH: process.env.PATH },
      onNotification: (frame) => {
        seen.push(frame.params);
      },
    });
    expect(await connection.initialize({ timeoutMs: 5_000 })).toEqual({
      ready: true,
    });
    expect((await connection.done).code).toBe(0);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
