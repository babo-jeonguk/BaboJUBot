import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openCodexConnection,
  ProtocolClosed,
  ProtocolRejection,
  ProtocolTimeout,
} from "./codex-connection.ts";

// 합성 peer(replay.mjs)로 응답·종료를 정한다. 모델·네트워크는 쓰지 않는다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function peer(steps: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-connection-"));
  roots.push(root);
  const file = path.join(root, "peer.json");
  await writeFile(file, JSON.stringify({ steps }));
  return openCodexConnection({
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
    void connection.done.then(() => order.push("cleanup"));
    expect(await waiting).toBeInstanceOf(ProtocolClosed);
    expect(connection.closed).toBe(true);
    await expect(
      connection.request("after", {}, { timeoutMs: 60_000 })
    ).rejects.toBeInstanceOf(ProtocolClosed);
    expect((await connection.done).code).toBe(3);
    expect(order).toEqual(["request", "cleanup"]);
  });

  it("ends a request whose write fails, and the connection with it", async () => {
    // The program closes its input but keeps running, so writing to it fails (EPIPE).
    const root = await mkdtemp(path.join(tmpdir(), "codex-connection-"));
    roots.push(root);
    let ready!: () => void;
    const closedInput = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const connection = openCodexConnection({
      command: [process.execPath],
      args: [
        "-e",
        `require("fs").closeSync(0); console.log(JSON.stringify({ method: "ready" })); setInterval(() => {}, 1000)`,
      ],
      cwd: root,
      env: { PATH: process.env.PATH },
      onNotification: () => ready(),
    });
    await closedInput;
    await expect(
      connection.request("lost", {}, { timeoutMs: 60_000 })
    ).rejects.toBeInstanceOf(ProtocolClosed);
    expect(connection.closed).toBe(true);
    await expect(
      connection.request("after", {}, { timeoutMs: 60_000 })
    ).rejects.toBeInstanceOf(ProtocolClosed);
    await connection.done;
  }, 15_000);

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
    const root = await mkdtemp(path.join(tmpdir(), "codex-connection-"));
    roots.push(root);
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
    const connection = openCodexConnection({
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
