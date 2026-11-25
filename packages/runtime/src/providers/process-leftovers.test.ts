import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { within } from "@babojubot/process/test-support";
import { startProcess } from "./process.ts";
import { openLifelines, type Lifelines } from "@babojubot/process/lifelines";
import { lifelineHolder } from "@babojubot/process/test-cleanup";
import { exited } from "@babojubot/process/testing";
import { testFolders } from "./test-folders.ts";

// Claude Code·Codex·Antigravity는 셸 명령을 새 세션에 띄운다. 프로그램이 어떻게 끝나든, 실행 시도의 정리가 끝나면(`done`)
// 그 명령과 명령이 띄운 프로그램도 꺼져 있어야 한다. 프로세스 그룹 밖이므로 표식으로 찾는다(#219).
// 남은 프로그램은 연결을 쥐고 돈다. 꺼짐은 번호가 아니라 연결의 닫힘으로 보고, 시험이 끄지 못한 것은 정리가 연결이 열려 있음을 본
// 직후에만 그 번호로 끈다(`lifelineHolder`). 끝난 번호는 다른 프로그램에 다시 쓰일 수 있다.
let lifelines: Lifelines;
beforeAll(async () => {
  lifelines = await openLifelines();
});
afterAll(() => lifelines.close());
const folders = testFolders();
/** 실행 시도의 끝(`done`)을 상한 안에서 기다린다. */
const finished = (run: ReturnType<typeof startProcess>) =>
  within(run.done, 20_000, "the run did not finish");
/** 그 프로그램이 아직 돈다: 그 프로그램이 쥔 연결 `name`이 열려 있다. 번호는 신호를 보낼 곳으로만 쓴다. */
const running = (name: string) => lifelines.open(name);
/** 연결이 닫혀 프로그램이 끝났음을 상한 안에서 확인한다. */
const stopped = async (...names: string[]) => {
  for (const name of names) await lifelines.closed(name);
};

let count = 0;
const keep = "setInterval(() => {}, 1000)";
/**
 * 새 세션의 자식을 띄우고, 그 자식이 다시 새 세션의 손자를 띄운다. 둘 다 연결(`names`)을 쥐고 돈다. 둘이 연결을 쥔 뒤 둘의 번호를
 * 프레임으로 알리고 `then`을 한다.
 */
async function start(then: string) {
  const folder = await folders.make("babojubot-leftovers-");
  const names = {
    child: `child-${++count}`,
    grandchild: `grandchild-${count}`,
  };
  // 손자는 연결을 쥔 뒤 자식에게 알리고, 자식은 그 뒤 자기 연결을 쥔 다음에 손자의 번호를 알린다. 그래서 번호가 알려지면 둘 다
  // 연결을 쥐고 있다(대표가 그 직후 끝나 실행 시도가 둘을 꺼도 그 끝은 연결 닫힘으로 보인다).
  const grandchild = lifelineHolder(
    lifelines,
    names.grandchild,
    path.join(folder, "grandchild"),
    'console.log("connected");'
  );
  const child = lifelineHolder(
    lifelines,
    names.child,
    path.join(folder, "child"),
    "console.log(grandchild.pid);"
  );
  const program = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
  const { spawn } = require("node:child_process");
  const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(`${grandchild.code} ${keep}`)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  grandchild.stdout.once("data", () => { ${child.code} });
  ${keep};
`)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", (data) => {
  console.log(JSON.stringify({ child: child.pid, grandchild: Number(String(data).trim()) }));
  ${then};
});
${keep};
`;
  let report!: (frame: { child: number; grandchild: number }) => void;
  const reported = new Promise<{ child: number; grandchild: number }>(
    (resolve) => (report = resolve)
  );
  // 정리는 폴더 정리 하나가 맡는다. 실행 시도를 띄운 직후 맡기고, 그 실행 시도가 띄울 자식·손자의 정리를 바로 뒤에 맡긴다. 정리는
  // 늦게 맡긴 것부터 하므로 남은 프로그램을 먼저 끄고(그래서 실행 시도의 정리가 그것에 매이지 않는다), 그 뒤 실행 시도를 끝내고 그
  // 끝을 확인한다(`ownRun`: 끝을 확인하지 못하면 정리 실패). 한 대상이 실패해도 나머지를 하고, 번호를 남긴 폴더는 모두 끝난 뒤에만 지운다.
  const run = folders.ownRun(
    startProcess({
      command: [process.execPath, "-e", program],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      onFrame: async (frame) => {
        report(frame as { child: number; grandchild: number });
      },
    })
  );
  folders.own(child.end, names.child);
  folders.own(grandchild.end, names.grandchild);
  // 번호를 알리기 전에 프로그램이 끝나면 기다리지 않고 실패한다.
  const left = Promise.race([
    reported,
    run.exited.then(() => {
      throw new Error("exited before reporting");
    }),
  ]);
  return { run, left, names };
}

// Windows에는 새 세션(setsid)으로 나가는 명령이 없다. 그곳의 남은 프로그램은 감독 실행기의 묶음으로 띄운 실행 시도 시험(process-windows.test.ts)이 본다.
describe.skipIf(process.platform === "win32")(
  "programs a run leaves in another session",
  () => {
    it("are stopped when the program is killed outright", async () => {
      const { run, left, names } = await start(
        `process.kill(process.pid, "SIGKILL")`
      );
      await left;
      const exit = await finished(run);
      expect(exit.broken).toBe(false);
      await stopped(names.child, names.grandchild);
    });

    it("are stopped when the program exits on its own", async () => {
      const { run, left, names } = await start(`process.exit(0)`);
      await left;
      const exit = await finished(run);
      expect(exit.code).toBe(0);
      await stopped(names.child, names.grandchild);
    });

    it("are stopped when the run is cancelled", async () => {
      const { run, left, names } = await start("");
      await left;
      run.end();
      await finished(run);
      await stopped(names.child, names.grandchild);
    });

    it("leave another run's programs, unrelated programs and the server alone", async () => {
      const other = await start("");
      await other.left;
      const unrelated = folders.ownChild(
        spawn(process.execPath, ["-e", keep], {
          detached: true,
          stdio: "ignore",
        })
      );
      const { run, left, names } = await start(
        `process.kill(process.pid, "SIGKILL")`
      );
      await left;
      await finished(run);
      await stopped(names.child, names.grandchild);
      expect(running(other.names.child)).toBe(true);
      expect(running(other.names.grandchild)).toBe(true);
      // 시험이 띄운 자식은 Node가 끝을 보기 전에는 거두어지지 않아, 그 번호는 아직 그 프로그램이다.
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(exited(unrelated.pid!)).toBe(false);
      expect(exited(process.pid)).toBe(false);
      other.run.end();
      await finished(other.run);
      await stopped(other.names.child, other.names.grandchild);
    });
  }
);
