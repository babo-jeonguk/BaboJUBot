import crossSpawn from "cross-spawn";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { existsSync } from "node:fs";
import { prepareSupervisor, TreeLaunchRefused } from "@babojubot/process";
import { startProcess } from "./process.ts";
import { removeFolder } from "@babojubot/process/remove-folder";
import { within } from "@babojubot/process/test-support";
import { openLifelines, type Lifelines } from "@babojubot/process/lifelines";
import { attemptAll } from "@babojubot/contracts";

// Windows에는 프로세스 그룹이 없다. 실행 시도의 프로그램이 남긴 프로그램을 감독 실행기의 묶음(Job Object)이 끄는지를 startProcess
// 바깥에서 본다(#205, #268).
// 실제 에이전트 프로그램 대신 Node.js 합성 프로그램을 쓴다.
const windows = process.platform === "win32";
const roots: string[] = [];
/** 시험이 연 실행 시도. 끝마다 마저 끝내 묶음을 닫는다. */
const attempts: ReturnType<typeof startProcess>[] = [];
/**
 * 실행 시도의 프로그램과 그 자손이 쥔 연결의 이름. 끝마다 그 연결이 닫혔는지(그 프로세스가 끝났는지) 본다. 번호(pid)로 나중에 다시
 * 보면 그사이 Windows가 그 번호를 다른 프로세스에 다시 줘 "살아 있음"으로 잘못 볼 수 있다(#259).
 */
const descendants: string[] = [];
let lifelines: Lifelines;
let count = 0;
/** 시험마다 겹치지 않는 연결 이름. */
const unique = (label: string) => `${label}-${++count}`;
/** 시험이 직접 띄운 프로그램의 정리. 핸들로 끄고 끝날 때까지 기다린다. */
const spawned: (() => Promise<void>)[] = [];
/** 이 시험 프로세스가 준비한 감독 실행기 파일. 준비를 바꾼 시험은 끝에 이것으로 되돌린다. */
let supervisorFile = "";

const temp = async (name: string) => {
  const root = await mkdtemp(path.join(tmpdir(), name));
  roots.push(root);
  return root;
};
const record = (frame: unknown) => frame as Record<string, unknown>;
/** 묶음 실행기 없이 지금처럼(cross-spawn) 띄운 결과. 인수 전달이 같은지 비교하는 기준이다. */
const direct = (command: string, args: string[], cwd: string) =>
  JSON.parse(
    crossSpawn.sync(command, args, {
      cwd,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    }).stdout as string
  ) as unknown;

/** 시험이 직접 프로그램을 띄운다. 띄우는 순간 오류를 관찰해 시작 실패가 처리되지 않은 오류가 되지 않게 하고, 정리 때 알린다. */
function spawnTracked(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
) {
  const child = spawn(command, args, options);
  /** 이 프로그램의 시작 실패. 정리 때 실패로 알린다. */
  let startFailure: Error | undefined;
  child.on("error", (error) => {
    if (child.pid === undefined) startFailure = error;
  });
  spawned.push(() => stopSpawned(child, startFailure));
  return child;
}
/**
 * 시험이 직접 띄운 프로그램을 끄고 끝날 때까지 기다린다. 끝남은 `exit`로만 인정한다. `error`(끄지 못함)나 시한 초과는 실패다.
 * 시작하지 못한 프로그램은 `exit`가 오지 않고 끌 것도 없으므로 기다리지 않고 그 시작 실패를 알린다.
 */
async function stopSpawned(child: ChildProcess, startFailure?: Error) {
  if (child.pid === undefined)
    throw new Error("a process the test started could not start", {
      cause: startFailure,
    });
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  const sent = child.kill("SIGKILL");
  try {
    await exited;
  } catch (error) {
    throw new Error(
      `process ${child.pid} did not exit${sent ? "" : " (the kill signal was not delivered)"}`,
      { cause: error }
    );
  }
}
/** 실행 시도가 띄운 프로세스가 모두 끝났는지 그 연결로 본다. 시한 안에 닫히지 않은 연결이 있으면 그 이름과 함께 실패한다. */
async function descendantsGone(names: string[]) {
  const results = await Promise.allSettled(
    names.map((name) => lifelines.closed(name))
  );
  const left = names.filter((_, i) => results[i]!.status === "rejected");
  if (left.length)
    throw new Error(
      `processes a run started are still running after 10000 ms: ${left.join(", ")}`
    );
}

