import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leaseVariable, processStartTicks } from "./lease.ts";
import { exited, killAndWait, readyLine } from "./process-test-support.ts";
import { cleanThroughSupervisor } from "./supervisor.ts";
import { commandFailure, probeEnvironment } from "./test-support.ts";

// 환경을 읽을 수 없게 막은 프로그램(gpg-agent·ssh-agent처럼 PR_SET_DUMPABLE 0)은 표식을 확인할 수 없다(#219, PR #220 외부 리뷰 SPEC-2).
// 이 실행 시도가 시작한 뒤 실행기와 같은 cgroup에 생긴 같은 사용자의 산 프로그램이면 우리 것일 수 있어, 감독 실행기는 신호하지 않고
// "확인하지 못함"으로 답한다(#268 PR 2). 여기서는 재시작 복구의 정리(`cleanThroughSupervisor`)로 본다.
// 이 시험이 띄운 프로그램은 같은 시각의 다른 시험 실행 시도에도 그렇게 보이므로, 이 파일은 다른 시험과 겹치지 않게 따로 돈다.
const pids: number[] = [];
afterEach(async () => {
  await killAndWait(pids.splice(0));
});

const hide =
  'import ctypes, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print("ready", flush=True); time.sleep(60)';
async function hidden(lease: string, prefix: string[] = []) {
  const [command, ...args] = [...prefix, "python3", "-c", hide];
  const child = spawn(command!, args, {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, [leaseVariable]: lease },
  });
  pids.push(child.pid!);
  await readyLine(child);
  return child.pid!;
}
// 다른 cgroup에 띄울 수 있는가(systemd 사용자 관리자가 있는 Linux). 로컬에서 없으면 그 시험만 건너뛴다. Linux CI는
// BABOJUBOT_REQUIRE_SYSTEMD_SCOPE=1로 필수로 정하며, 그때 띄울 수 없으면 원인과 함께 실패한다.
const scopes = probeEnvironment({
  variable: "BABOJUBOT_REQUIRE_SYSTEMD_SCOPE",
  what: "systemd 사용자 scope",
  ...(process.platform !== "linux" && {
    unsupported: `${process.platform}에는 systemd가 없다`,
  }),
  probe: () => {
    const missing = commandFailure("systemd-run", [
      "--user",
      "--scope",
      "--quiet",
      "true",
    ]);
    return missing === undefined ? { value: true } : { missing };
  },
});

describe.runIf(process.platform === "linux")(
  "programs that hide their environment",
  () => {
    it("are unverified only when they started during the run", async () => {
      const lease = randomUUID();
      const since = processStartTicks(process.pid)!;
      const pid = await hidden(lease);
      await expect(cleanThroughSupervisor(lease, { since })).rejects.toThrow(
        new RegExp(`could not be checked.*\\b${pid}\\b`)
      );
      expect(exited(pid)).toBe(false);
      // 실행 시도보다 먼저 있던 프로그램은 그 자손일 수 없다.
      await cleanThroughSupervisor(lease, {
        since: processStartTicks(pid)! + 1,
      });
      expect(exited(pid)).toBe(false);
    });

    // 실행 시도의 자손은 실행기의 cgroup을 물려받는다. 다른 cgroup(데스크톱 앱·systemd 서비스)의 프로그램은 우리 것이 아니다.
    it.runIf(scopes === true)(
      "are not ours when they run in another cgroup",
      async () => {
        const lease = randomUUID();
        const since = processStartTicks(process.pid)!;
        const pid = await hidden(lease, [
          "systemd-run",
          "--user",
          "--scope",
          "--quiet",
        ]);
        await cleanThroughSupervisor(lease, { since });
        expect(exited(pid)).toBe(false);
      }
    );

    // 끝났지만 거두어지지 않은 프로그램(좀비)은 산 것이 아니다. 확인하지 못한 것으로 세지 않는다.
    it("do not count a zombie as unverified", async () => {
      const since = processStartTicks(process.pid)!;
      const parent = spawn(
        "python3",
        [
          "-c",
          "import os, time\npid = os.fork()\nif pid == 0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(60)",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] }
      );
      pids.push(parent.pid!);
      let line = "";
      for await (const chunk of parent.stdout!) {
        line += String(chunk);
        if (line.includes("\n")) break;
      }
      const zombie = Number(line.trim());
      await vi.waitFor(
        () => {
          if (!exited(zombie)) throw new Error("the forked child did not exit");
        },
        { timeout: 5000, interval: 25 }
      );
      await cleanThroughSupervisor(randomUUID(), { since });
    });
  }
);
