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
// 끄기의 실패는 공용 실행(@babojubot/process의 launchTree)이 돌려준 트리의 끄기에서 대역으로 만든다. 실제로 끈 뒤에 그 실패로
// 답한다. 그룹 끄기·표식 정리 각각의 실패가 끄기의 실패가 되는지는 @babojubot/process의 launch-stop.test.ts가 본다.
vi.mock("@babojubot/process", async (original) => {
  const real = await original<typeof import("@babojubot/process")>();
  const launchTree = ((...args: Parameters<typeof real.launchTree>) => {
    const tree = real.launchTree(...args);
    const stopTree = tree.stop.bind(tree);
    tree.stop = async (options) => {
      await stopTree(options);
      if (stop.fails) throw new Error("Process group did not stop");
      if (stop.leaseFails) throw new Error("ps failed");
      // 끝까지 꺼지지 않은 프로그램이 남은 결과다.
      if (stop.leaseLeft)
        throw new Error("Programs with the run marker did not stop");
    };
    return tree;
  }) as typeof real.launchTree;
  return { ...real, launchTree };
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