/** 합성 프로그램을 실행 시도로 띄운다. `child` 프레임이 오면 그 연결 이름을 남겨 끝에 꺼졌는지 확인한다. */
function run(
  script: string,
  options: {
    command?: [string, ...string[]];
    args?: string[];
    cwd?: string;
  } = {}
) {
  const frames: Record<string, unknown>[] = [];
  let reportChild!: (name: string) => void;
  const child = new Promise<string>((resolve) => {
    reportChild = resolve;
  });
  const attempt = startProcess({
    command: options.command ?? [process.execPath, "-e", script],
    args: options.args ?? [],
    cwd: options.cwd ?? process.cwd(),
    env: { PATH: process.env.PATH },
    onFrame: async (frame) => {
      frames.push(record(frame));
      if (typeof record(frame).child === "string") {
        descendants.push(record(frame).child as string);
        reportChild(record(frame).child as string);
      }
    },
  });
  attempts.push(attempt);
  return { attempt, frames, child };
}

/** 받은 인수를 프레임 하나로 알리는 프로그램(`print.js`)을 둔 폴더. 공백·한글 경로다. */
async function printer(name: string) {
  const root = await temp(`babojubot-job ${name} 한글-`);
  await writeFile(
    path.join(root, "print.js"),
    `console.log(JSON.stringify({ argv: process.argv.slice(2) }));`
  );
  return root;
}
/** 프로그램이 돌았으면 남기는 표시 파일과, 그 파일을 남기는 프로그램. */
async function marker() {
  const file = path.join(await temp("babojubot-job-refused-"), "ran");
  return {
    file,
    script: `require("node:fs").writeFileSync(${JSON.stringify(file)}, "")`,
  };
}
/**
 * 정리 장치를 쓸 수 없으면 실행 시도를 띄우지 않고, 무엇이 없어 준비하지 못했는지 담은 이름 붙은 실패(`TreeLaunchRefused`)로 거절한다
 * (#262 사용자 결정: 묶음 없이 띄우는 길은 없다). 프로그램은 돌지 않는다.
 */
