import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startProcess } from "./process.ts";
import { exited, killAndWait, untilExited } from "./process-test-support.ts";
import { attemptAll } from "@babojubot/contracts";

// Claude Code·Codex·Antigravity는 셸 명령을 새 세션에 띄운다. 프로그램이 어떻게 끝나든, 실행 시도의 정리가 끝나면(`done`)
// 그 명령과 명령이 띄운 프로그램도 꺼져 있어야 한다. 프로세스 그룹 밖이므로 표식으로 찾는다(#219).
const pids: number[] = [];
const runs: ReturnType<typeof startProcess>[] = [];
// 단언이 실패해도 시작한 실행 시도를 모두 끝내고, 남은 번호를 끄고, 실행 시도마다 정리를 기다린다. 서로 무관한 단계라 앞
// 단계가 실패해도 나머지를 하고 실패를 모아 알린다. 남은 프로그램을 먼저 꺼서 실행 시도의 정리가 그것에 매이지 않는다.
afterEach(async () => {
  const ended = runs.splice(0);
  await attemptAll([
    ...ended.map((run) => () => run.end()),
    () => killAndWait(pids.splice(0)),
    ...ended.map((run) => () => run.done),
  ]);
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

function start(then: string) {
  let report!: (frame: { child: number; grandchild: number }) => void;
  const reported = new Promise<{ child: number; grandchild: number }>(
    (resolve) => (report = resolve)
  );
  const run = startProcess({
    command: [process.execPath, "-e", leaving(then)],
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    onFrame: async (frame) => {
      const found = frame as { child: number; grandchild: number };
      pids.push(found.child, found.grandchild);
      report(found);
    },
  });
  runs.push(run);
  // 번호를 알리기 전에 프로그램이 끝나면 기다리지 않고 실패한다.
  const left = Promise.race([
    reported,
    run.exited.then(() => {
      throw new Error("exited before reporting");
    }),
  ]);
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
  }
);
