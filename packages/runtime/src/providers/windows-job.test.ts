import crossSpawn from "cross-spawn";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startProcess } from "./process.ts";
import { prepareWindowsJobRunner } from "./windows-job.ts";

// Windows에는 프로세스 그룹이 없다. 실행 시도의 프로그램이 남긴 프로그램을 묶음 실행기가 끄는지를 startProcess 바깥에서 본다(#205).
// 실제 에이전트 프로그램 대신 Node.js 합성 프로그램을 쓴다.
const windows = process.platform === "win32";
const roots: string[] = [];
const leftovers: number[] = [];
let dataDir = "";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
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

/** 합성 프로그램을 실행 시도로 띄운다. `child` 프레임이 오면 그 번호를 남겨 끝에 정리한다. */
function run(
  script: string,
  options: {
    command?: [string, ...string[]];
    args?: string[];
    cwd?: string;
  } = {}
) {
  const frames: Record<string, unknown>[] = [];
  let reportChild!: (pid: number) => void;
  const child = new Promise<number>((resolve) => {
    reportChild = resolve;
  });
  const attempt = startProcess({
    command: options.command ?? [process.execPath, "-e", script],
    args: options.args ?? [],
    cwd: options.cwd ?? process.cwd(),
    env: { PATH: process.env.PATH },
    onFrame: async (frame) => {
      frames.push(record(frame));
      if (typeof record(frame).child === "number") {
        leftovers.push(record(frame).child as number);
        reportChild(record(frame).child as number);
      }
    },
  });
  return { attempt, frames, child };
}

// 남긴 자식을 띄워 그 번호를 알린다. stdio는 남긴 자식이 프로그램의 출력을 쥐는지 정한다.
const leaveChild = (stdio: string, extra = "") =>
  `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ${stdio}${extra} });
   console.log(JSON.stringify({ child: c.pid }));`;