async function expectRefusedRun(reason: RegExp) {
  const ran = await marker();
  let refusal: unknown;
  try {
    run(ran.script);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(TreeLaunchRefused);
  expect(refusal).toMatchObject({ message: expect.stringMatching(reason) });
  expect(existsSync(ran.file)).toBe(false);
}

// 남긴 자식을 띄운다. 자식이 연결을 쥐었다는 답을 받은 뒤에(넷째 핸들로 알림) 그 이름을 알리고 `then`을 한다. stdio는 남긴 자식이
// 프로그램의 출력을 쥐는지 정한다. Windows의 Node.js는 detached가 아닌 자식을 자기가 끝날 때 함께 끄므로(libuv의 job) 프로그램보다
// 오래 남는 자식은 detached로만 만들 수 있다.
const leaveChild = (stdio: string, then: string) => {
  const name = unique("child");
  const child = `${lifelines.hold(name, 'require("node:fs").writeSync(3, "ready\\n");')} setInterval(() => {}, 1000);`;
  return `const c = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: [...${stdio}, "pipe"], detached: true });
   c.stdio[3].once("data", () => { console.log(JSON.stringify({ child: ${JSON.stringify(name)} })); ${then} });`;
};

describe.runIf(windows)("startProcess on Windows", () => {
  beforeAll(async () => {
    lifelines = await openLifelines();
    const supervisor = await prepareSupervisor();
    if (!supervisor.ok) throw new Error(supervisor.reason);
    supervisorFile = supervisor.file;
  }, 180_000);

  // 정리 단계는 앞 단계가 실패해도 모두 돈다. 실패는 모아 마지막에 함께 알린다.
  afterEach(async () => {
    await attemptAll(
      [
        ...spawned.splice(0),
        // 실행 시도를 마저 끝낸다. 실행기가 끝나며 묶음이 닫혀 그 안의 자손도 꺼진다.
        ...attempts.splice(0).map((attempt) => async () => {
          attempt.end();
          await within(attempt.done, 30_000, "the end of a run did not happen");
        }),
        () => descendantsGone(descendants.splice(0)),
      ],
      "the test cleanup failed"
    );
  }, 60_000);

  afterAll(async () => {
    await attemptAll([
      () => lifelines.close(),
      ...roots.map((root) => () => removeFolder(root)),
    ]);
  });

  it("stops a child that holds the output after the program ends, and keeps the last output and exit code", async () => {
    const { attempt, frames, child } = run(
      leaveChild(
        `["ignore", "inherit", "ignore"]`,
        `process.stdout.write(JSON.stringify({ last: "x".repeat(200000) }) + "\\n", () => process.exit(3));`
      )
    );
    const name = await child;
    const exit = await attempt.done;
    expect(exit.code).toBe(3);
    expect(exit.broken).toBe(false);
    expect(frames.at(-1)).toEqual({ last: "x".repeat(200000) });
    await lifelines.closed(name);
  });

  // 남긴 자식은 모두 detached다(leaveChild). 예전의 "detached로 띄운 자식" 시험은 이 시험과 같아져 합쳤다.
  it("stops a child that does not hold the output after the program ends", async () => {
    const { attempt, child } = run(
      leaveChild(`["ignore", "ignore", "ignore"]`, "process.exit(0);")
    );
    const name = await child;
    expect((await attempt.done).code).toBe(0);
    await lifelines.closed(name);
  });

  it("stops the program and what it started when the run is cancelled", async () => {
    // The program ignores the end of its input, so only the tree stop ends it.
    const { attempt, child } = run(
      `${leaveChild(`["ignore", "ignore", "ignore"]`, "")} setInterval(() => {}, 1000);`
    );
    const name = await child;
    attempt.end();
    await attempt.done;
    await lifelines.closed(name);
  }, 30_000);

  it("passes input to the program and keeps its error output without the launcher's status line", async () => {
    const { attempt, frames } = run(
      `process.stderr.write("program error line\\n");
       require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
         console.log(JSON.stringify({ got: JSON.parse(line) }));
         process.exit(0);
       });`
    );
    expect(attempt.write({ hello: "입력" })).toBe(true);
    const exit = await attempt.done;
    expect(exit.code).toBe(0);
    expect(frames).toEqual([{ got: { hello: "입력" } }]);
    expect(exit.stderr).toBe("program error line\n");
  });

  it("leaves other runs and other programs running", async () => {
    const bystanderName = unique("bystander");
    spawnTracked(
      process.execPath,
      ["-e", `${lifelines.hold(bystanderName)} setInterval(() => {}, 1000);`],
      { stdio: "ignore" }
    );
    await lifelines.connected(bystanderName);
    const other = run(
      `${leaveChild(`["ignore", "ignore", "ignore"]`, "")} setInterval(() => {}, 1000);`
    );
    const otherChild = await other.child;
    await lifelines.connected(otherChild);
    const { attempt, child } = run(
      leaveChild(`["ignore", "ignore", "ignore"]`, "process.exit(0);")
    );
    const name = await child;
    await attempt.done;
    await lifelines.closed(name);
    expect(lifelines.open(bystanderName)).toBe(true);
    expect(lifelines.open(otherChild)).toBe(true);
    other.attempt.end();
    await other.attempt.done;
    await lifelines.closed(otherChild);
  }, 30_000);

  it("passes arguments through a .cmd program as they are", async () => {
    const root = await printer("cmd");
    await writeFile(
      path.join(root, "print.cmd"),
      `@"${process.execPath}" "%~dp0print.js" %*\r\n`
    );
    const args = [
      "plain",
      "two words",
      'say "hi"',
      "back\\slash\\",
      "& | < > ^ % ! ( ) ;",
      "%PATH%",
      "",
      "한글 인수",
    ];
    const { attempt, frames } = run("", {
      command: [path.join(root, "print.cmd")],
      args,
      cwd: root,
    });
    expect((await attempt.done).code).toBe(0);
    expect(frames).toEqual([direct(path.join(root, "print.cmd"), args, root)]);
  });

  it("passes arguments to a program found on its path as they are", async () => {
    const root = await printer("exe");
    const args = ['say "hi"', "back\\slash\\", 'a\\\\"b', "", "한글 인수"];
    const { attempt, frames } = run("", {
      command: ["node", path.join(root, "print.js")],
      args,
      cwd: root,
    });
    expect((await attempt.done).code).toBe(0);
    expect(frames).toEqual([{ argv: args }]);
    expect(frames).toEqual([
      direct("node", [path.join(root, "print.js"), ...args], root),
    ]);
  });

  // 서버가 강제로 끝나면 Node.js가 자식(감독 실행기)을 끄고, 그 묶음이 닫혀 실행 시도의 프로그램이 모두 꺼진다.
  it("stops the run's programs when the server is killed", async () => {
    const root = await temp("babojubot-job-server-");
    const programName = unique("program");
    const url = (file: string) => new URL(`./${file}`, import.meta.url).href;
    await writeFile(
      path.join(root, "server.mjs"),
      `import { prepareSupervisor } from ${JSON.stringify(import.meta.resolve("@babojubot/process"))};
       import { startProcess } from ${JSON.stringify(url("process.ts"))};
       const supervisor = await prepareSupervisor();
       if (!supervisor.ok) throw new Error(supervisor.reason);
       const program = ${JSON.stringify(
         `${lifelines.hold(programName, `console.log(JSON.stringify({ program: ${JSON.stringify(programName)} }));`)} ${leaveChild(`["ignore", "ignore", "ignore"]`, "")} setInterval(() => {}, 1000);`
       )};
       startProcess({
         command: [process.execPath, "-e", program],
         args: [],
         cwd: process.cwd(),
         env: { PATH: process.env.PATH },
         onFrame: async (frame) => console.log(JSON.stringify(frame)),
       });`
    );
    const server = spawnTracked(
      process.execPath,
      [path.join(root, "server.mjs")],
      {
        stdio: ["ignore", "pipe", "inherit"],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      }
    );
    const seen: Record<string, string> = {};
    await new Promise<void>((resolve, reject) => {
      let text = "";
      server.on("error", reject);
      server.on("exit", () => reject(new Error("the server ended early")));
      server.stdout!.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        for (const line of text.split("\n").slice(0, -1))
          Object.assign(seen, JSON.parse(line));
        text = text.slice(text.lastIndexOf("\n") + 1);
        if (seen.child && seen.program) resolve();
      });
    });
    descendants.push(seen.child!, seen.program!);
    const ended = new Promise((resolve) => server.on("exit", resolve));
    server.kill("SIGKILL");
    await ended;
    await lifelines.closed(seen.program!);
    await lifelines.closed(seen.child!);
  }, 60_000);

  // 프로그램을 찾지 못하면 지금처럼 시작 실패로 알린다. 실행기의 cmd.exe 경유로 바뀌어 종료 코드 1로 끝나지 않는다.
  it("reports a program that is not found as a start failure", async () => {
    const { attempt } = run("", { command: ["babojubot-no-such-program"] });
    expect((await attempt.done).broken).toBe(true);
  });

  // 준비한 뒤 실행기 파일이 사라졌다(백신 등). 실행기 없이 대신 띄우지 않고 시작 실패로 끝난다.
  it("fails to start, without running the program, when the supervisor cannot start", async () => {
    const copy = path.join(await temp("babojubot-job-gone-"), "supervisor.exe");
    await copyFile(supervisorFile, copy);
    onTestFinished(async () => {
      expect(await prepareSupervisor({ file: supervisorFile })).toMatchObject({
        ok: true,
      });
    });
    expect(await prepareSupervisor({ file: copy })).toMatchObject({ ok: true });
    await rm(copy, { force: true });
    const ran = await marker();
    const { attempt, frames } = run(ran.script);
    expect((await attempt.done).broken).toBe(true);
    expect(frames).toEqual([]);
    expect(existsSync(ran.file)).toBe(false);
  });

  it("refuses the run and names what was missing when the supervisor could not be prepared", async () => {
    const missing = path.join(await temp("babojubot-job-none-"), "missing.exe");
    onTestFinished(async () => {
      expect(await prepareSupervisor({ file: supervisorFile })).toMatchObject({
        ok: true,
      });
    });
    expect(await prepareSupervisor({ file: missing })).toMatchObject({
      ok: false,
    });
    await expectRefusedRun(/the supervisor program was not found/);
  });
});
