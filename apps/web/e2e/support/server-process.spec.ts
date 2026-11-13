import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { alive, startServerProcess } from "./server-process.ts";

// E2E 서버 프로세스 helper의 실패 경로. 고장 난 가짜 서버(misbehaving-server.mjs)로 만든다. 어느 경우든 helper는 시한 안에
// 실패를 알리고, 그 서버와 서버가 자기 임시 폴더에 띄운 Postgres를 끝내고, 그 임시 폴더를 지운다. 끝나지 않은 프로세스가 있거나
// 폴더를 지우지 못하면 폴더 경로를 실패에 남긴다. 실패가 여러 개면 모두 남긴다. Windows에서도 같은 길이다.

const entry = fileURLToPath(
  new URL("./misbehaving-server.mjs", import.meta.url)
);
type FakeState = { postgresPid: number; temp: string };

/** 지울 수 없는 폴더로 정리 실패를 만드는 시험의 건너뜀 이유(scripts/check-e2e-report.mjs의 허용 목록과 같다). */
const noFolderPermissionsOnWindows =
  "Windows에서는 폴더 권한으로 삭제를 막을 수 없다";

/** 가짜 서버를 `mode`로 띄운다. `state()`는 가짜 서버가 적은 가짜 Postgres pid와 임시 폴더다. */
function misbehaving(
  mode:
    | "exit-before-ready"
    | "hang"
    | "disconnect"
    | "leave-postgres-on-stop"
    | "exit-before-ready-undeletable"
) {
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
    /** 시험이 실패하거나 helper가 폴더를 남겨도 가짜 Postgres와 폴더를 남기지 않는다. */
    cleanup: () => {
      try {
        const { postgresPid, temp } = state();
        if (alive(postgresPid)) process.kill(postgresPid, "SIGKILL");
        const undeletable = path.join(temp, "undeletable");
        if (existsSync(undeletable)) chmodSync(undeletable, 0o700);
        rmSync(path.dirname(temp), {
          recursive: true,
          force: true,
          maxRetries: 5,
        });
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

test("a Postgres that outlives its removed lock file keeps the folder, and the failure names it", async () => {
  const fake = misbehaving("leave-postgres-on-stop");
  try {
    const server = await fake.start();
    const error = await server.stop().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(error?.message).toMatch(
      new RegExp(`내장 Postgres\\(pid ${server.postgresPid}\\)가 남았다`)
    );
    expect(error?.message).toContain(server.folder);
    // 잠금 파일이 없어 신원을 확인할 수 없는 프로세스는 끝내지 않고, 그 프로세스가 쓸 수 있는 폴더도 지우지 않는다.
    expect(alive(server.postgresPid)).toBe(true);
    expect(existsSync(server.folder)).toBe(true);
  } finally {
    fake.cleanup();
  }
});

test("a server that ends before it is ready and whose folder cannot be removed reports both failures", async () => {
  test.skip(process.platform === "win32", noFolderPermissionsOnWindows);
  const fake = misbehaving("exit-before-ready-undeletable");
  try {
    const error = await fake.start().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    const { postgresPid, temp } = fake.state();
    expect(error?.message).toMatch(/시작 전에 끝났다/);
    expect(error?.message).toContain(
      `폴더를 지우지 못했다: ${path.dirname(temp)}`
    );
    expect(alive(postgresPid)).toBe(false);
  } finally {
    fake.cleanup();
  }
});
