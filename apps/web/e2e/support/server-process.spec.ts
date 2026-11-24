import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import { killUnlessGone, withCleanup } from "@babojubot/process/test-cleanup";
import { expect, test } from "@playwright/test";
import {
  alive,
  gone,
  startServerProcess,
  stopChild,
  type StoppableChild,
  waitForReadyLine,
} from "./server-process.ts";
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

// 멈춤 요청 시한을 넘긴 뒤 강제로 끝내고 그 끝까지 시한 안에 확인하지 못하면, 두 실패를 모두 알린다. 끝 확인 실패만 던지면 첫 실패(멈춤
// 요청에 끝나지 않음)가 사라진다(#291 외부 리뷰 1회차 STD-1). 받은 신호와 메시지를 기록하는 가짜 자식으로 두 시한을 모두 넘기게 한다:
// 멈춤 요청의 보내기 콜백도, 종료도 오지 않는다.
test("reports both the stop request deadline and the end check after SIGKILL when neither ends", async () => {
  const sent: unknown[] = [];
  const signals: unknown[] = [];
  const child: StoppableChild = {
    exitCode: null,
    signalCode: null,
    send: (message) => {
      sent.push(message);
      return true;
    },
    kill: (signal) => {
      signals.push(signal);
      return true;
    },
  };
  const neverEnds = new Promise<{ code: number | null; signal: null }>(
    () => undefined
  );
  const failure = await stopChild(child, neverEnds, "fake server", () => "", {
    exitWaitMs: 20,
    killWaitMs: 20,
  }).then(
    () => undefined,
    (error: unknown) => error
  );
  // 두 실패를 묶은 AggregateError(combinedFailure): 멈춤 요청 시한 실패(원인은 그 시한)와 SIGKILL 뒤 끝 확인 실패.
  expect(failure).toBeInstanceOf(AggregateError);
  const combined = failure as AggregateError;
  expect(combined.message).toBe(
    "fake server could not be stopped: fake server가 멈춤 요청 뒤 20ms 안에 끝나지 않아 강제로 끝냈다:  — 그리고 fake server did not end after SIGKILL within 20 ms"
  );
  const [unstopped, unended, ...more] = combined.errors as Error[];
  expect(more).toEqual([]);
  expect(unstopped?.message).toBe(
    "fake server가 멈춤 요청 뒤 20ms 안에 끝나지 않아 강제로 끝냈다: "
  );
  expect((unstopped?.cause as Error | undefined)?.message).toBe(
    "fake server did not end after the stop request within 20 ms"
  );
  expect(unended?.message).toBe(
    "fake server did not end after SIGKILL within 20 ms"
  );
  expect(sent).toHaveLength(1);
  expect(signals).toEqual(["SIGKILL"]);
});

/** 가짜 자식의 표준 출력과, 거기 닿은 글을 모은 것(startServerProcess가 모으는 것과 같다). */
function fakeOutput() {
  const stdout = new PassThrough();
  let text = "";
  stdout.on("data", (chunk: Buffer) => (text += String(chunk)));
  return { stdout, text: () => text };
}

// 서버가 끝난(exit) 뒤에도 출력이 끝나기(end) 전에는 시작 줄이 닿을 수 있다. 시작 줄 대기는 exit가 아니라 출력의 끝에서 포기한다
// (CODING_STANDARDS.md, #288의 readyLine과 같은 기준, #291 parent 점검).
test("takes a ready line that reaches the pipe after the server exited, before its output ended", async () => {
  const { stdout, text } = fakeOutput();
  const ready = waitForReadyLine(
    { stdout },
    Promise.resolve({ code: 0, signal: null }),
    text,
    "fake server",
    text,
    { readyTimeoutMs: 10_000 }
  );
  await new Promise((resolve) => setImmediate(resolve));
  stdout.end("BaboJUBot server on http://127.0.0.1:1234 (fake)\n");
  await expect(ready).resolves.toBe("http://127.0.0.1:1234");
});

test("fails as ended before start when the output ends after the exit without a ready line", async () => {
  const { stdout, text } = fakeOutput();
  const ready = waitForReadyLine(
    { stdout },
    Promise.resolve({ code: 3, signal: null }),
    text,
    "fake server",
    text,
    { readyTimeoutMs: 10_000 }
  );
  await new Promise((resolve) => setImmediate(resolve));
  stdout.end("starting\n");
  await expect(ready).rejects.toThrow(
    new Error("fake server가 시작 전에 끝났다(code 3, signal null): starting\n")
  );
});

test("fails as an unconfirmed end when the output does not end after the exit", async () => {
  const { stdout, text } = fakeOutput();
  const ready = waitForReadyLine(
    { stdout },
    Promise.resolve({ code: 0, signal: null }),
    text,
    "fake server",
    text,
    { readyTimeoutMs: 10_000, outputEndMs: 20 }
  );
  await expect(ready).rejects.toThrow(
    new Error(
      "fake server가 시작 줄 없이 끝났고(code 0, signal null) 출력이 20ms 안에 끝나지 않아 끝을 확인하지 못했다(출력을 물려받은 자손이 쥐고 있을 수 있다): "
    )
  );
  stdout.destroy();
});

/** 이벤트 루프를 붙잡는 타이머 수. */
const liveTimers = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

// 시작 줄로 끝난 대기는 그 뒤 서버가 끝나도 아무 자원도 새로 잡지 않는다. Promise 구독은 풀 수 없어 끝난 뒤에도 불린다(#291 외부
// 리뷰 3회차 STD-4).
test("a wait that took the ready line starts no timer when the server exits afterwards", async () => {
  const { stdout, text } = fakeOutput();
  let exit!: (ended: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => (exit = resolve));
  const ready = waitForReadyLine(
    { stdout },
    exited,
    text,
    "fake server",
    text,
    {
      readyTimeoutMs: 10_000,
      outputEndMs: 10_000,
    }
  );
  stdout.write("BaboJUBot server on http://127.0.0.1:1234 (fake)\n");
  await expect(ready).resolves.toBe("http://127.0.0.1:1234");
  const before = liveTimers();
  exit({ code: 0, signal: null });
  // 대기가 먼저 건 구독이 이 await보다 먼저 불린다.
  await exited;
  expect(liveTimers()).toBe(before);
  stdout.destroy();
});
