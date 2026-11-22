import spawn from "cross-spawn";
import { spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { boundChild, type BoundedExit } from "./bounded-command.ts";

/**
 * 감독 실행기(#268). 세 OS 모두 실행 시도마다 이 Rust 프로그램(`packages/process/supervisor`) 하나가 프로그램을 띄우고 그 트리를
 * 쥔다: Linux·macOS는 프로그램의 프로세스 그룹을 마지막 신호까지 거두지 않은 채, Windows는 프로그램을 묶음(Job Object)에 넣은 채.
 * 공용 실행(`launch.ts`)이 실행기를 띄우고 넷째 표준 핸들의 제어 통로로 말한다. 통로의 약속은 실행기의 `src/protocol.rs` 머리말에
 * 있고, 서버가 사라져 통로가 끝나면 실행기가 스스로 트리를 끈다. 실행기를 준비하지 못하면 공용 실행이 프로그램을 띄우지 않고
 * 거절한다(Node.js가 직접 띄우는 길은 없다).
 *
 * 서버는 시작할 때 실행기를 찾아 해가 없는 시험 실행으로 약속대로 도는지 본다. 실행기는 저장소 소스에서 빌드한다
 * (`pnpm --filter @babojubot/process run build`). 실행 파일은 Git에 넣지 않는다.
 */

/** 이 서버가 쓰는 제어 통로의 약속 판. 실행기가 첫 줄로 알리는 판과 같아야 한다(`protocol.rs`의 `PROTOCOL`). */
export const supervisorProtocol = 1;
const trialLimitMs = 15_000;
const windows = () => process.platform === "win32";

/**
 * 이 시스템의 빌드 대상(빌드 명령 `supervisor/build.mjs`와 같은 표). Linux는 glibc에 매이지 않는 정적 musl 실행 파일이다. 실행기가
 * 없는 시스템이면 `undefined`다.
 */
function buildTarget() {
  const targets: unknown = JSON.parse(
    readFileSync(new URL("../supervisor/targets.json", import.meta.url), "utf8")
  );
  if (typeof targets !== "object" || targets === null) return undefined;
  const target: unknown = Reflect.get(
    targets,
    `${process.platform} ${process.arch}`
  );
  return typeof target === "string" ? target : undefined;
}

/** checkout에서 빌드한 실행기의 자리. */
function builtFile() {
  const target = buildTarget();
  if (target === undefined) return undefined;
  const name = windows() ? "babojubot-supervisor.exe" : "babojubot-supervisor";
  return fileURLToPath(
    new URL(`../supervisor/target/${target}/release/${name}`, import.meta.url)
  );
}

export type Supervisor =
  { ok: true; file: string } | { ok: false; reason: string };
let supervisor: Supervisor | undefined;

/** 실행기가 제어 통로에 쓰는 한 줄. 모르는 줄이면 `undefined`다. */
export type SupervisorMessage =
  | { kind: "hello"; protocol: number }
  | { kind: "ok"; pid: number }
  | { kind: "failed"; reason: string }
  | { kind: "not-started"; code: string; reason: string }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "ended" }
  | { kind: "left"; detail: string };

