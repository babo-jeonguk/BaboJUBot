import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcess } from "./process.ts";
import { exited, killAndWait, untilExited } from "./process-test-support.ts";

// Claude Code·Codex·Antigravity는 셸 명령을 새 세션에 띄운다. 프로그램이 어떻게 끝나든, 실행 시도의 정리가 끝나면(`done`)
// 그 명령과 명령이 띄운 프로그램도 꺼져 있어야 한다. 프로세스 그룹 밖이므로 표식으로 찾는다(#219).
const pids: number[] = [];
const runs: ReturnType<typeof startProcess>[] = [];
const roots: string[] = [];
// 단언이 실패해도 시작한 실행 시도는 끝내고 정리를 기다린다. 남은 번호는 그 뒤에 끄고 끝날 때까지 기다린다.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of runs.splice(0)) {
    run.end();
    await run.done;
  }
  await killAndWait(pids.splice(0));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const alive = (pid: number) => !exited(pid);

// 꺼짐은 잠깐 기다려 확인한다(수정 전에는 계속 살아 있어 실패한다).
const stopped = (...targets: number[]) => untilExited(targets, 2000);

const keep = "setInterval(() => {}, 1000)";
/** 새 세션의 자식을 띄우고, 그 자식이 다시 새 세션의 손자를 띄운다. 둘의 번호를 프레임으로 알린 뒤 `then`을 한다. */
const leaving = (then: string) => `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
  const { spawn } = require("node:child_process");
  const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(keep)}], { detached: true, stdio: "ignore" });
  console.log(grandchild.pid);
  ${keep};
`)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", (data) => {
  console.log(JSON.stringify({ child: child.pid, grandchild: Number(String(data).trim()) }));
  ${then};
});
${keep};
`;

function start(then: string, stateDir?: string) {
  return startScript(leaving(then), stateDir);
}
function startScript(script: string, stateDir?: string) {
  let report!: (frame: { child: number; grandchild: number }) => void;
  let reportEnd!: (error: Error) => void;
  const left = new Promise<{ child: number; grandchild: number }>(
    (resolve, reject) => {
      report = resolve;
      reportEnd = reject;
    }
  );
  const run = startProcess({
    command: [process.execPath, "-e", script],
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    ...(stateDir ? { stateDir } : {}),
    onFrame: async (frame) => {
      const found = frame as { child: number; grandchild: number };
      pids.push(found.child, found.grandchild);
      report(found);
    },
  });
  runs.push(run);
  // 번호를 알리기 전에 프로그램이 끝나면 기다리지 않고 실패한다.
  void run.exited.then(() => reportEnd(new Error("exited before reporting")));
  return { run, left };
}

describe.skipIf(process.platform === "win32")(
  "programs a run leaves in another session",
  () => {
    it("are stopped when the program is killed outright", async () => {
      const { run, left } = start(`process.kill(process.pid, "SIGKILL")`);
      const { child, grandchild } = await left;
      const exit = await run.done;
      expect(exit.broken).toBe(false);
      await stopped(child, grandchild);
    });

    it("are stopped when the program exits on its own", async () => {
      const { run, left } = start(`process.exit(0)`);
      const { child, grandchild } = await left;
      const exit = await run.done;
      expect(exit.code).toBe(0);
      await stopped(child, grandchild);
    });

    it("are stopped when the run is cancelled", async () => {
      const { run, left } = start("");
      const { child, grandchild } = await left;
      run.end();
      await run.done;
      await stopped(child, grandchild);
    });

    it("leave another run's programs, unrelated programs and the server alone", async () => {
      const other = start("");
      const theirs = await other.left;
      const unrelated = spawn(process.execPath, ["-e", keep], {
        detached: true,
        stdio: "ignore",
      });
      pids.push(unrelated.pid!);
      const { run, left } = start(`process.kill(process.pid, "SIGKILL")`);
      const ours = await left;
      await run.done;
      await stopped(ours.child, ours.grandchild);
      expect(alive(theirs.child)).toBe(true);
      expect(alive(theirs.grandchild)).toBe(true);
      expect(alive(unrelated.pid!)).toBe(true);
      expect(alive(process.pid)).toBe(true);
      other.run.end();
      await other.run.done;
      await stopped(theirs.child, theirs.grandchild);
    });

    // 환경을 읽을 수 없게 막은 프로그램(gpg-agent·ssh-agent처럼 PR_SET_DUMPABLE 0)은 표식을 확인할 수 없다.
    // 실행 시도 중에 생겼으면 우리 것일 수 있으므로 끄지 않고, 정리 성공으로 보지 않는다(경고, 기록 유지).
    it.runIf(process.platform === "linux")(
      "do not count as stopped when one hides its environment",
      async () => {
        const stateDir = await mkdtemp(
          path.join(tmpdir(), "babojubot-hidden-")
        );
        roots.push(stateDir);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const python = JSON.stringify(
          'import ctypes, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); print("ready", flush=True); time.sleep(60)'
        );
        const { run, left } = startScript(
          `
const { spawn } = require("node:child_process");
const hidden = spawn("python3", ["-c", ${python}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
hidden.stdout.once("data", () => {
  console.log(JSON.stringify({ child: hidden.pid, grandchild: hidden.pid }));
  process.kill(process.pid, "SIGKILL");
});
setInterval(() => {}, 1000);
`,
          stateDir
        );
        const { child: hidden } = await left;
        const exit = await run.done;
        expect(exit.broken).toBe(true);
        expect(await readdir(path.join(stateDir, "processes"))).toHaveLength(1);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining("could not all be stopped")
        );
        expect(alive(hidden)).toBe(true);
      }
    );
  }
);
