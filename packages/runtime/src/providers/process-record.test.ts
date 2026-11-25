import { within } from "@babojubot/process/test-support";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 자리는 반납해도, 끝났음을 확인하지 못한 프로세스의 복구 기록은 다음 시작 때 다시 보도록 남긴다.
const stop = vi.hoisted(() => ({
  fails: false,
  /** 대역의 끄기가 받은 인수. 제품은 인수 없이 부른다. */
  calls: [] as unknown[][],
}));
// 끄기의 실패는 공용 실행(@babojubot/process의 launchTree)의 경계에서 끄기만 다른 트리를 돌려줘 만든다. 실제로 끈 뒤에 그 실패로
// 답한다. 트리(그룹·고아·표식을 가진 프로그램)를 끄는 일은 감독 실행기가 하고 그 답 하나가 끄기의 결과다(#268 PR 2). 실행기의 답이
// 끄기의 실패가 되는 길은 @babojubot/process의 launch-stop.test.ts가 본다.
vi.mock("@babojubot/process", async (original) => {
  const real = await original<typeof import("@babojubot/process")>();
  const launchTree = ((...args: Parameters<typeof real.launchTree>) => {
    const tree = real.launchTree(...args);
    // 띄운 직후 실제 트리의 끄기를 폴더 정리에 맡긴다. 끄기의 실패로 답해도 정리는 실제 끄기로 트리의 끝을 확인한다(여러 번
    // 불러도 한 번만 끈다).
    folders.own(() => tree.stop(), "the tree, by its real stop");
    // 실제 트리는 바꾸지 않는다.
    return {
      ...tree,
      stop: async (...received: Parameters<typeof tree.stop>) => {
        stop.calls.push(received);
        await tree.stop(...received);
        if (stop.fails)
          throw new Error(
            "programs of this tree did not end (left: 1 (the tree did not end))"
          );
      },
    };
  }) as typeof real.launchTree;
  return { ...real, launchTree };
});

const folders = testFolders();
afterEach(async () => {
  stop.fails = false;
  stop.calls = [];
  vi.restoreAllMocks();
});
async function run() {
  const stateDir = await folders.make("babojubot-record-");
  const attempt = startProcess({
    stateDir,
    command: [process.execPath, "-e", ""],
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    onFrame: async () => {},
  });
  // 끄기가 실패로 답하는 실행 시도는 그 끝이 `broken`이라 `ownRun`(끝을 확인하지 못한 실행 시도를 정리 실패로 드러낸다)에 맡기지
  // 않는다. 정리는 실행 시도를 끝내고 그 일(기록 쓰기)이 끝나기를 기다린다. 트리의 끝은 대역이 띄운 직후 맡긴 실제 끄기가 확인한다.
  folders.own(async () => {
    attempt.end();
    await attempt.done;
  }, "run attempt");
  const exit = await within(attempt.done, 30_000, "the run did not finish");
  // 제품은 대역의 끄기를 인수 없이 불렀다.
  expect(stop.calls).not.toHaveLength(0);
  for (const received of stop.calls) expect(received).toEqual([]);
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
