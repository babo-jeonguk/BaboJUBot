import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { removeFolder } from "./remove-folder.ts";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
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
