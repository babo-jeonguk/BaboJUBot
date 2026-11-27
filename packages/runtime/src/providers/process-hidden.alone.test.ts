import { within } from "@babojubot/process/test-support";
import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { attemptAll } from "@babojubot/contracts";
import { psField } from "@babojubot/process";
import { openLifelines, type Lifelines } from "@babojubot/process/lifelines";
import {
  killUnlessGone,
  lifelineHolder,
} from "@babojubot/process/test-cleanup";
import { exited, readyLine } from "@babojubot/process/testing";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 환경을 읽을 수 없게 막은 프로그램(gpg-agent·ssh-agent처럼 PR_SET_DUMPABLE 0)은 표식을 확인할 수 없다(#219, PR #220 외부 리뷰 SPEC-2).
// 실행 시도의 트리 밖에서 생긴 그런 프로그램은 끄지 않고, 실행 시도는 복구 기록을 남긴다. 트리가 남긴 것은 감독 실행기가 끈다(#274). 표식 조회가 그런 프로그램을 "확인하지 못함"으로 두는지는
// @babojubot/process의 lease-hidden.alone.test.ts가 본다. 이 시험이 띄운 프로그램은 같은 시각의 다른 시험 실행 시도에도 그렇게
// 보이므로, 이 파일은 다른 시험과 겹치지 않게 따로 돈다.
/** 실행 시도가 남겼다고 알린 프로그램: 번호와 알린 때 본 시작 시각(`ps`의 lstart). */
type Reported = { pid: number; start: string | undefined };
const reported: Reported[] = [];
/**
 * 알린 프로그램이 끝났는가. 그 번호의 시작 시각이 알린 때와 다르거나 없으면 그 번호는 이제 그 프로그램이 아니다(끝났다). 같으면
 * 그 프로그램이라 그 상태(거두어지기 전의 좀비 포함)를 본다. 환경을 숨긴 Python 프로그램은 시험의 연결을 쥘 수 없어(연결 규약을
 * Python으로 다시 써야 한다) 정리와 같은 신원(시작 시각)으로 판정한다.
 */
const ended = ({ pid, start }: Reported) => {
  if (start === undefined) return true;
  return psField(pid, "lstart", 10_000) !== start || exited(pid);
};
// 띄운 트리는 모두 공용 실행 경계 대역(`owningLaunchTree`)이 띄운 직후 그 실제 끄기를 폴더 정리에 맡긴다.
vi.mock("@babojubot/process", async (original) =>
  (await import("./test-folders.ts")).owningLaunchTree(await original())
);
const folders = testFolders();
let lifelines: Lifelines;
beforeAll(async () => {
  lifelines = await openLifelines();
});
afterAll(() => lifelines.close());
afterEach(async () => {
  vi.restoreAllMocks();
  // 시험이 끄지 못한 것은 알린 때와 같은 시작 시각을 본 직후(사이에 기다림 없이)에만 그 번호로 끈다. 시작 시각이 다르거나 없으면
  // 그 번호는 이미 그 프로그램이 아니다(끝난 번호는 다른 프로그램에 다시 쓰일 수 있다).
  await attemptAll(
    reported.splice(0).map(({ pid, start }) => async () => {
      if (start === undefined || psField(pid, "lstart", 10_000) !== start)
        return;
      killUnlessGone(pid);
      // 끝은 같은 신원으로 본다: 그 번호의 시작 시각이 바뀌거나 없어지거나, 그 프로그램이 끝난(좀비 포함) 때다.
      await expect
        .poll(() => ended({ pid, start }), {
          timeout: 10_000,
          interval: 25,
          message: `hidden program ${pid} did not end after SIGKILL`,
        })
        .toBe(true);
    })
  );
});

const hide =
  'import ctypes, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print("ready", flush=True); time.sleep(60)';

describe.runIf(process.platform === "linux")(
  "programs that hide their environment",
  () => {
    // 실행 시도가 새 세션에 남긴 것은 대표가 죽으면 감독 실행기가 맡은 고아다(#274). 표식을 볼 수 없어도 실행기의 자식이라 우리
    // 것이 확실하므로, 실행 시도의 끄기가 그것까지 끄고 기록을 지운다. 전에는 표식 정리만 닿아 "확인하지 못함"으로 남겼다(이 시험의
    // 옛 기대). 실행기가 끄는 것이 근본 수단이 되어 기대를 바꿨다.
    it("are ended with the run when the run left them", async () => {
      const stateDir = await folders.make("babojubot-hidden-");
      let left: Reported | undefined;
      const run = folders.ownRun(
        startProcess({
          command: [
            process.execPath,
            "-e",
            `
const { spawn } = require("node:child_process");
const hidden = spawn("python3", ["-c", ${JSON.stringify(hide)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
hidden.stdout.once("data", () => {
  console.log(JSON.stringify({ hidden: hidden.pid }));
  process.stdin.once("data", () => process.kill(process.pid, "SIGKILL"));
});
setInterval(() => {}, 1000);
`,
          ],
          args: [],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH },
          stateDir,
          // 대표는 시험이 남긴 것의 시작 시각을 읽은 뒤에야 끝난다(입력의 진행 신호). 대표가 먼저 끝나면 감독 실행기가 남긴 것을
          // 그 전에 끌 수 있어, 시작 시각을 읽지 못한 채 시험이 실패했다.
          onFrame: async (frame) => {
            const pid = (frame as { hidden: number }).hidden;
            left = { pid, start: psField(pid, "lstart", 10_000) };
            reported.push(left);
            run.write({ go: true });
          },
        })
      );
      const exit = await within(run.done, 30_000, "the run did not finish");
      // 프로그램이 번호를 알리기 전에 끝났으면 여기서 실패한다. 알린 때 살아 있어 시작 시각이 있어야 한다.
      if (left?.start === undefined)
        throw new Error("the run did not report a running hidden program");
      expect(exit.broken).toBe(false);
      expect(await readdir(path.join(stateDir, "processes"))).toHaveLength(0);
      expect(ended(left)).toBe(true);
    });

    // 실행 시도 중 서버와 같은 cgroup에 생겼지만 실행 시도의 트리 밖인 프로그램은 표식 정리만 본다. 환경을 숨겼으면 우리 것인지
    // 확인하지 못하므로 끄지 않고, 정리 성공으로 보지 않는다(경고, 기록 유지).
    it("keep the run's record and are left running when they are not of its tree", async () => {
      const stateDir = await folders.make("babojubot-hidden-");
      // 대표는 연결을 쥐고 돈다. 실행 시도의 끝(`broken`)은 대표의 끝을 말하지 않으므로, 대표의 끝은 이 연결의 정리가 확인한다.
      // 대표는 연결을 쥔 뒤에야 돌기 시작했다고 알린다. 그래서 시험이 진행시킨 대표가 연결 전에 끝나지 않는다.
      const leader = lifelineHolder(
        lifelines,
        "hidden-test-leader",
        path.join(await folders.make("babojubot-hidden-leader-"), "pid"),
        "console.log(JSON.stringify({ started: true }));"
      );
      folders.own(leader.end, "the run's leader");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let hidden: ChildProcess | undefined;
      // 이 실행 시도는 트리 밖의 프로그램을 확인하지 못해 그 끝이 `broken`이다. 그래서 `ownBrokenRun`에 맡긴다. 실제 끄기는 남은
      // 프로그램이 있다고 답한다(`TREE_LEFT`, 실행기가 끝난 뒤의 답). 이 장면은 그 코드 하나만 받고, 그 밖의 실패(실행기의 끝을 확인하지
      // 못함 등)는 정리 실패다. 프로그램의 끝은 따로 맡긴 것의 정리가 확인한다: 대표는 그 연결(`leader`), 시험이 띄운 프로그램은 그
      // 자식(`ownChild`).
      const run = folders.treeScene({ expectStop: "TREE_LEFT" }, () =>
        folders.ownBrokenRun(
          startProcess({
            command: [
              process.execPath,
              "-e",
              `
${leader.code}
process.stdin.once("data", () => process.exit(0));
setInterval(() => {}, 1000);
`,
            ],
            args: [],
            cwd: process.cwd(),
            env: { PATH: process.env.PATH },
            stateDir,
            onFrame: async () => {
              // 대표가 돌기 시작한 뒤, 이 시험(서버 쪽)이 환경을 숨긴 프로그램을 띄우고 준비를 기다린 다음 입력의 진행 신호로 대표를 끝낸다.
              // 시험이 띄운 프로그램이라 시험이 끈다(정리가 끝과 출력 닫힘까지 확인한다).
              hidden = folders.ownChild(
                spawn("python3", ["-c", hide], {
                  detached: true,
                  stdio: ["ignore", "pipe", "ignore"],
                })
              );
              await readyLine(hidden, "ready");
              run.write({ go: true });
            },
          })
        )
      );
      const exit = await within(run.done, 30_000, "the run did not finish");
      if (hidden?.pid === undefined)
        throw new Error("the hidden program did not start");
      expect(exit.broken).toBe(true);
      expect(await readdir(path.join(stateDir, "processes"))).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("could not all be stopped")
      );
      // Node가 끝을 보지 않은 자식이라 그 번호는 아직 그 프로그램이다.
      expect(hidden.exitCode).toBeNull();
      expect(hidden.signalCode).toBeNull();
      expect(exited(hidden.pid)).toBe(false);
    });
  }
);
