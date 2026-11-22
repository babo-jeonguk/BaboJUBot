import spawn from "cross-spawn";
import { spawn as spawnChild } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Readable, Writable, Duplex } from "node:stream";
import { attemptAll, failureCode, settled } from "@babojubot/contracts";
import {
  leaseEnvironment,
  processStartTicks,
  stopLeaseHolders,
} from "./lease.ts";

/**
 * 감독 실행기 아래의 트리 하나(#268). 실행기를 띄우고 넷째 표준 핸들의 제어 통로로 약속(실행기 `src/protocol.rs` 머리말)대로 말한다.
 * 제품의 실행 시도(`launch.ts` `launchTree`)와 준비의 시험 실행(`supervisor.ts`)이 같은 이 코드로 띄우고 끄며, 약속의 해석과 순서
 * 검사도 이 한 곳에서 한다. 실행기는 트리의 관리자라 실행 시도의 표식을 지니지 않는다: 표식은 통로로 넘겨 실행기가 프로그램에만 주고,
 * 표식 정리는 실행기가 끝난 뒤에 한다.
 */

/** 이 서버가 쓰는 제어 통로의 약속 판. 실행기가 첫 줄로 알리는 판과 같아야 한다(`protocol.rs`의 `PROTOCOL`). */
export const supervisorProtocol = 3;

/** 표준 입력·출력·오류. `"pipe"`는 셋 모두 파이프다. 숫자는 이미 연 파일 기술자다. */
export type TreeStdio =
  | "pipe"
  | readonly [
      "ignore" | "pipe",
      "ignore" | "pipe" | number,
      "ignore" | "pipe" | number,
    ];

export type TreeLaunch = {
  command: readonly [string, ...string[]];
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: TreeStdio;
};

/** 띄운 결과. */
export type TreeStart =
  /** 돈다. `stop()`이 트리 전체의 끝을 확인한다. */
  | { kind: "running" }
  /** 프로그램이 시작하지 못했다. 시작 오류(ENOENT 등)는 `error`에 그대로 둔다. */
  | { kind: "failed"; reason: string; error?: unknown };

export type TreeExit = { code: number | null; signal: NodeJS.Signals | null };

export type LaunchedTree<In = Writable | null, Out = Readable | null> = {
  /** 이 트리를 쥔 감독 실행기의 번호. 실행기를 띄우지 못했으면 없다. */
  pid: number | undefined;
  /** 이 트리의 표식. 서버 재시작 뒤 복구 기록에 남긴다. */
  lease: string;
  stdin: In;
  stdout: Out;
  stderr: Out;
  started: Promise<TreeStart>;
  /** 대표가 끝났다. 시작하지 못했어도 이행한다. 자손은 `stop()`까지 남는다. */
  exited: Promise<TreeExit>;
  /** 대표의 그룹에 중단(SIGINT)을 보내게 한다. 끄기가 아니다. Windows에는 없다. */
  interrupt(): void;
  /** 사고 재현용: 대표만 강제로 끝낸다. 자손은 남고 `stop()`이 끈다. 끄기 대신 쓰지 않는다. */
  killLeader(): void;
  /**
   * 트리 전체를 끄고 끝난 것을 상한 안에서 확인한다. 확인하지 못하면 원인과 함께 던진다. 여러 번 불러도 한 번만 끄고 같은 결과를
   * 돌려준다. `graceMs`는 SIGTERM 뒤 스스로 끝나기를 기다리는 시간이다(첫 부름의 값만 쓴다. Windows는 바로 끈다).
   */
  stop(options?: { graceMs?: number }): Promise<void>;
};