describe.runIf(windows)("startProcess on Windows", () => {
  beforeAll(async () => {
    dataDir = await temp("babojubot-job-");
    // 구현 첫 단계의 확인: 이 컴퓨터의 기본 .NET Framework C# 컴파일러로 실행기를 만들고 해가 없는 실행이 된다.
    const started = Date.now();
    const runner = await prepareWindowsJobRunner(dataDir);
    console.log(
      `[windows-job] prepared in ${Date.now() - started} ms: ${JSON.stringify(runner)}`
    );
    expect(runner).toMatchObject({ ok: true });
  }, 180_000);

  afterAll(async () => {
    for (const pid of leftovers) if (alive(pid)) process.kill(pid, "SIGKILL");
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("stops a child that holds the output after the program ends, and keeps the last output and exit code", async () => {
    const { attempt, frames, child } = run(
      `${leaveChild(`["ignore", "inherit", "ignore"]`)}
       process.stdout.write(JSON.stringify({ last: "x".repeat(200000) }) + "\\n", () => process.exit(3));`
    );
    const pid = await child;
    const exit = await attempt.done;
    expect(exit.code).toBe(3);
    expect(exit.broken).toBe(false);
    expect(frames.at(-1)).toEqual({ last: "x".repeat(200000) });
    expect(alive(pid)).toBe(false);
  });

  it("stops a child that does not hold the output after the program ends", async () => {
    const { attempt, child } = run(
      `${leaveChild(`"ignore"`)} setTimeout(() => process.exit(0), 100);`
    );
    const pid = await child;
    expect((await attempt.done).code).toBe(0);
    expect(alive(pid)).toBe(false);
  });

  it("stops a child that the program started detached", async () => {
    const { attempt, child } = run(
      `${leaveChild(`"ignore"`, ", detached: true")} setTimeout(() => process.exit(0), 100);`
    );
    const pid = await child;
    await attempt.done;
    expect(alive(pid)).toBe(false);
  });

  it("stops the program and what it started when the run is cancelled", async () => {
    // The program ignores the end of its input, so only the tree stop ends it.
    const { attempt, child } = run(
      `${leaveChild(`"ignore"`)} setInterval(() => {}, 1000);`
    );
    const pid = await child;
    attempt.end();
    await attempt.done;
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("leaves other runs and other programs running", async () => {
    const bystander = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      }
    );
    leftovers.push(bystander.pid!);
    const other = run(`${leaveChild(`"ignore"`)} setInterval(() => {}, 1000);`);
    const otherChild = await other.child;
    const { attempt, child } = run(
      `${leaveChild(`"ignore"`)} setTimeout(() => process.exit(0), 100);`
    );
    const pid = await child;
    await attempt.done;
    expect(alive(pid)).toBe(false);
    expect(alive(bystander.pid!)).toBe(true);
    expect(alive(otherChild)).toBe(true);
    other.attempt.end();
    await other.attempt.done;
    expect(alive(otherChild)).toBe(false);
  }, 30_000);

  it("passes arguments through a .cmd program as they are", async () => {
    const root = await temp("babojubot-job cmd 한글-");
    await writeFile(
      path.join(root, "print.js"),
      `console.log(JSON.stringify({ argv: process.argv.slice(2) }));`
    );
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
    const root = await temp("babojubot-job exe 한글-");
    await writeFile(
      path.join(root, "print.js"),
      `console.log(JSON.stringify({ argv: process.argv.slice(2) }));`
    );
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

  // 서버가 강제로 끝나면 Node.js가 자식(묶음 실행기)을 끄고, 그 묶음이 닫혀 실행 시도의 프로그램이 모두 꺼진다.
  it("stops the run's programs when the server is killed", async () => {
    const root = await temp("babojubot-job-server-");
    const url = (file: string) => new URL(`./${file}`, import.meta.url).href;
    await writeFile(
      path.join(root, "server.mjs"),
      `import { prepareWindowsJobRunner } from ${JSON.stringify(url("windows-job.ts"))};
       import { startProcess } from ${JSON.stringify(url("process.ts"))};
       await prepareWindowsJobRunner(${JSON.stringify(dataDir)});
       const program = ${JSON.stringify(
         `${leaveChild(`"ignore"`)} console.log(JSON.stringify({ program: process.pid })); setInterval(() => {}, 1000);`
       )};
       startProcess({
         command: [process.execPath, "-e", program],
         args: [],
         cwd: process.cwd(),
         env: { PATH: process.env.PATH },
         onFrame: async (frame) => console.log(JSON.stringify(frame)),
       });`
    );
    const server = spawn(process.execPath, [path.join(root, "server.mjs")], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    leftovers.push(server.pid!);
    const seen: Record<string, number> = {};
    await new Promise<void>((resolve, reject) => {
      let text = "";
      server.on("exit", () => reject(new Error("the server ended early")));
      server.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        for (const line of text.split("\n").slice(0, -1))
          Object.assign(seen, JSON.parse(line));
        text = text.slice(text.lastIndexOf("\n") + 1);
        if (seen.child && seen.program) resolve();
      });
    });
    leftovers.push(seen.child!, seen.program!);
    const ended = new Promise((resolve) => server.on("exit", resolve));
    server.kill("SIGKILL");
    await ended;
    const until = Date.now() + 10_000;
    while ((alive(seen.child!) || alive(seen.program!)) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(seen.program!)).toBe(false);
    expect(alive(seen.child!)).toBe(false);
  }, 60_000);

  it("runs without the runner and warns when the runner cannot start", async () => {
    const tools = path.join(dataDir, "tools");
    for (const file of await readdir(tools))
      await rm(path.join(tools, file), { force: true });
    const warn = vi.spyOn(console, "warn");
    try {
      const { attempt, frames } = run(
        `console.log(JSON.stringify({ ran: true }));`
      );
      expect((await attempt.done).code).toBe(0);
      expect(frames).toEqual([{ ran: true }]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("no Windows job object")
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("runs without the runner and warns when it could not be prepared", async () => {
    const other = await temp("babojubot-job-none-");
    await mkdir(other, { recursive: true });
    const warn = vi.spyOn(console, "warn");
    try {
      expect(
        await prepareWindowsJobRunner(other, {
          compilers: [path.join(other, "missing", "csc.exe")],
        })
      ).toMatchObject({ ok: false });
      const { attempt, frames } = run(
        `console.log(JSON.stringify({ ran: true }));`
      );
      expect((await attempt.done).code).toBe(0);
      expect(frames).toEqual([{ ran: true }]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("no Windows job object")
      );
    } finally {
      warn.mockRestore();
    }
  });
});
