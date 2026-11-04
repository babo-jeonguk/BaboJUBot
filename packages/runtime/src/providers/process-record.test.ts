import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startProcess } from "./process.ts";

// 자리는 반납해도, 끝났음을 확인하지 못한 프로세스의 복구 기록은 다음 시작 때 다시 보도록 남긴다.
const stop = vi.hoisted(() => ({ fails: false }));
vi.mock("./recovery.ts", async (original) => {
  const real = await original<typeof import("./recovery.ts")>();
  return {
    ...real,
    stopProcessGroup: async (group: number) => {
      if (stop.fails) throw new Error("Process group did not stop");
      await real.stopProcessGroup(group);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  stop.fails = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function run() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "babojubot-record-"));
  roots.push(stateDir);
  const exit = await startProcess({
    stateDir,
    command: [process.execPath, "-e", ""],
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    onFrame: async () => {},
  }).done;
  return { exit, records: await readdir(path.join(stateDir, "processes")) };
}

it("removes the record once the process is confirmed stopped", async () => {
  const { exit, records } = await run();
  expect(exit.broken).toBe(false);
  expect(records).toEqual([]);
});

it("reports the run as broken but keeps the record when it could not be stopped", async () => {
  stop.fails = true;
  const { exit, records } = await run();
  expect(exit.broken).toBe(true);
  expect(records).toHaveLength(1);
});