export function readSupervisorLine(
  text: string
): SupervisorMessage | undefined {
  const line = text.trimEnd();
  let match: RegExpExecArray | null;
  if ((match = /^babojubot-supervisor (\d+)$/.exec(line)))
    return { kind: "hello", protocol: Number(match[1]) };
  if ((match = /^ok (\d+)$/.exec(line)))
    return { kind: "ok", pid: Number(match[1]) };
  if ((match = /^failed: (.*)$/.exec(line)))
    return { kind: "failed", reason: match[1]! };
  if ((match = /^not-started ([A-Z0-9]+): (.*)$/.exec(line)))
    return { kind: "not-started", code: match[1]!, reason: match[2]! };
  if ((match = /^exit (-?\d+)$/.exec(line)))
    return { kind: "exit", code: Number(match[1]), signal: null };
  if ((match = /^exit-signal (SIG[A-Z0-9]+)$/.exec(line)))
    return { kind: "exit", code: null, signal: match[1] as NodeJS.Signals };
  if (line === "ended") return { kind: "ended" };
  if ((match = /^left: (.*)$/.exec(line)))
    return { kind: "left", detail: match[1]! };
  return undefined;
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
 * Windows: cross-spawn이 실제로 띄울 프로그램과 명령줄. `.cmd` 시작 파일은 cmd.exe 경유와 그 인수 처리까지 그대로다.
 * 프로그램을 찾지 못하면 `undefined`다.
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

/** 실행기로 띄우는 Node.js spawn 인자. Windows는 명령줄을 다시 감싸지 않고 그대로 넘긴다. */
type Launch = {
  file: string;
  args: string[];
  options: { argv0?: string; windowsVerbatimArguments?: boolean };
};

function windowsLaunch(
  file: string,
  application: string,
  commandLine: string
): Launch {
  return {
    file,
    args: [Buffer.from(application, "utf8").toString("hex"), commandLine],
    options: { argv0: `"${file}"`, windowsVerbatimArguments: true },
  };
}

/** 실행기로 띄우는 방법, 또는 띄울 수 없는 이유. */
export type SupervisorLaunch =
  | { kind: "launch"; launch: Launch }
  /** 쓸 수 없다: 준비하다 실패했거나 이 프로세스가 준비를 부르지 않았다. 이유는 `supervisorProblem`과 같다. */
  | { kind: "unavailable"; reason: string }
  /** Windows: 프로그램을 찾지 못했다. cross-spawn으로 띄우면 cmd.exe가 돌다 끝나며 시작 실패(ENOENT)로 알린다. */
  | { kind: "not-found" };

/** 실행기를 쓸 수 없는 이유. 쓸 수 있으면 `undefined`다. */
export function supervisorProblem() {
  if (!supervisor)
    return "the supervisor was not prepared in this process (prepareSupervisor)";
  return supervisor.ok ? undefined : supervisor.reason;
}

/** 프로그램을 실행기로 띄우는 방법. */
export function supervisorLaunch(
  command: readonly [string, ...string[]],
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string }
): SupervisorLaunch {
  // Windows에서 찾지 못한 프로그램은 준비와 상관없이 먼저 가려 둔다(cross-spawn과 같은 시작 오류로 알린다).
  const resolved = windows()
    ? resolvedCommand(command[0], [...command.slice(1), ...args], options)
    : undefined;
  if (windows() && !resolved) return { kind: "not-found" };
  if (!supervisor?.ok)
    return { kind: "unavailable", reason: supervisorProblem() ?? "unknown" };
  return {
    kind: "launch",
    launch: resolved
      ? windowsLaunch(
          supervisor.file,
          resolved.application,
          resolved.commandLine
        )
      : { file: supervisor.file, args: [...command, ...args], options: {} },
  };
}

const windowsFolder = () =>
  process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";

/**
 * 실행기를 띄워 제어 통로의 약속대로 도는지 본다. 해가 없는 `exit 7`을 실행기 아래에서 돌려, 약속 판, 시작 결과 `ok`, 프로그램 끝
 * `exit 7`을 받은 뒤 끄기를 보내 `ended`를 받고, 실행기가 끝나 통로가 닫혀야 성공이다. 모두 시한 안에 끝을 보장한다.
 */
