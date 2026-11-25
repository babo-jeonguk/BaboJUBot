import { within } from "@babojubot/process/test-support";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 자리는 반납해도, 끝났음을 확인하지 못한 프로세스의 복구 기록은 다음 시작 때 다시 보도록 남긴다.
// 끄기의 실패는 공용 실행(@babojubot/process의 launchTree)의 경계 대역(`owningLaunchTree`)으로, 제품에 실제로 끈 뒤 실패로 답하는
// 끄기를 돌려줘 만든다. 트리(그룹·고아·표식을 가진 프로그램)를 끄는 일은 감독 실행기가 하고 그 답 하나가 끄기의 결과다(#268 PR 2).
// 실행기의 답이 끄기의 실패가 되는 길은 @babojubot/process의 launch-stop.test.ts가 본다. 실제 트리의 끄기는 대역이 띄운 직후 폴더
// 정리에 맡겨 트리의 끝을 확인한다.
vi.mock("@babojubot/process", async (original) =>
  (await import("./test-folders.ts")).owningLaunchTree(await original())
);

const folders = testFolders();
afterEach(() => {
  vi.restoreAllMocks();
});
async function run(stopFails: boolean) {
  const stateDir = await folders.make("babojubot-record-");
  // 실패 장면은 제품에 실제로 끈 뒤 실패로 답하는 끄기를 돌려준다(제품이 그것을 인수 없이 불렀는지는 장면의 정리가 본다).
  if (stopFails) folders.treeScene({ failProductStop: "after-stopping" });
  const start = () =>
    startProcess({
      stateDir,
      command: [process.execPath, "-e", ""],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      onFrame: async () => {},
    });
  // 끄기가 실패로 답하는 실행 시도는 그 끝이 `broken`이라 `ownBrokenRun`에 맡긴다(정리는 실행 시도를 끝내고 기록 쓰기가 끝나기를
  // 기다리고, 트리의 끝은 대역이 맡은 실제 끄기가 확인한다). 끄기가 성공하는 실행 시도는 `ownRun`이 끝을 확인한다.
  const attempt = stopFails
    ? folders.ownBrokenRun(start())
    : folders.ownRun(start());
  const exit = await within(attempt.done, 30_000, "the run did not finish");
  return { exit, records: await readdir(path.join(stateDir, "processes")) };
}

it("removes the record once the process is confirmed stopped", async () => {
  const { exit, records } = await run(false);
  expect(exit.broken).toBe(false);
  expect(records).toEqual([]);
});

// 끄지 못한 것이 남았으면(표식을 가진 프로그램 포함) 서버 운영 기록에 경고하고 기록은 남긴다(#219).
it("reports the run as broken but keeps the record when it could not be stopped", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { exit, records } = await run(true);
  expect(exit.broken).toBe(true);
  expect(records).toHaveLength(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("could not all be stopped")
  );
});
