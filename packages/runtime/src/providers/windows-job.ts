import spawn from "cross-spawn";
import { spawn as spawnChild } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Windows 묶음 실행기(#205). Windows에는 프로세스 그룹이 없어, 프로그램이 먼저 끝나면 남긴 프로그램을 찾을 수 없다.
 * 서버는 시작할 때 저장소의 C# 소스를 Windows에 기본으로 있는 .NET Framework C# 컴파일러로 데이터 폴더에 한 번 만들어 두고
 * (소스 해시로 판단), 실행 시도마다 프로그램을 이 실행기로 띄운다. 실행기는 프로그램을 묶음(Job Object)에 넣어 띄우고,
 * 프로그램이 끝나거나 실행기가 끝나면 묶음 안의 프로그램을 모두 끈다. 준비하지 못하면 실행 시도는 묶음 없이 돌고 경고한다.
 */
const sourceFile = new URL("./windows-job-runner.cs", import.meta.url);
/** 실행기가 표준 오류에 맨 먼저 쓰는 상태 줄의 머리. 프로그램이 돌기 전에 쓴다. */
export const jobStatusPrefix = "[babojubot-job] ";
const compileLimitMs = 120_000;
const trialLimitMs = 15_000;

export type WindowsJobRunner =
  { ok: true; file: string } | { ok: false; reason: string };
let runner: WindowsJobRunner | undefined;

/** Windows 명령줄 한 인수를 MSVCRT 규칙으로 감싼다. Node.js(libuv)가 인수를 넘길 때와 같은 결과로 풀린다. */
export function quoteWindowsArgument(arg: string) {
  if (arg === "") return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let quoted = '"',
    slashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      slashes++;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? slashes * 2 + 1 : slashes) + char;
    slashes = 0;
  }
  return quoted + "\\".repeat(slashes * 2) + '"';
}

/** cross-spawn이 실제로 띄울 프로그램과 명령줄. `.cmd` 시작 파일은 cmd.exe 경유와 그 인수 처리까지 그대로다. */
function resolvedCommand(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string }
) {
  type Parsed = {
    command: string;
    args: string[];
    file?: string;
    options: { windowsVerbatimArguments?: boolean };
  };
  const parse = (spawn as unknown as { _parse: (...a: unknown[]) => Parsed })
    ._parse;
  const parsed = parse(command, args, options);
  const application = parse(parsed.command, [], options).file;
  if (!application) return undefined;
  const verbatim = parsed.options.windowsVerbatimArguments === true;
  return {
    application,
    commandLine: [parsed.command, ...parsed.args]
      .map((arg) => (verbatim ? arg : quoteWindowsArgument(arg)))
      .join(" "),
  };
}

/** 실행기로 띄우는 Node.js spawn 인자. 명령줄은 다시 감싸지 않고 그대로 넘긴다. */
function runnerLaunch(file: string, application: string, commandLine: string) {
  return {
    file,
    args: [Buffer.from(application, "utf8").toString("base64"), commandLine],
    options: { argv0: `"${file}"`, windowsVerbatimArguments: true },
  };
}

/**
 * 실행 시도의 프로그램을 묶음 실행기로 띄우는 방법. 서버가 실행기를 준비하지 않았거나(Windows 밖, 시험)
 * 프로그램을 찾지 못하면(기존 경로가 알린다) 아무것도 돌려주지 않고, 준비에 실패했으면 그 이유를 돌려준다.
 */
export function windowsJobLaunch(
  command: readonly [string, ...string[]],
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string }
):
  | { launch: ReturnType<typeof runnerLaunch> }
  | { unavailable: string }
  | undefined {
  if (!runner) return undefined;
  if (!runner.ok) return { unavailable: runner.reason };
  const resolved = resolvedCommand(
    command[0],
    [...command.slice(1), ...args],
    options
  );
  return (
    resolved && {
      launch: runnerLaunch(
        runner.file,
        resolved.application,
        resolved.commandLine
      ),
    }
  );
}

