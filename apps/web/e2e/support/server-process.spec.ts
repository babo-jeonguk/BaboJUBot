import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import { killUnlessGone, withCleanup } from "@babojubot/runtime/test-cleanup";
import { expect, test } from "@playwright/test";
import { alive, gone, startServerProcess } from "./server-process.ts";
import { attemptAll } from "@babojubot/contracts";

// E2E 서버 프로세스 helper의 실패 경로. 고장 난 가짜 서버(misbehaving-server.mjs)로 만든다. 어느 경우든 helper는 시한 안에
// 실패를 알리고, 그 서버와 서버가 자기 임시 폴더에 띄운 Postgres를 끝내고, 그 임시 폴더를 지운다. 끝나지 않은 프로세스가 있거나
// 폴더를 지우지 못하면 폴더 경로를 실패에 남긴다. 실패가 여러 개면 모두 남긴다. Windows에서도 같은 길이다.

const entry = fileURLToPath(
  new URL("./misbehaving-server.mjs", import.meta.url)
);
type FakeState = { postgresPid: number; temp: string };
/** 정리가 SIGKILL을 보낸 가짜 Postgres가 끝나기까지. */
const killWaitMs = 10_000;

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
    | "exit-before-ready-without-temp"
    | "exit-before-ready-unreadable-lock"
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
    /**
     * 시험이 실패하거나 helper가 폴더를 남겨도 가짜 Postgres와 폴더를 남기지 않는다. 폴더는 가짜 Postgres가 끝난 뒤에 지우고,
     * 끝나지 않으면 폴더를 남긴 채 그 사실로 실패한다.
     */
    cleanup: () =>
      attemptAll([
        async () => {
          if (!existsSync(file)) return;
          const { postgresPid, temp } = state();
          killUnlessGone(postgresPid);
          if (!(await gone(postgresPid, killWaitMs)))
            throw new Error(
              `가짜 Postgres(pid ${postgresPid})가 ${killWaitMs}ms 안에 끝나지 않아 폴더를 남겼다: ${temp}`
            );
          const undeletable = path.join(temp, "undeletable");
          if (existsSync(undeletable)) chmodSync(undeletable, 0o700);
          await removeFolder(path.dirname(temp));
        },
        // 상태 파일의 폴더는 가짜 서버의 임시 폴더와 따로 있어, 그 폴더를 남겨도 지운다.
        () => removeFolder(dir),
      ]),
  };
}

test("a server that ends before it is ready leaves behind no Postgres it started", async () => {
  const fake = misbehaving("exit-before-ready");
  await withCleanup(async (defer) => {
    defer(() => fake.cleanup());
    await expect(fake.start()).rejects.toThrow(/시작 전에 끝났다/);
    const { postgresPid, temp } = fake.state();
    expect(alive(postgresPid)).toBe(false);
    expect(existsSync(path.dirname(temp))).toBe(false);
  });
});

test("a server that stopped answering is killed with its Postgres within the deadline, even when the stop request cannot be written", async () => {
  test.setTimeout(60_000);
  const fake = misbehaving("hang");
  await withCleanup(async (defer) => {
    defer(() => fake.cleanup());
    const server = await fake.start();
    expect(alive(server.postgresPid)).toBe(true);
    // 서버가 읽지 않는 채널을 채워, 멈춤 메시지를 보내는 일 자체가 끝나지 않게 한다.
    server.child.send({ type: "filler", data: "x".repeat(16 * 1024 * 1024) });
    await expect(server.stop()).rejects.toThrow(/끝나지 않아 강제로 끝냈다/);
    expect(alive(server.pid)).toBe(false);
    expect(alive(server.postgresPid)).toBe(false);
    expect(existsSync(server.folder)).toBe(false);
  });
});

test("a server that closed its channel is reported and killed with its Postgres", async () => {
  const fake = misbehaving("disconnect");
  await withCleanup(async (defer) => {
    defer(() => fake.cleanup());
    const server = await fake.start();
    if (server.child.connected)
      await new Promise((resolve) => server.child.once("disconnect", resolve));
    await expect(server.stop()).rejects.toThrow(/멈춤 요청을 보내지 못했다/);
    expect(alive(server.pid)).toBe(false);
    expect(alive(server.postgresPid)).toBe(false);
    expect(existsSync(server.folder)).toBe(false);
  });
});

test("a Postgres that outlives its removed lock file keeps the folder, and the failure names it", async () => {
  const fake = misbehaving("leave-postgres-on-stop");
  await withCleanup(async (defer) => {
    defer(() => fake.cleanup());
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
  });
});

test("a server that ends before it is ready and whose folder cannot be removed reports both failures", async () => {
  test.skip(process.platform === "win32", noFolderPermissionsOnWindows);
  const fake = misbehaving("exit-before-ready-undeletable");
  await withCleanup(async (defer) => {
    defer(() => fake.cleanup());
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
  });
});

test("a cleanup step that fails does not hide the start failure, and an unchecked folder is kept and named", async () => {
  const fake = misbehaving("exit-before-ready-without-temp");
  await withCleanup(async (defer) => {
    defer(() => fake.cleanup());
    const error = await fake.start().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    const folder = path.dirname(fake.state().temp);
    expect(error?.message).toMatch(/시작 전에 끝났다/);
    expect(error?.message).toMatch(/ENOENT/);
    // 남은 Postgres를 확인하지 못했으므로 폴더를 지우지 않고 경로를 알린다.
    expect(error?.message).toContain(folder);
    expect(existsSync(folder)).toBe(true);
  });
});

// 잠금 파일을 읽지 못하면 그 폴더의 Postgres가 남았는지 모른다. 없는 것으로 보고 폴더를 지우지 않고, 읽지 못한 파일과 원인을 알린다(#243).
test("a lock file that cannot be read is reported with its path, and the folder is kept", async () => {
  const fake = misbehaving("exit-before-ready-unreadable-lock");
  await withCleanup(async (defer) => {
    defer(() => fake.cleanup());
    const error = await fake.start().then(
      () => undefined,
      (e: unknown) => e as Error
    );
    const { temp } = fake.state();
    const lock = path.join(temp, "babojubot-pg-unreadable", "postmaster.pid");
    expect(error?.message).toMatch(/시작 전에 끝났다/);
    expect(error?.message).toContain(
      `잠금 파일을 읽지 못했다(EISDIR): ${lock}`
    );
    expect(error?.message).toContain(
      `남은 Postgres를 확인하지 못해 고장 난 시험 서버의 폴더를 지우지 않았다: ${path.dirname(temp)}`
    );
    expect(existsSync(path.dirname(temp))).toBe(true);
  });
});
