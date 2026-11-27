import { within } from "@babojubot/process/test-support";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { openLifelines, type Lifelines } from "@babojubot/process/lifelines";
import { lifelineHolder } from "@babojubot/process/test-cleanup";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 실행 시도의 끄기가 실패하는 길(#263 외부 리뷰 1회차 SP1). 실제 프로세스로는 SIGKILL 뒤에도 끝나지 않는 대표를 만들 수 없어,
// 공용 실행(@babojubot/process의 launchTree)의 경계 대역(`owningLaunchTree`)으로 제품에는 끄기가 실패하는 트리를 돌려주고 나머지는
// 실제 프로세스로 본다. 실제 트리의 끄기는 대역이 띄운 직후 폴더 정리에 맡겨 감독 실행기와 트리 전체의 끝을 확인한다. 감독 실행기의
// 답이 끄기의 실패가 되는 길은 @babojubot/process의 launch-stop.test.ts가 본다. 끄기의 실패를 실행 시도의 끝으로 받는 길은 모든
// 시스템이 같으므로(Windows는 감독 실행기의 묶음이 끈다) 세 시스템에서 돈다(#286 항목 13).
vi.mock("@babojubot/process", async (original) =>
  (await import("./test-folders.ts")).owningLaunchTree(await original())
);

const folders = testFolders();
let lifelines: Lifelines;
beforeAll(async () => {
  lifelines = await openLifelines();
});
afterAll(async () => {
  await lifelines.close();
});
let count = 0;
const unique = (label: string) => `${label}-${++count}`;
const keep = "setInterval(() => {}, 1000);";

/**
 * 자기 번호를 파일에 남긴 뒤 연결을 쥐는 프로그램(#286: 번호를 먼저 남겨, 연결이 보이면 정리가 그 번호를 읽을 수 있다. 연결 뒤에
 * 남기면 그 사이 시험이 끝날 때 정리가 아직 없는 파일을 읽었다). 트리의 실제 끄기 뒤에도 남은 대표는 정리가 그 번호로 끈다. 연결이 열려 있으면
 * 그 번호의 프로세스는 아직 그 프로그램이다.
 */
async function holder(label: string, body = keep) {
  const name = unique(label);
  const folder = await folders.make("babojubot-launch-stop-");
  const pidFile = path.join(folder, "pid");
  const held = lifelineHolder(lifelines, name, pidFile);
  folders.own(held.end, name);
  return { name, script: `${held.code} ${body}` };
}

describe("stopping a tree", () => {
  it("ends an attempt as broken when its stop fails and the leader does not end", async () => {
    const leader = await holder("stuck-attempt");
    // 제품에는 아무것도 끄지 않고 실패하는 끄기를 돌려준다(제품이 그것을 인수 없이 불렀는지는 장면의 정리가 본다). 실제 끄기는
    // 정리가 부른다.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const attempt = folders.treeScene(
      { failProductStop: "without-stopping" },
      () =>
        startProcess({
          // 입력이 닫혀도 끝나지 않는다.
          command: [
            process.execPath,
            "-e",
            `process.stdin.resume(); ${leader.script}`,
          ],
          args: [],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH },
          onFrame: async () => {},
        })
    );
    // 끄기가 일부러 실패하는 실행 시도라 그 끝은 `broken`이다. 정리는 실행 시도를 끝내고 그 일이 끝나기를 기다린 뒤(`ownBrokenRun`),
    // 대역이 맡은 실제 끄기가 감독 실행기와 트리 전체의 끝을 확인하고, 마지막으로 대표의 연결(`holder`) 정리가 대표의 끝을 확인한다.
    folders.ownBrokenRun(attempt);
    await lifelines.connected(leader.name);
    attempt.end();
    const exit = await within(attempt.done, 30_000, "the run did not finish");
    expect(exit.broken).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("could not all be stopped")
    );
  }, 60_000);
});
