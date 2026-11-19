import spawn from "cross-spawn";
import { spawn as spawnChild } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { continueAfterFailure, failureCode } from "@babojubot/contracts";

/**
 * Windows 묶음 실행기(#205). Windows에는 프로세스 그룹이 없어, 프로그램이 먼저 끝나면 남긴 프로그램을 찾을 수 없다.
 * 서버는 시작할 때 저장소의 C# 소스를 Windows에 기본으로 있는 .NET Framework C# 컴파일러로 데이터 폴더에 한 번 만들어 두고
 * (소스 해시로 판단), 실행 시도마다 프로그램을 이 실행기로 띄운다. 실행기는 프로그램을 묶음(Job Object)에 넣어 띄우고,
 * 프로그램이 끝나거나 실행기가 끝나면 묶음 안의 프로그램을 모두 끈다. 준비하지 못하면 실행 시도는 묶음 없이 돌고 경고한다.
 */
const sourceFile = new URL("./job-object-launcher.cs", import.meta.url);
const filePrefix = "job-object-launcher-";
/** 공개한 실행기 이름. 만드는 중인 임시 파일(`<해시>.<UUID>.exe`)과 구별한다. */
const publishedName = /^job-object-launcher-[0-9a-f]{16}\.exe$/;
const compileLimitMs = 120_000;
const trialLimitMs = 15_000;

export type JobObjectLauncher =
  { ok: true; file: string } | { ok: false; reason: string };
let launcher: JobObjectLauncher | undefined;

/** 실행기가 표준 오류에 맨 먼저(프로그램이 돌기 전에) 쓰는 상태 줄을 읽는다. 상태 줄이 아니면 `undefined`다. */
export function readLauncherStatus(
  line: string
): { kind: "ok" } | { kind: "warning" | "failed"; reason: string } | undefined {
  const match =
    /^\[babojubot-job-object\] (?:(ok)|(warning|failed): (.*))$/.exec(
      line.trimEnd()
    );
  if (!match) return undefined;
  return match[1]
    ? { kind: "ok" }
    : { kind: match[2] as "warning" | "failed", reason: match[3]! };
}

/** Windows 명령줄 한 인수를 MSVCRT 규칙으로 감싼다. Node.js(libuv)가 인수를 넘길 때와 같은 결과로 풀린다. */
function quoteWindowsArgument(arg: string) {
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

/**
 * cross-spawn이 실제로 띄울 프로그램과 명령줄. `.cmd` 시작 파일은 cmd.exe 경유와 그 인수 처리까지 그대로다.
 * 프로그램을 찾지 못하면 `undefined`다. 그때는 cross-spawn이 지금처럼 띄워 시작 실패(ENOENT)로 알린다.
 */
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
  if (!parsed.file) return undefined;
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
function launcherSpawn(file: string, application: string, commandLine: string) {
  return {
    file,
    args: [Buffer.from(application, "utf8").toString("base64"), commandLine],
    options: { argv0: `"${file}"`, windowsVerbatimArguments: true },
  };
}

/**
 * 실행 시도의 프로그램을 묶음 실행기로 띄우는 방법. 서버가 실행기를 준비하지 않았거나(Windows 밖, 시험)
 * 프로그램을 찾지 못하면 아무것도 돌려주지 않고, 준비에 실패했으면 그 이유를 돌려준다.
 */
export function jobObjectLaunch(
  command: readonly [string, ...string[]],
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string }
):
  | { launch: ReturnType<typeof launcherSpawn> }
  | { unavailable: string }
  | undefined {
  if (!launcher) return undefined;
  if (!launcher.ok) return { unavailable: launcher.reason };
  const resolved = resolvedCommand(
    command[0],
    [...command.slice(1), ...args],
    options
  );
  return (
    resolved && {
      launch: launcherSpawn(
        launcher.file,
        resolved.application,
        resolved.commandLine
      ),
    }
  );
}

const windowsFolder = () =>
  process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";