/** 실행기를 띄워 그 상태 줄과 종료 코드를 본다. 해가 없는 `cmd /c exit 7`을 묶음 안에서 돌린다. */
function trial(file: string) {
  const cmd = path.join(
    process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
    "System32",
    "cmd.exe"
  );
  const launch = runnerLaunch(file, cmd, "cmd.exe /d /c exit 7");
  return new Promise<{ ok: true } | { ok: false; reason: string }>(
    (resolve) => {
      const child = spawnChild(launch.file, launch.args, {
        ...launch.options,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        timeout: trialLimitMs,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(0, 4096);
      });
      child.on("error", (error) =>
        resolve({
          ok: false,
          reason: `the job runner could not start: ${error.message}`,
        })
      );
      child.on("close", (code, signal) => {
        const status = stderr.split(/\r?\n/)[0] ?? "";
        if (code === 7 && status === `${jobStatusPrefix}ok`)
          resolve({ ok: true });
        else if (status.startsWith(jobStatusPrefix))
          resolve({ ok: false, reason: status.slice(jobStatusPrefix.length) });
        else
          resolve({
            ok: false,
            reason: `the job runner's trial ended with ${signal ?? `code ${code}`}`,
          });
      });
    }
  );
}

function compile(compiler: string, source: string, out: string) {
  return new Promise<string | undefined>((resolve) => {
    const child = spawnChild(
      compiler,
      ["/nologo", "/target:exe", "/optimize+", `/out:${out}`, source],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: compileLimitMs,
      }
    );
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) =>
      resolve(`the C# compiler could not start: ${error.message}`)
    );
    child.on("close", (code, signal) =>
      resolve(
        code === 0
          ? undefined
          : `the C# compiler ended with ${signal ?? `code ${code}`}: ${output.trim()}`
      )
    );
  });
}

function compilers() {
  const windows = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return ["Framework64", "Framework"].map((folder) =>
    path.join(windows, "Microsoft.NET", folder, "v4.0.30319", "csc.exe")
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 같은 소스로 만든 실행기가 있고 시험 실행이 되면 그것을 쓰고, 아니면 고유한 임시 이름으로 만들어 시험한 뒤 공개한다. */
async function build(
  dataDir: string,
  candidates: readonly string[]
): Promise<WindowsJobRunner> {
  const source = readFileSync(sourceFile);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const directory = path.join(dataDir, "tools");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `windows-job-${hash}.exe`);
  if (existsSync(file) && (await trial(file)).ok) return { ok: true, file };
  const compiler = candidates.find((candidate) => existsSync(candidate));
  if (!compiler)
    return {
      ok: false,
      reason: "the C# compiler of the .NET Framework was not found",
    };
  const temp = path.join(directory, `windows-job-${hash}.${randomUUID()}`);
  try {
    writeFileSync(`${temp}.cs`, source);
    const failure = await compile(compiler, `${temp}.cs`, `${temp}.exe`);
    if (failure) return { ok: false, reason: failure };
    const tried = await trial(`${temp}.exe`);
    if (!tried.ok) return tried;
    // 같은 데이터 폴더의 다른 서버가 먼저 공개했거나, 백신이 잠깐 붙잡고 있을 수 있다. 몇 번만 다시 시도한다.
    for (let attempt = 0; ; attempt++)
      try {
        renameSync(`${temp}.exe`, file);
        return { ok: true, file };
      } catch (error) {
        if (existsSync(file) && (await trial(file)).ok)
          return { ok: true, file };
        if (attempt >= 4) throw error;
        await sleep(200);
      }
  } catch (error) {
    return {
      ok: false,
      reason: `the job runner could not be saved: ${(error as Error).message}`,
    };
  } finally {
    rmSync(`${temp}.cs`, { force: true });
    rmSync(`${temp}.exe`, { force: true });
  }
}

/**
 * 서버 시작 때 한 번 부른다. Windows에서 묶음 실행기를 데이터 폴더(`tools/`)에 준비하고, 이후 실행 시도가 그것을 쓴다.
 * 준비하지 못하면 서버 운영 기록에 경고하고, 실행 시도는 지금처럼 묶음 없이 돈다. Windows가 아니면 아무것도 하지 않는다.
 */
export async function prepareWindowsJobRunner(
  dataDir: string,
  options: { compilers?: readonly string[] } = {}
): Promise<WindowsJobRunner | undefined> {
  if (process.platform !== "win32") return undefined;
  runner = await build(dataDir, options.compilers ?? compilers());
  if (!runner.ok)
    console.warn(
      `[provider] the Windows job runner is not available, so programs a run leaves behind may keep running: ${runner.reason}`
    );
  return runner;
}
