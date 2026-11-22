import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exited, killAndWait, readyLine } from "@babojubot/process/testing";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 환경을 읽을 수 없게 막은 프로그램(gpg-agent·ssh-agent처럼 PR_SET_DUMPABLE 0)은 표식을 확인할 수 없다(#219, PR #220 외부 리뷰 SPEC-2).
// 실행 시도의 트리 밖에서 생긴 그런 프로그램은 끄지 않고, 실행 시도는 복구 기록을 남긴다. 트리가 남긴 것은 감독 실행기가 끈다(#274). 표식 조회가 그런 프로그램을 "확인하지 못함"으로 두는지는
// @babojubot/process의 lease-hidden.alone.test.ts가 본다. 이 시험이 띄운 프로그램은 같은 시각의 다른 시험 실행 시도에도 그렇게
// 보이므로, 이 파일은 다른 시험과 겹치지 않게 따로 돈다.
const pids: number[] = [];
const folders = testFolders();
afterEach(async () => {
  vi.restoreAllMocks();
  await killAndWait(pids.splice(0));
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
      let pid: number | undefined;
      const run = startProcess({
        command: [
          process.execPath,
          "-e",
          `
const { spawn } = require("node:child_process");
const hidden = spawn("python3", ["-c", ${JSON.stringify(hide)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
hidden.stdout.once("data", () => {
  console.log(JSON.stringify({ hidden: hidden.pid }));
  process.kill(process.pid, "SIGKILL");
});
setInterval(() => {}, 1000);
`,
        ],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stateDir,
        onFrame: async (frame) => {
          pid = (frame as { hidden: number }).hidden;
          pids.push(pid);
        },
      });
      const exit = await run.done;
      // 프로그램이 번호를 알리기 전에 끝났으면 여기서 실패한다.
      expect(pid).toBeDefined();
      expect(exit.broken).toBe(false);
      expect(await readdir(path.join(stateDir, "processes"))).toHaveLength(0);
      expect(exited(pid!)).toBe(true);
    });

    // 실행 시도 중 서버와 같은 cgroup에 생겼지만 실행 시도의 트리 밖인 프로그램은 표식 정리만 본다. 환경을 숨겼으면 우리 것인지
    // 확인하지 못하므로 끄지 않고, 정리 성공으로 보지 않는다(경고, 기록 유지).
    it("keep the run's record and are left running when they are not of its tree", async () => {
      const stateDir = await folders.make("babojubot-hidden-");
      const go = path.join(stateDir, "go");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let pid: number | undefined;
      const run = startProcess({
        command: [
          process.execPath,
          "-e",
          `
console.log(JSON.stringify({ started: true }));
setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(go)})) process.exit(0); }, 20);
`,
        ],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stateDir,
        onFrame: async () => {
          // 대표가 돌기 시작한 뒤, 이 시험(서버 쪽)이 환경을 숨긴 프로그램을 띄우고 준비를 기다린 다음 대표를 끝낸다.
          const hidden = spawn("python3", ["-c", hide], {
            detached: true,
            stdio: ["ignore", "pipe", "ignore"],
          });
          pid = hidden.pid;
          if (pid !== undefined) pids.push(pid);
          await readyLine(hidden, "ready");
          await writeFile(go, "");
        },
      });
      const exit = await run.done;
      expect(pid).toBeDefined();
      expect(exit.broken).toBe(true);
      expect(await readdir(path.join(stateDir, "processes"))).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("could not all be stopped")
      );
      expect(() => process.kill(pid!, 0)).not.toThrow();
    });
  }
);
