import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { removeFolder } from "../remove-folder.ts";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { testFolders } from "./test-folders.ts";
import type { RunResult, RuntimeAdapter } from "@babojubot/contracts";
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

/** 멈춤 신호를 받아야 끝나는 실행 시도. `never`면 신호를 받아도 끝나지 않는다. */
function heldProvider(order: string[], root: string, never = false) {
  const execute = (_request: unknown, { signal }: { signal: AbortSignal }) =>
    new Promise<RunResult>((resolve) => {
      if (never) return;
      signal.addEventListener("abort", () =>
        setTimeout(() => {
          order.push(
            existsSync(root) ? "run ended with folder" : "folder gone"
          );
          resolve({ stopReason: "cancelled" } as RunResult);
        }, 20)
      );
    });
  return {
    adapter: {
      execute,
      checkReadiness: async () => ({ status: "ready" }) as never,
    } as unknown as RuntimeAdapter,
  };
}

it("stops a provider run a failed test left in progress and removes the folder only after the run ends", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const order: string[] = [];
  const provider = test.ownProvider(heldProvider(order, root));
  // 시험이 실행을 시작한 뒤 결과를 기다리기 전에 단언·시한으로 실패했다.
  void provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  await test.cleanup();
  expect(order).toEqual(["run ended with folder"]);
  expect(existsSync(root)).toBe(false);
});

it("keeps the folder and fails by name when a provider run does not end after the stop", async () => {
  const test = folders({ stopTimeoutMs: 50 });
  const root = await test.make("test-folders-");
  onTestFinished(() => removeFolder(root));
  const provider = test.ownProvider(heldProvider([], root, true));
  void provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  await expect(test.cleanup()).rejects.toThrow(
    "provider run did not stop within 50ms"
  );
  expect(existsSync(root)).toBe(true);
});

it("owns the runs of providers made by a factory passed around as a value", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const order: string[] = [];
  // 시험 표(describe.each·it.each)나 연결 설정에 담아 넘긴 factory도 만든 연결의 실행을 정리에 맡긴다.
  const table = [{ create: test.owning(() => heldProvider(order, root)) }];
  for (const { create } of table)
    void create().adapter.execute(request(), {
      signal: new AbortController().signal,
      emit: async () => {},
    });
  // 실행이 끝나기 전에 시험이 다른 단언(poll)에서 실패했다.
  await test.cleanup();
  expect(order).toEqual(["run ended with folder"]);
  expect(existsSync(root)).toBe(false);
});

it("owns a provider once even when it is handed to cleanup twice", async () => {
  const test = folders({ stopTimeoutMs: 50 });
  const root = await test.make("test-folders-");
  onTestFinished(() => removeFolder(root));
  // owning으로 묶은 factory가 만든 연결을 다시 ownProvider로 감싸도 실행은 정리에 한 번만 맡겨진다.
  const create = test.owning(() => heldProvider([], root, true));
  const provider = test.ownProvider(create());
  void provider.adapter.execute(request(), {
    signal: new AbortController().signal,
    emit: async () => {},
  });
  const failure = await test.cleanup().catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    message: "provider run did not stop within 50ms",
  });
});