async function trial(file: string): Promise<Supervisor> {
  const launch = windows()
    ? windowsLaunch(
        file,
        path.join(windowsFolder(), "System32", "cmd.exe"),
        "cmd.exe /d /c exit 7"
      )
    : { file, args: ["/bin/sh", "-c", "exit 7"], options: {} };
  const child = spawnChild(launch.file, launch.args, {
    ...launch.options,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: !windows(),
  });
  const control = child.stdio[3] as Duplex | null;
  const lines: string[] = [];
  let problem: string | undefined;
  let ended = false;
  const giveUp = new AbortController();
  const fail = (reason: string) => {
    problem ??= reason;
    giveUp.abort();
  };
  let pending = "";
  control?.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
      const line = pending.slice(0, newline).trimEnd();
      pending = pending.slice(newline + 1);
      lines.push(line);
      const message = readSupervisorLine(line);
      if (lines.length === 1) {
        if (message?.kind !== "hello")
          fail(
            `the supervisor's first line was ${JSON.stringify(line)}, not its protocol`
          );
        else if (message.protocol !== supervisorProtocol)
          fail(
            `the supervisor speaks protocol ${message.protocol}, this server needs ${supervisorProtocol}; build it again ("pnpm --filter @babojubot/process run build") or install the matching package`
          );
      } else if (message?.kind === "failed" || message?.kind === "not-started")
        fail(message.reason);
      else if (message?.kind === "exit" && message.code === 7)
        control.write("stop 0\n");
      else if (message?.kind === "ended") ended = true;
      else if (message?.kind === "left")
        fail(`the supervisor's trial left programs running: ${message.detail}`);
    }
  });
  // 실행기가 끝나 통로가 닫히면 쓰기가 실패할 수 있다. 결과는 받은 줄로 판단하고, 통로의 첫 실패는 이유에 함께 적는다.
  let controlError: string | undefined;
  control?.on("error", (error) => {
    controlError ??= error.message;
  });
  // 통로의 반대쪽 끝은 실행기만 쥔다(프로그램은 물려받지 않는다). 실행기가 끝나면 닫힌다.
  const controlClosed = new Promise<void>((resolve) => {
    if (control) control.once("close", () => resolve());
    else resolve();
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(0, 4096);
  });
  let exit: BoundedExit;
  try {
    // 시한에 SIGKILL로 끝내고 끝을 보장한다. 끝나지 않으면 준비 실패로 다룬다. 실행기가 끝나면 그 통로도 곧 닫히므로 닫힘도 기다린다.
    [exit] = await Promise.all([
      boundChild(child, { limitMs: trialLimitMs, signal: giveUp.signal }),
      controlClosed,
    ]);
  } catch (error) {
    control?.destroy();
    return {
      ok: false,
      reason: `the supervisor's trial did not end: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (problem !== undefined) return { ok: false, reason: problem };
  if (ended && exit.code === 0) return { ok: true, file };
  return {
    ok: false,
    reason: `the supervisor's trial ended with ${exit.killed ? "its time limit" : (exit.signal ?? `code ${exit.code}`)} after ${JSON.stringify(lines)}${controlError ? ` (control channel error: ${controlError})` : ""}${stderr ? `: ${stderr.trim()}` : ""}`,
  };
}

/**
 * 서버 시작 때 한 번 부른다. 실행기(기본은 checkout에서 빌드한 것, `file`로 바꿀 수 있다)를 찾아 시험 실행하고, 이후 실행 시도가
 * 그것을 쓴다. 어떤 이유로든 준비하지 못하면 던지지 않고(서버는 뜬다) 서버 운영 기록에 남긴다. 그때 실행 시도는 띄우지 않고 그
 * 이유로 실패한다(대시보드의 실행 시도 실패 원인).
 */
export async function prepareSupervisor(
  options: { file?: string } = {}
): Promise<Supervisor> {
  const file = options.file ?? builtFile();
  try {
    supervisor =
      file === undefined
        ? {
            ok: false,
            reason: `this system (${process.platform} ${process.arch}) has no supervisor build`,
          }
        : !existsSync(file)
          ? {
              ok: false,
              reason: `the supervisor program was not found at ${file}; build it with "pnpm --filter @babojubot/process run build"`,
            }
          : await trial(file);
  } catch (error) {
    supervisor = {
      ok: false,
      reason: `the supervisor could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!supervisor.ok)
    console.warn(
      `[provider] the supervisor is not available, so runs are refused until it is: ${supervisor.reason}`
    );
  return supervisor;
}
