import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { removeFolder } from "../remove-folder.ts";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { testFolders } from "./test-folders.ts";
import type { RunResult, RuntimeAdapter } from "@babojubot/contracts";
import { fakeDeclarations } from "../testing.ts";
import { request } from "./test-support.ts";

// 정리가 폴더 지우기를 부른 순서를 남긴다. 지우기는 그대로 한다.
const removals = vi.hoisted(() => [] as string[]);
vi.mock("../remove-folder.ts", async (original) => {
  const actual = await original<typeof import("../remove-folder.ts")>();
  return {
    ...actual,
    removeFolder: (...args: Parameters<typeof actual.removeFolder>) => {
      removals.push(args[0]);
      return actual.removeFolder(...args);
    },
  };
});

// 정리는 폴더를 쓰던 것이 모두 끝난 뒤에 폴더를 지운다. hook을 바꿔 끼워 정리를 시험이 직접 부른다.
function folders(options?: { stopTimeoutMs?: number }) {
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

/**
 * 멈춤 신호를 받아야 끝나는 실행 시도. `stuck`을 주면 신호를 받아도 끝나지 않고, 시험이 `stuck`을 풀어야 끝난다.
 * 끝날 때 그 폴더가 아직 있었는지 `order`에 남긴다.
 */
function heldProvider(order: string[], root: string, stuck?: Promise<void>) {
  const end = (): RunResult => {
    order.push(existsSync(root) ? "run ended with folder" : "folder gone");
    return {
      stopReason: "cancelled",
      error: null,
      summary: null,
      usage: null,
      nextSession: null,
    };
  };
  const execute: RuntimeAdapter["execute"] = (_request, { signal }) =>
    stuck
      ? stuck.then(end)
      : new Promise<RunResult>((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => resolve(end()), 20)
          );
        });
  return {
    adapter: { ...fakeDeclarations(), execute } satisfies RuntimeAdapter,
  };
}

/** 시험이 풀 때까지 끝나지 않게 붙잡는 문. */
function stuckRun() {
  let letGo!: () => void;
  const stuck = new Promise<void>((resolve) => (letGo = resolve));
  return { stuck, letGo };
}

const runOptions = () => ({
  signal: new AbortController().signal,
  emit: async () => {},
});

it("stops a provider run a failed test left in progress and removes the folder only after the run ends", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const order: string[] = [];
  const provider = test.ownProvider(heldProvider(order, root));
  // 시험이 실행을 시작한 뒤 결과를 기다리기 전에 단언·시한으로 실패했다.
  const run = provider.adapter.execute(request(), runOptions());
  await test.cleanup();
  expect(order).toEqual(["run ended with folder"]);
  expect(existsSync(root)).toBe(false);
  await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
});

it("keeps the folder and fails by name when a provider run does not end after the stop", async () => {
  const test = folders({ stopTimeoutMs: 50 });
  const root = await test.make("test-folders-");
  onTestFinished(() => removeFolder(root));
  const { stuck, letGo } = stuckRun();
  const order: string[] = [];
  const provider = test.ownProvider(heldProvider(order, root, stuck));
  const run = provider.adapter.execute(request(), runOptions());
  await expect(test.cleanup()).rejects.toThrow(
    "provider run did not stop within 50ms"
  );
  expect(existsSync(root)).toBe(true);
  // 남긴 폴더 안에서 실행이 늦게 끝난다.
  letGo();
  await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
  expect(order).toEqual(["run ended with folder"]);
});

it("owns the runs of providers made by a factory passed around as a value", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const order: string[] = [];
  // 시험 표(describe.each·it.each)나 연결 설정에 담아 넘긴 factory도 만든 연결의 실행을 정리에 맡긴다.
  const table = [{ create: test.owning(() => heldProvider(order, root)) }];
  const runs = table.map(({ create }) =>
    create().adapter.execute(request(), runOptions())
  );
  // 실행이 끝나기 전에 시험이 다른 단언(poll)에서 실패했다.
  await test.cleanup();
  expect(order).toEqual(["run ended with folder"]);
  expect(existsSync(root)).toBe(false);
  for (const result of await Promise.all(runs))
    expect(result).toMatchObject({ stopReason: "cancelled" });
});

it("owns a provider once even when it is handed to cleanup twice", async () => {
  const test = folders({ stopTimeoutMs: 50 });
  const root = await test.make("test-folders-");
  onTestFinished(() => removeFolder(root));
  const { stuck, letGo } = stuckRun();
  // owning으로 묶은 factory가 만든 연결을 다시 ownProvider로 감싸도 실행은 정리에 한 번만 맡겨진다.
  const create = test.owning(() => heldProvider([], root, stuck));
  const provider = test.ownProvider(create());
  const run = provider.adapter.execute(request(), runOptions());
  const failure = await test.cleanup().catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    message: "provider run did not stop within 50ms",
  });
  letGo();
  await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
});
