import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leaseHolders, leaseVariable, processStartTicks } from "./lease.ts";
import { startProcess } from "./process.ts";
import { killAndWait, readyLine } from "./process-test-support.ts";

// 환경을 읽을 수 없게 막은 프로그램(gpg-agent·ssh-agent처럼 PR_SET_DUMPABLE 0)은 표식을 확인할 수 없다(#219, PR #220 외부 리뷰 SPEC-2).
// 이 실행 시도가 시작한 뒤 서버와 같은 cgroup에 생긴 같은 사용자의 산 프로그램이면 우리 것일 수 있어 "확인하지 못함"으로 둔다.
// 이 시험이 띄운 프로그램은 같은 시각의 다른 시험 실행 시도에도 그렇게 보이므로, 이 파일은 다른 시험과 겹치지 않게 따로 돈다.
const pids: number[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await killAndWait(pids.splice(0));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
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
// 다른 cgroup에 띄울 수 있는가(systemd 사용자 관리자가 있는 Linux). 없으면 그 시험만 건너뛴다.
const scopes =
  process.platform === "linux" &&
  spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"], {
    stdio: "ignore",
  }).status === 0;

describe.runIf(process.platform === "linux")(
  "programs that hide their environment",
  () => {
    it("are unverified only when they started during the run", async () => {
      const lease = randomUUID();
      const since = processStartTicks(process.pid)!;
      const pid = await hidden(lease);
      const during = await leaseHolders(lease, { since });
      expect(during.holders).not.toContain(pid);
      expect(during.unverified).toContain(pid);
      // 실행 시도보다 먼저 있던 프로그램은 그 자손일 수 없다.
      const later = await leaseHolders(lease, {
        since: processStartTicks(pid)! + 1,
      });
      expect(later.unverified).not.toContain(pid);
    });

    // 실행 시도의 자손은 서버의 cgroup을 물려받는다. 다른 cgroup(데스크톱 앱·systemd 서비스)의 프로그램은 우리 것이 아니다.
    it.runIf(scopes)(
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
        expect((await leaseHolders(lease, { since })).unverified).not.toContain(
          pid
        );
      }
    );

    // 프로그램이 남긴 것 가운데 확인하지 못한 것이 있으면 끄지 않고, 정리 성공으로 보지 않는다(경고, 기록 유지).
    it("keep the run's record and are left running", async () => {
      const stateDir = await mkdtemp(path.join(tmpdir(), "babojubot-hidden-"));
      roots.push(stateDir);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
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
      expect(exit.broken).toBe(true);
      expect(await readdir(path.join(stateDir, "processes"))).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("could not all be stopped")
      );
      expect(() => process.kill(pid!, 0)).not.toThrow();
    });
  }
);
