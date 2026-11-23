import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boundChild,
  runCommand,
  type WatchedChild,
} from "./bounded-command.ts";
import { openLifelines, type Lifelines } from "./lifeline-support.ts";
import { testFolders } from "./test-folders.ts";
import { killUnlessGone } from "./test-cleanup.ts";

// 공용 실행 위에 놓을 수 없는 짧은 명령도 시한에 끝을 보장한다(#262). Node.js의 timeout은 신호만 보내고 기다리므로, 신호를 무시하는
// 조회나 출력을 물려받은 자손이 남은 조회에서 끝나지 않았다. 남았는지는 번호가 아니라 그 프로세스가 쥔 연결로 본다(#259).
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
const ignoreTerm = 'process.on("SIGTERM", () => {});';
const node = (script: string, limitMs: number) =>
  runCommand(process.execPath, ["-e", script], {
    limitMs,
    maxOutputBytes: 1024,
  });

describe("runCommand", () => {
  it("returns what the program printed and its exit code", async () => {
    expect(
      await node(
        `process.stdout.write("hello", () => process.exit(3));`,
        10_000
      )
    ).toMatchObject({ code: 3, killed: false, stdout: "hello" });
  });

  it("ends a command that ignores SIGTERM at its limit", async () => {
    const name = unique("stubborn");
    const run = node(`${ignoreTerm} ${lifelines.hold(name)} ${keep}`, 1_000);
    await lifelines.connected(name);
    expect(await run).toMatchObject({ killed: true });
    await lifelines.closed(name);
  });

  // 끝난 프로그램의 출력을 물려받은 자손이 남아도 기다림은 끝난다. 그 자손은 이 실행이 끄지 않으므로(트리 끄기가 아님) 시험이 끈다.
  it("does not wait for output that a child keeps open", async () => {
    const folder = await folders.make("babojubot-bounded-");
    const pidFile = path.join(folder, "child.pid");
    const name = unique("holder");
    // 폴더를 지우기 전에 그 자식을 끄고 끝나기를 기다린다. 연결이 열려 있으면 그 번호의 프로세스는 아직 그 자식이다.
    folders.own(async () => {
      if (lifelines.names().includes(name) && lifelines.open(name))
        killUnlessGone(Number(await readFile(pidFile, "utf8")));
      await lifelines.closed(name);
    }, "the child holding the output");
    const child = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${lifelines.hold(name)} ${keep}`;
    // 자식은 번호를 먼저 남긴 뒤 연결을 쥔다(#286: 연결이 보이면 정리가 그 번호를 읽을 수 있다). 대표는 자식이 번호를 남긴 뒤
    // 끝난다. 자식은 대표의 출력을 물려받아 쥔 채 남는다.
    const result = await node(
      `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: ["ignore", "inherit", "ignore"], detached: true });
       c.unref();
       process.stdout.write("leader");
       const wait = setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(pidFile)})) { clearInterval(wait); process.exit(0); } }, 20);`,
      30_000
    );
    expect(result).toMatchObject({ code: 0, killed: false });
    expect(result.stdout).toContain("leader");
    await lifelines.connected(name);
    expect(lifelines.open(name)).toBe(true);
  });

  it("throws the start error of a missing program", async () => {
    await expect(
      runCommand(path.join(process.cwd(), "no-such-program"), [], {
        limitMs: 10_000,
        maxOutputBytes: 1024,
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("boundChild", () => {
  // SIGKILL로도 끝나지 않는 프로세스(커널 작업에 묶임)는 실제로 만들 수 없어 대역으로 본다. 기다림은 유예 뒤 끝나고 실패한다.
  it("fails when a process does not end after SIGKILL", async () => {
    const signals: string[] = [];
    const stuck = Object.assign(new EventEmitter(), {
      pid: 4242,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        return true;
      },
    }) satisfies WatchedChild;
    await expect(
      boundChild(stuck, { limitMs: 10, graceMs: 50 })
    ).rejects.toThrow("process 4242 did not end within 50 ms after SIGKILL");
    expect(signals).toEqual(["SIGKILL"]);
  });
});