/** 실행기를 띄워 그 상태 줄과 종료 코드를 본다. 해가 없는 `cmd /c exit 7`을 묶음 안에서 돌린다. */
function trial(file: string) {
  const cmd = path.join(windowsFolder(), "System32", "cmd.exe");
  const launch = launcherSpawn(file, cmd, "cmd.exe /d /c exit 7");
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
          reason: `the job object launcher could not start: ${error.message}`,
        })
      );
      child.on("close", (code, signal) => {
        const status = readLauncherStatus(stderr.split("\n")[0] ?? "");
        if (status?.kind === "ok" && code === 7) resolve({ ok: true });
        else if (status && status.kind !== "ok")
          resolve({ ok: false, reason: status.reason });
        else
          resolve({
            ok: false,
            reason: `the job object launcher's trial ended with ${signal ?? `code ${code}`}`,
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
  return ["Framework64", "Framework"].map((folder) =>
    path.join(windowsFolder(), "Microsoft.NET", folder, "v4.0.30319", "csc.exe")
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 지우지 못해도(다른 서버가 쓰는 중, 백신이 잡고 있음) 준비를 실패로 만들지 않는다. 다음 시작 때 다시 지운다. */
function remove(file: string) {
  continueAfterFailure(
    () => rmSync(file, { force: true }),
    (error) =>
      console.warn(
        `[provider] an old launcher file could not be removed; the next start tries again (${failureCode(error)})`
      )
  );
}

/** 같은 소스로 만든 실행기가 있고 시험 실행이 되면 그것을 쓰고, 아니면 고유한 임시 이름으로 만들어 시험한 뒤 공개한다. */
async function build(
  directory: string,
  candidates: readonly string[]
): Promise<JobObjectLauncher> {
  const source = readFileSync(sourceFile);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${filePrefix}${hash}.exe`);
  if (existsSync(file) && (await trial(file)).ok) return { ok: true, file };
  const compiler = candidates.find((candidate) => existsSync(candidate));
  if (!compiler)
    return {
      ok: false,
      reason: "the C# compiler of the .NET Framework was not found",
    };
  const temp = path.join(directory, `${filePrefix}${hash}.${randomUUID()}`);
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
  } finally {
    remove(`${temp}.cs`);
    remove(`${temp}.exe`);
  }
}

/** 다른 소스로 만든 예전 실행기를 지운다. 만드는 중인 다른 서버의 임시 파일은 건드리지 않는다. */
function removeOldLaunchers(directory: string, current: string) {
  continueAfterFailure(
    () => {
      for (const name of readdirSync(directory))
        if (publishedName.test(name) && path.join(directory, name) !== current)
          remove(path.join(directory, name));
    },
    (error) =>
      console.warn(
        `[provider] old launchers could not be listed; the next start tries again (${failureCode(error)})`
      )
  );
}

/**
 * 서버 시작 때 한 번 부른다. Windows에서 묶음 실행기를 데이터 폴더(`tools/`)에 준비하고, 이후 실행 시도가 그것을 쓴다.
 * 어떤 이유로든 준비하지 못하면 던지지 않고 서버 운영 기록에 경고하며, 실행 시도는 지금처럼 묶음 없이 돈다.
 * Windows가 아니면 아무것도 하지 않는다.
 */
export async function prepareJobObjectLauncher(
  dataDir: string,
  options: { compilers?: readonly string[] } = {}
): Promise<JobObjectLauncher | undefined> {
  if (process.platform !== "win32") return undefined;
  const directory = path.join(dataDir, "tools");
  try {
    launcher = await build(directory, options.compilers ?? compilers());
  } catch (error) {
    launcher = {
      ok: false,
      reason: `the job object launcher could not be prepared: ${(error as Error).message}`,
    };
  }
  if (launcher.ok) removeOldLaunchers(directory, launcher.file);
  else
    console.warn(
      `[provider] the Windows job object launcher is not available, so programs a run leaves behind may keep running: ${launcher.reason}`
    );
  return launcher;
}