/** 실행기로 띄우는 Node.js spawn 인자. Windows는 명령줄을 다시 감싸지 않고 그대로 넘긴다. */
export type SupervisorCommand = {
  file: string;
  args: string[];
  options: { argv0?: string; windowsVerbatimArguments?: boolean };
};

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
export function resolvedCommand(
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

export function windowsLaunch(
  file: string,
  application: string,
  commandLine: string
): SupervisorCommand {
  return {
    file,
    args: [Buffer.from(application, "utf8").toString("hex"), commandLine],
    options: { argv0: `"${file}"`, windowsVerbatimArguments: true },
  };
}

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

/** 실행기가 시작 응답(`ok`·`failed`·`not-started`)을 쓸 때까지의 상한. 실행기는 프로그램을 띄운 직후 답한다. */
const supervisorStartLimitMs = 10_000;
/** 실행기가 끄기를 받고 트리가 끝났다고 답할 때까지의 상한(유예 뒤). 실행기가 마지막 신호 뒤 끝을 기다리는 10초에 여유를 둔다. */
const supervisorStopLimitMs = 20_000;
/** 실행기가 끝나거나 대표의 끝이 전달되기를 기다리는 상한. 트리가 끝나 출력이 닫히기를 기다리는 상한도 같다. */
export const endLimitMs = 10_000;

const windows = () => process.platform === "win32";

/** `promise`를 `ms` 안에 기다린다. 넘기면 `what`과 함께 던진다. */
export async function within<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} within ${ms} ms`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 프로그램이 시작하지 못한 오류. Node.js의 spawn 시작 오류와 같은 모양(`code`·`syscall`·`path`)이다. */
export function startError(options: TreeLaunch, code: string, reason?: string) {
  const [command] = options.command;
  return Object.assign(
    new Error(`spawn ${command} ${code}${reason ? ` (${reason})` : ""}`),
    {
      code,
      errno: code,
      syscall: `spawn ${command}`,
      path: command,
      spawnargs: [...options.command.slice(1), ...options.args],
    }
  );
}

/** 한쪽이 받는 메시지 하나의 상한. 실행기(`protocol.rs`의 `MESSAGE_LIMIT`)와 같다. */
const messageLimit = 1024 * 1024;

/**
 * 제어 통로의 메시지 하나를 netstring(`[길이]":"[바이트]","`, D. J. Bernstein)으로 감싼다. 두 방향의 모든 메시지가 이 틀을 쓰므로,
 * 메시지 안의 값(표식의 개행, 이유의 CR 등)이 다른 메시지를 나누거나 만들지 못한다(#274 외부 리뷰 2회차 SPEC-3). 실행기와 같은 시험
 * 벡터(`supervisor/protocol-vectors.txt`)를 지킨다.
 */
export function encodeMessage(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([
    Buffer.from(`${body.length}:`),
    body,
    Buffer.from(","),
  ]);
}

/** 통로로 온 바이트에서 netstring을 읽는다. 메시지가 나뉘어 오거나 여럿이 한꺼번에 와도 된다. 틀이 어긋나면 던진다. */
export class MessageReader {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages: string[] = [];
    const limitDigits = String(messageLimit).length;
    for (;;) {
      let digits = 0;
      while (
        digits < this.pending.length &&
        this.pending[digits]! >= 0x30 &&
        this.pending[digits]! <= 0x39
      )
        digits++;
      if (digits > limitDigits)
        throw new Error(
          "malformed control message: its length is over the limit"
        );
      if (digits === this.pending.length) return messages;
      if (digits === 0)
        throw new Error(
          "malformed control message: it does not start with its length"
        );
      if (this.pending[digits] !== 0x3a)
        throw new Error('malformed control message: no ":" after its length');
      if (digits > 1 && this.pending[0] === 0x30)
        throw new Error(
          "malformed control message: its length has a leading zero"
        );
      const length = Number(this.pending.subarray(0, digits).toString());
      if (length > messageLimit)
        throw new Error(
          "malformed control message: its length is over the limit"
        );
      const end = digits + 1 + length;
      if (this.pending.length <= end) return messages;
      if (this.pending[end] !== 0x2c)
        throw new Error('malformed control message: no "," after it');
      const body = this.pending.subarray(digits + 1, end);
      this.pending = this.pending.subarray(end + 1);
      messages.push(new TextDecoder("utf-8", { fatal: true }).decode(body));
    }
  }
}

/**
 * 실행기 → 서버 메시지의 허용 전이(`supervisor/protocol-transitions.txt`, #274 외부 리뷰 2회차 SPEC-4). 해석기는 이 표만 따르고, 표에
 * 없는 사건은 약속 위반이다. `stop`은 서버가 보낸 끄기다. 실행기의 Rust 시험도 같은 표로 실행기가 내는 순서를 확인한다.
 */
const transitions = new Map<string, string>(
  readFileSync(
    new URL("../supervisor/protocol-transitions.txt", import.meta.url),
    "utf8"
  )
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row[0] === "transition")
    .map(([, phase, event, next]) => [`${phase} ${event}`, next!])
);

/** 그 단계에서 그 사건 뒤의 단계. 표에 없으면 `undefined`(약속 위반)다. */
export function nextPhase(phase: string, event: string): string | undefined {
  return transitions.get(`${phase} ${event}`);
}

/**
 * 감독 실행기(`command`)로 트리 하나를 띄운다. `abandon`은 준비의 시험 실행이 시한을 넘겼을 때 쓴다: 끄기와 같은 강제 종료 길로
 * 실행기를 끝내고 통로와 출력을 닫은 뒤 그 끝을 상한 안에서 확인한다(확인하지 못하면 던진다).
 * 출력을 닫는다(트리의 끝은 확인하지 않는다).
 */
export function superviseTree(
  command: SupervisorCommand,
  options: TreeLaunch,
  lease: string,
  {
    inherited = process.env,
  }: {
    /** 이 프로세스가 물려받아 새 트리에 넘길 표식이 든 환경. 준비의 시험 실행은 바깥 표식이 필요 없어 비운다. */
    inherited?: NodeJS.ProcessEnv;
  } = {}
): { tree: LaunchedTree; abandon: () => Promise<void> } {
  const { env, leases } = leaseEnvironment(options.env, lease, inherited);
  const stdio =
    options.stdio === "pipe"
      ? (["pipe", "pipe", "pipe"] as const)
      : options.stdio;
  // 실행기를 띄우지 못하면(백신이 지웠거나 막음) 프로그램은 시작하지 않은 채 시작 실패로 끝난다(아래 error). Linux·macOS의 실행기는
  // 자기 세션에서 돌아, 터미널의 중단(Ctrl-C)이 서버의 그룹에 가도 실행기는 받지 않고 통로가 끝날 때 트리를 끈다. Windows의
  // 실행기는 Node.js의 묶음 안에 두어, 서버가 강제로 끝나면 실행기와 그 묶음도 함께 끝난다. 실행기의 환경에는 표식이 없다.
  const child = spawnChild(command.file, command.args, {
    ...command.options,
    cwd: options.cwd,
    env,
    stdio: [...stdio, "pipe"],
    windowsHide: true,
    detached: !windows(),
  });
  const control = (child.stdio[3] ?? undefined) as Duplex | undefined;
  const pid = child.pid;
  // 표식을 읽을 수 없는 프로그램은 이 트리가 시작한 뒤에 생겼을 때만 우리 것일 수 있다. 실행기의 시작 시각을 기준으로 둔다(Linux).
  const since =
    process.platform === "linux" && pid ? processStartTicks(pid) : undefined;

  let reportStart!: (start: TreeStart) => void;
  const started = new Promise<TreeStart>((resolve) => {
    let done = false;
    reportStart = (start) => {
      if (done) return;
      done = true;
      resolve(start);
    };
  });
  let leaderDone = false;
  let reportExit!: (exit: TreeExit) => void;
  const exited = new Promise<TreeExit>((resolve) => {
    reportExit = (exit) => {
      if (leaderDone) return;
      leaderDone = true;
      resolve(exit);
    };
  });
  child.on("error", (error) => {
    // 띄운 뒤의 오류(신호를 보내지 못함 등)는 끝남이 아니다. 끝났는지는 stop()이 확인하고, 그 오류는 원인으로 남긴다.
    if (pid !== undefined) {
      console.warn(
        `[provider] a supervisor reported an error; stop() checks whether its tree ended (${failureCode(error)})`
      );
      return;
    }
    reportStart({ kind: "failed", reason: error.message, error });
    reportExit({ code: null, signal: null });
  });

  /** 실행기의 끄기 답. `undefined`는 답 없이 통로가 닫혔다는 뜻이다. */
  let reportEnd!: (end: string | undefined) => void;
  const ended = new Promise<string | undefined>((resolve) => {
    let done = false;
    reportEnd = (end) => {
      if (done) return;
      done = true;
      resolve(end);
    };
  });
  let supervisorExit: TreeExit | undefined;
  /** 제어 통로가 실패했으면 그 오류 이름. */
  let controlFailure: string | undefined;
  /** 실행기가 약속을 어겼으면 그 내용. */
  let protocolFailure: string | undefined;
  /** 실행기가 끝나고 통로가 닫혔다. */
  const supervisorGone = Promise.all([
    new Promise<void>((resolve) => {
      if (control) control.once("close", () => resolve());
      else resolve();
    }),
    new Promise<void>((resolve) =>
      child.once("exit", (code, signal) => {
        supervisorExit = { code, signal };
        resolve();
      })
    ),
  ]);
  /**
   * 실행기를 강제로 끝내고 통로·출력을 닫은 뒤, 그 끝을 상한 안에서 확인한다(#274 외부 리뷰 2회차 STD-3). 확인하지 못하면 던진다.
   * 끄기의 확인 실패, 시작 응답이 없는 실행기, 준비의 시험 실행 시한 초과가 모두 이 한 길로 끝낸다.
   */
  const forceEnd = async () => {
    child.kill("SIGKILL");
    control?.destroy();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream?.destroy();
    await within(
      supervisorGone,
      endLimitMs,
      `process ${pid} (the supervisor) did not end after SIGKILL`
    );
  };
  /** 약속을 어긴 실행기는 믿지 않는다. 그 원인으로 시작·끝을 실패시키고 실행기를 강제로 끝낸다(그 뒤의 끝은 stop()이 확인한다). */
  const breakProtocol = (reason: string) => {
    protocolFailure ??= reason;
    phase = "done";
    reportStart({ kind: "failed", reason });
    reportEnd(undefined);
    child.kill("SIGKILL");
    control?.destroy();
  };
  let phase = "hello";
  const reader = new MessageReader();
  /** 첫 바이트들. 틀 없이 한 줄로 판을 알리는 예전 실행기(판 1·2)를 알아보려고 첫 줄까지만 모은다. */
  let opening: Buffer | undefined = Buffer.alloc(0);
  const unframedHello = /^babojubot-supervisor (\d+)\r?\n/;
  control?.on("data", (chunk: Buffer) => {
    if (opening !== undefined) {
      opening = Buffer.concat([opening, chunk]);
      const text = opening.toString("latin1");
      const old = unframedHello.exec(text);
      if (old) {
        breakProtocol(
          `the supervisor speaks protocol ${old[1]}, this server needs ${supervisorProtocol}; build it again ("pnpm --filter @babojubot/process run build") or install the matching package`
        );
        return;
      }
      // 아직 그 줄의 앞부분일 수 있으면 더 받는다. 아니면 모은 바이트를 netstring으로 읽는다.
      if (
        "babojubot-supervisor ".startsWith(text) ||
        /^babojubot-supervisor \d*$/.test(text)
      )
        return;
      chunk = opening;
      opening = undefined;
    }
    let messages: string[];
    try {
      messages = reader.push(chunk);
    } catch (error) {
      breakProtocol(
        `the supervisor broke the protocol: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    for (const text of messages) {
      if (phase === "done") return;
      const message = readSupervisorLine(text);
      const next =
        message === undefined ? undefined : nextPhase(phase, message.kind);
      if (message === undefined || next === undefined) {
        breakProtocol(
          `the supervisor broke the protocol: ${JSON.stringify(text)} is not allowed after phase ${phase}`
        );
        return;
      }
      phase = next;
      if (message.kind === "hello" && message.protocol !== supervisorProtocol) {
        breakProtocol(
          `the supervisor speaks protocol ${message.protocol}, this server needs ${supervisorProtocol}; build it again ("pnpm --filter @babojubot/process run build") or install the matching package`
        );
        return;
      }
      if (message.kind === "ok") reportStart({ kind: "running" });
      else if (message.kind === "failed")
        reportStart({ kind: "failed", reason: message.reason });
      else if (message.kind === "not-started") {
        const error = startError(options, message.code, message.reason);
        reportStart({ kind: "failed", reason: error.message, error });
      } else if (message.kind === "exit")
        reportExit({ code: message.code, signal: message.signal });
      else if (message.kind === "ended") reportEnd("ended");
      else if (message.kind === "left") reportEnd(`left: ${message.detail}`);
    }
  });
  // 통로의 읽기·쓰기 실패. 끝났는지는 실행기의 답과 통로의 닫힘으로 판단하고, 답 없이 닫혔으면 이 원인을 함께 알린다.
  control?.on("error", (error) => {
    controlFailure = failureCode(error);
  });
  void supervisorGone.then(() => {
    // 실행기가 답 없이 끝났다(시작 실패, 강제 종료, 약속 위반).
    reportStart({
      kind: "failed",
      reason: protocolFailure ?? "the supervisor ended before it reported",
    });
    // 실행기의 종료 코드는 프로그램의 끝이 아니다. 프로그램의 끝을 듣지 못했으면 모르는 끝이다.
    reportExit({ code: null, signal: null });
    reportEnd(undefined);
  });
  const send = (message: string) => {
    if (control && !control.destroyed && control.writable)
      control.write(encodeMessage(message));
  };
  // 프로그램이 받을 표식을 넘기고 시작을 청한다. 실행기는 이것을 받은 뒤에 프로그램을 띄운다.
  for (const [name, value] of leases) send(`env ${name}=${value}`);
  send("start");

  /**
   * 실행기가 끝난 것을 상한 안에서 확인한다. 스스로 끝나지 않으면 강제로 끝내고 다시 확인한다. 끝을 확인하지 못하면 던진다. 표식
   * 정리는 이 뒤에 한다.
   */
  const settleSupervisor = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = await Promise.race([
      supervisorGone.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), endLimitMs);
      }),
    ]);
    clearTimeout(timer);
    if (!gone) await forceEnd();
  };
  /**
   * 실행기에 끄기를 보내고 답을 기다린다. 답이 무엇이든(답이 없어도) 실행기가 끝난 것을 확인한 뒤 판단한다: 트리가 끝났다는 답과
   * 실행기의 정상 종료가 있어야 성공이다.
   */
  const stopThroughSupervisor = async (graceMs: number) => {
    // 끄기도 표의 사건이다. 지금 단계에서 끄기를 보낼 수 없으면(약속을 어겨 끝난 실행기) 보내지 않고, 답 없음으로 판단한다.
    const next = nextPhase(phase, "stop");
    if (next !== undefined) {
      phase = next;
      send(`stop ${graceMs}`);
    }
    let answer: string | undefined;
    let unanswered: unknown;
    try {
      answer = await within(
        ended,
        graceMs + supervisorStopLimitMs,
        "the supervisor did not answer the stop"
      );
    } catch (error) {
      unanswered = error;
    }
    await settleSupervisor();
    if (unanswered) throw unanswered;
    if (answer === undefined)
      throw new Error(
        `the supervisor ended without confirming that its programs ended${protocolFailure ? ` (${protocolFailure})` : ""}${controlFailure ? ` (control channel: ${controlFailure})` : ""}`
      );
    if (answer !== "ended")
      throw new Error(`programs of this tree did not end (${answer})`);
    if (supervisorExit?.code !== 0)
      throw new Error(
        `the supervisor confirmed the end but exited with ${supervisorExit?.signal ?? `code ${supervisorExit?.code}`}`
      );
  };
  /**
   * Linux·macOS: 그룹 밖(새 세션)으로 나간 자손을 표식으로 찾아 끈다. 실행기는 표식을 지니지 않고, 이것은 실행기가 끝난 뒤에 한다.
   * Linux는 실행기가 그룹 밖의 고아까지 끄므로 트리 밖으로 나간 것을 위한 둘째 겹이고, macOS는 이것이 새 세션 자손을 끄는 수단이다.
   */
  const stopMarked = async () => {
    let left: number[];
    try {
      // 실행기의 시작 시각을 읽지 못했으면 가장 넓게 본다.
      ({ left } = await stopLeaseHolders(lease, { since: since ?? 0 }));
    } catch (error) {
      throw new Error(
        "programs with this tree's marker could not be looked up",
        { cause: error }
      );
    }
    if (left.length)
      throw new Error(
        `programs with this tree's marker did not stop: ${left.join(", ")}`
      );
  };
  const stopTree = async (graceMs: number) => {
    if (pid === undefined) {
      await within(
        exited,
        endLimitMs,
        "a program that did not start did not end"
      );
      return;
    }
    // 시작 응답을 상한 없이 기다리지 않는다. 실행기는 프로그램을 띄운 직후 답한다. 답이 없으면 실행기를 끄고, 트리의 끝은 모른다고 던진다.
    let start: TreeStart;
    try {
      start = await within(
        started,
        supervisorStartLimitMs,
        "the supervisor did not report its start"
      );
    } catch (error) {
      await forceEnd();
      throw new Error(
        `the supervisor did not report its start within ${supervisorStartLimitMs} ms; it was ended, and whether its programs ended is unknown`,
        { cause: error }
      );
    }
    if (start.kind === "failed") {
      await settleSupervisor();
      await within(
        exited,
        endLimitMs,
        "a program that did not start did not end"
      );
      return;
    }
    // 실행기의 끄기와 표식 정리는 차례로 한다: 실행기의 끝을 확인(필요하면 강제로 끝냄)한 뒤에 표식을 찾는다. 실행기가 트리의 끝을
    // 확인하지 못해도 표식 정리는 하고, 두 실패를 모아 함께 던진다. Windows는 묶음이 트리 전체라 표식 정리가 없다.
    await attemptAll(
      [
        () => stopThroughSupervisor(graceMs),
        ...(windows() ? [] : [stopMarked]),
      ],
      "this tree did not stop"
    );
    // 트리가 끝났으면 대표도 끝났다. 그 끝(exit)이 전달될 때까지 기다린다.
    await within(exited, endLimitMs, `the program did not report its end`);
  };
  let stopping: Promise<void> | undefined;

  const tree: LaunchedTree = {
    pid,
    lease,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    started,
    exited,
    interrupt: () => {
      if (!leaderDone) send("interrupt");
    },
    killLeader: () => {
      if (!leaderDone) send("kill-leader");
    },
    stop: (stopOptions) => {
      if (!stopping) {
        stopping = stopTree(stopOptions?.graceMs ?? 2000);
        // 부른 쪽이 결과를 받는다. 끄기를 먼저 시작하고 결과는 나중에 받는 쪽(제품의 정리)도 있어 처리되지 않은 거부로 두지 않는다.
        void settled(stopping);
      }
      return stopping;
    },
  };
  return { tree, abandon: forceEnd };
}
