import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { alive, startServerProcess } from "./server-process.ts";

// E2E 서버 프로세스 helper의 실패 경로. 고장 난 가짜 서버(misbehaving-server.mjs)로 만든다. 어느 경우든 helper는 시한 안에
// 실패를 알리고, 그 서버와 서버가 자기 임시 폴더에 띄운 Postgres를 끝내고, 그 임시 폴더를 지운다. Windows에서도 같은 길이다.

const entry = fileURLToPath(
  new URL("./misbehaving-server.mjs", import.meta.url)
);
type FakeState = { postgresPid: number; temp: string };

/** 가짜 서버를 `mode`로 띄운다. `state()`는 가짜 서버가 적은 가짜 Postgres pid와 임시 폴더다. */
function misbehaving(mode: "exit-before-ready" | "hang" | "disconnect") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "babojubot-misbehave-"));
  const file = path.join(dir, "state.json");
  const state = () => JSON.parse(readFileSync(file, "utf8")) as FakeState;
  return {
    state,
    start: () =>
      startServerProcess({
        entry,
        env: { MISBEHAVE: mode, MISBEHAVE_STATE: file },
        label: "고장 난 시험 서버",
      }),
    /** 시험이 실패해도 가짜 Postgres를 남기지 않는다. */
    cleanup: () => {
      try {
        const { postgresPid } = state();
        if (alive(postgresPid)) process.kill(postgresPid, "SIGKILL");
      } catch {
        /* 가짜 서버가 상태를 적기 전이다. */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a server that ends before it is ready leaves behind no Postgres it started", async () => {
  const fake = misbehaving("exit-before-ready");
  try {
    await expect(fake.start()).rejects.toThrow(/시작 전에 끝났다/);
    const { postgresPid, temp } = fake.state();
    expect(alive(postgresPid)).toBe(false);
    expect(existsSync(path.dirname(temp))).toBe(false);
  } finally {
    fake.cleanup();
  }
});

test("a server that stopped answering is killed with its Postgres within the deadline, even when the stop request cannot be written", async () => {
  test.setTimeout(60_000);
  const fake = misbehaving("hang");
  try {
    const server = await fake.start();
    expect(alive(server.postgresPid)).toBe(true);
    // 서버가 읽지 않는 채널을 채워, 멈춤 메시지를 보내는 일 자체가 끝나지 않게 한다.
    server.child.send({ type: "filler", data: "x".repeat(16 * 1024 * 1024) });
    await expect(server.stop()).rejects.toThrow(/끝나지 않아 강제로 끝냈다/);
    expect(alive(server.pid)).toBe(false);
    expect(alive(server.postgresPid)).toBe(false);
    expect(existsSync(server.folder)).toBe(false);
  } finally {
    fake.cleanup();
  }
});

test("a server that closed its channel is reported and killed with its Postgres", async () => {
  const fake = misbehaving("disconnect");
  try {
    const server = await fake.start();
    if (server.child.connected)
      await new Promise((resolve) => server.child.once("disconnect", resolve));
    await expect(server.stop()).rejects.toThrow(/멈춤 요청을 보내지 못했다/);
    expect(alive(server.pid)).toBe(false);
    expect(alive(server.postgresPid)).toBe(false);
    expect(existsSync(server.folder)).toBe(false);
  } finally {
    fake.cleanup();
  }
});
