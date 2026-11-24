import { within } from "@babojubot/process/test-support";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 자리는 반납해도, 끝났음을 확인하지 못한 프로세스의 복구 기록은 다음 시작 때 다시 보도록 남긴다.
const stop = vi.hoisted(() => ({
  fails: false,
}));
// 끄기의 실패는 공용 실행(@babojubot/process의 launchTree)이 돌려준 트리의 끄기에서 대역으로 만든다. 실제로 끈 뒤에 그 실패로
// 답한다. 트리(그룹·고아·표식을 가진 프로그램)를 끄는 일은 감독 실행기가 하고 그 답 하나가 끄기의 결과다(#268 PR 2). 실행기의 답이
// 끄기의 실패가 되는 길은 @babojubot/process의 launch-stop.test.ts가 본다.
vi.mock("@babojubot/process", async (original) => {
  const real = await original<typeof import("@babojubot/process")>();
  const launchTree = ((...args: Parameters<typeof real.launchTree>) => {
    const tree = real.launchTree(...args);
    const stopTree = tree.stop.bind(tree);
    tree.stop = async (options) => {
      await stopTree(options);
      if (stop.fails)
        throw new Error(
          "programs of this tree did not end (left: 1 (the tree did not end))"
        );
    };
    return tree;
  }) as typeof real.launchTree;
  return { ...real, launchTree };
});

const folders = testFolders();
afterEach(async () => {
  stop.fails = false;
  vi.restoreAllMocks();
});
async function run() {
  const stateDir = await folders.make("babojubot-record-");
  const exit = await within(
    folders.ownRun(
      startProcess({
        stateDir,
        command: [process.execPath, "-e", ""],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        onFrame: async () => {},
      })
    ).done,
    30_000,
    "the run did not finish"
  );
  return { exit, records: await readdir(path.join(stateDir, "processes")) };
}

it("removes the record once the process is confirmed stopped", async () => {
  const { exit, records } = await run();
  expect(exit.broken).toBe(false);
  expect(records).toEqual([]);
});

// 끄지 못한 것이 남았으면(표식을 가진 프로그램 포함) 서버 운영 기록에 경고하고 기록은 남긴다(#219).
it("reports the run as broken but keeps the record when it could not be stopped", async () => {
  stop.fails = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { exit, records } = await run();
  expect(exit.broken).toBe(true);
  expect(records).toHaveLength(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("could not all be stopped")
  );
});
