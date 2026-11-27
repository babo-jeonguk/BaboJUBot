import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { removeFolder } from "./remove-folder.ts";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { releaseAcquired } from "./test-cleanup.ts";
import { testFolders } from "./test-folders.ts";

// 정리가 폴더 지우기를 부른 순서를 남긴다. 지우기는 그대로 한다.
const removals = vi.hoisted(() => [] as string[]);
vi.mock("./remove-folder.ts", async (original) => {
  const actual = await original<typeof import("./remove-folder.ts")>();
  return {
    ...actual,
    removeFolder: (...args: Parameters<typeof actual.removeFolder>) => {
      removals.push(args[0]);
      return actual.removeFolder(...args);
    },
  };
});

/**
 * 이 경로(`at`, 그 시험만의 무작위 접두)로 시작하는 폴더 만들기를 시험이 풀 때까지 붙잡는다. 붙잡은 만들기의 경로를 `held`에 남긴다.
 * 대역은 불린 순간 잡는다.
 */
const making = vi.hoisted(() => ({
  hold: undefined as
    | { at: string; gate: Promise<void>; held: string[]; reached: () => void }
    | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const mkdtemp = async (...args: Parameters<typeof actual.mkdtemp>) => {
    const hold = making.hold;
    if (hold && String(args[0]) === hold.at) {
      hold.held.push(hold.at);
      hold.reached();
      await hold.gate;
    }
    return actual.mkdtemp(...args);
  };
  return { ...actual, mkdtemp, default: { ...actual, mkdtemp } };
});

// 정리는 폴더를 쓰던 것이 모두 끝난 뒤에 폴더를 지운다. hook을 바꿔 끼워 정리를 시험이 직접 부른다.
function folders(options?: {
  stopTimeoutMs?: number;
  removeTimeoutMs?: number;
}) {
  let cleanup!: () => Promise<void>;
  const made = testFolders((run) => {
    cleanup = run;
  }, options);
  return { ...made, cleanup: () => cleanup() };
}

it("waits for what uses the folder to finish before removing it", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const order: string[] = [];
  removals.length = 0;
  // 맡긴 것은 시험이 풀어 줄 때까지 끝나지 않는다.
  let stopping!: () => void;
  const stopStarted = new Promise<void>((resolve) => (stopping = resolve));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  test.own(async () => {
    stopping();
    await finished;
    order.push(existsSync(root) ? "stopped with folder" : "folder gone");
  });
  const cleaning = test.cleanup();
  await stopStarted;
  // 멈춤이 끝나지 않은 동안에는 지우기를 부르지 않는다.
  expect(removals).toEqual([]);
  finish();
  await cleaning;
  expect(order).toEqual(["stopped with folder"]);
  expect(removals).toEqual([root]);
  expect(existsSync(root)).toBe(false);
});

it("keeps the folder and reports the failure when something using it does not stop", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  onTestFinished(() => removeFolder(root));
  test.own(async () => {
    throw new Error("did not stop");
  });
  await expect(test.cleanup()).rejects.toThrow("did not stop");
  expect(existsSync(root)).toBe(true);
});

it("stops a program still running in the folder and waits until it has ended and closed its output", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  await writeFile(path.join(root, "a.txt"), "");
  const child = test.ownChild(
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    })
  );
  await new Promise((resolve) => child.once("spawn", resolve));
  await test.cleanup();
  expect(child.signalCode ?? child.exitCode).not.toBeNull();
  expect(child.stdout!.destroyed && child.stderr!.destroyed).toBe(true);
  expect(existsSync(root)).toBe(false);
});

it("counts a program that already ended as stopped", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const child = test.ownChild(
    spawn(process.execPath, ["-e", ""], { cwd: root, stdio: "pipe" })
  );
  await new Promise((resolve) => child.once("close", resolve));
  await test.cleanup();
  expect(existsSync(root)).toBe(false);
});

// 정리의 첫 동기 단계는 자기를 닫고 맡은 호출 무장을 끝내는 것이다(시험 자원의 공용 소유 계약). 무장의 끝 표시는 정리가 무엇을
// 기다리기 전에 선다.
it("ends the call armings it owns as the first synchronous step of its cleanup", async () => {
  const test = folders();
  const order: string[] = [];
  test.own(async () => {
    order.push("stopped");
  });
  test.ownArming(async () => {
    order.push("arming ended");
  });
  const cleaning = test.cleanup();
  expect(order).toEqual(["arming ended"]);
  await cleaning;
  expect(order).toEqual(["arming ended", "stopped"]);
});

// 정리가 시작된 뒤 맡기는 것은 그 정리가 보지 못한다. 받지 않고 던진다.
it("refuses what is handed to it once its cleanup began", async () => {
  const test = folders();
  const cleaning = test.cleanup();
  expect(() => test.own(async () => {})).toThrow(
    "the test folders were already cleaned up"
  );
  expect(() => test.ownArming(async () => {})).toThrow(
    "the test folders were already cleaned up"
  );
  expect(() => test.adopt(path.join(tmpdir(), "not-made"))).toThrow(
    "the test folders were already cleaned up"
  );
  expect(() => test.make("test-folders-")).toThrow(
    "the test folders were already cleaned up"
  );
  await cleaning;
});

// 만들기의 끝을 정리가 시한 안에 확인하지 못하면 그 정리는 이미 실패를 알렸다. 그 뒤에 끝난 폴더는 어느 정리도 가져가지 않고 남긴다
// (그 폴더를 쓰는 시험 몸이 아직 돌 수 있다).
it("leaves a folder whose making ended only after its cleanup gave up on it", async () => {
  const test = folders({ stopTimeoutMs: 1, removeTimeoutMs: 10_000 });
  const at = path.join(tmpdir(), `test-folders-late-${randomUUID()}-`);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const hold = {
    at,
    gate: gate.promise,
    held: [] as string[],
    reached: reached.resolve,
  };
  making.hold = hold;
  onTestFinished(() => {
    making.hold = undefined;
    gate.resolve();
  });
  const made = test.make(path.basename(at), tmpdir());
  onTestFinished(() => releaseAcquired(made, (folder) => removeFolder(folder)));
  await reached.promise;
  expect(hold.held).toEqual([at]);
  await expect(test.cleanup()).rejects.toThrow(
    "a test folder being made did not finish"
  );
  gate.resolve();
  const late = await made;
  removals.length = 0;
  await test.cleanup();
  expect(removals).toEqual([]);
  expect(existsSync(late)).toBe(true);
});
