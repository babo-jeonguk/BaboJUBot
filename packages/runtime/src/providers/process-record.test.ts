import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 자리는 반납해도, 끝났음을 확인하지 못한 프로세스의 복구 기록은 다음 시작 때 다시 보도록 남긴다.
const stop = vi.hoisted(() => ({
  fails: false,
  leaseFails: false,
  leaseLeft: false,
}));
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

vi.mock("./lease.ts", async (original) => {
  const real = await original<typeof import("./lease.ts")>();
  return {
    ...real,
    stopLeaseHolders: async (
      lease: string,
      options?: Parameters<typeof real.stopLeaseHolders>[1]
    ) => {
      if (stop.leaseFails) throw new Error("ps failed");
      // 끝까지 꺼지지 않은 프로그램이 남은 결과다.
      if (stop.leaseLeft) return { stopped: [], left: [2 ** 22 + 1] };
      return real.stopLeaseHolders(lease, options);
    },
  };
});

const folders = testFolders();
afterEach(async () => {
  stop.fails = false;
  stop.leaseFails = false;
  stop.leaseLeft = false;
  vi.restoreAllMocks();
});
async function run() {
  const stateDir = await folders.make("babojubot-record-");
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

// 표식으로 찾지 못하거나 끄지 못한 것도 그룹을 끄지 못한 것과 같다. 서버 운영 기록에 경고하고 기록은 남긴다(#219).
it.skipIf(process.platform === "win32").each([
  ["could not be looked up", "leaseFails"],
  ["did not stop in time", "leaseLeft"],
] as const)(
  "keeps the record when programs with the run marker %s",
  async (_, failure) => {
    stop[failure] = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { exit, records } = await run();
    expect(exit.broken).toBe(true);
    expect(records).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("could not all be stopped")
    );
  }
);
