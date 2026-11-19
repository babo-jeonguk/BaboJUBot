import spawn from "cross-spawn";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable, type Duplex } from "node:stream";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  settled,
} from "@babojubot/contracts";
import {
  jobObjectLaunch,
  jobObjectProblem,
  readLauncherStatus,
} from "./job-object.ts";
import { processStartTicks, stopLeaseHolders, withLease } from "./lease.ts";
import { interruptProcessGroup, stopProcessGroup } from "./recovery.ts";

export { prepareJobObjectLauncher } from "./job-object.ts";

/**
 * 공용 실행(#262). 프로그램을 띄우면서, 그렇게 띄운 프로그램과 그 자손 전체(트리)를 끄는 `stop()`을 함께 돌려준다.
 * 띄우는 방법과 끄는 방법은 한 쌍이라 따로 쓰지 않는다. 오래 도는 자식은 제품 코드·개발 스크립트 모두 이것으로 띄운다(lint).
 *
 * | 시스템 | 띄울 때 | `stop()` |
 * | --- | --- | --- |
 * | Linux·macOS | 자기 프로세스 그룹으로 띄우고 환경에 표식(lease)을 붙인다 | 그룹을 끄고(SIGTERM·유예·SIGKILL), 새 세션으로 그룹을 빠져나간 자손은 표식으로 찾아 끈다 |
 * | Windows | 묶음 실행기(Job Object, job-object.ts)로 띄운다 | 실행기에 끄기를 보내고, 묶음 안에 남은 프로세스 수가 0이 된 것을 실행기의 답으로 확인한다 |
 *
 * `stop()`은 트리 전체가 끝난 것을 상한 안에서 확인하고, 확인하지 못하면 원인과 함께 던진다. 확인은 번호(pid)를 나중에 다시
 * 보는 대신 그룹·표식·묶음의 남은 수로 한다(번호는 재사용된다, #259). 대표가 먼저 끝나도 그 자손은 `stop()`까지 남는다(모든 시스템이
 * 같다). 그래서 띄운 쪽은 대표가 끝났든 아니든 언제나 `stop()`으로 끝낸다.
 *
 * Windows에서 묶음 실행기를 쓸 수 없으면(준비하지 못함, 이 프로세스가 준비하지 않음) 띄우지 않고 무엇이 없었는지 담은
 * `TreeLaunchRefused`를 던진다. 묶음 없이 띄우는 길은 두지 않는다(#262 사용자 결정, 제품의 실행 시도와 작업자 실행기 모두). 그 길의
 * 끄기는 대표의 끝만 확인할 수 있어 트리 전체의 끝을 약속하는 `stop()`과 맞지 않는다.
 */

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
  /** 대표의 번호. Windows 묶음 실행이면 실행기의 번호다. 시작하지 못했으면 없다. */
  pid: number | undefined;
  /** 이 트리의 표식. 서버 재시작 뒤 복구 기록에 남긴다. */
  lease: string;
  stdin: In;
  stdout: Out;
  stderr: Out;
  started: Promise<TreeStart>;
  /** 대표가 끝났다. 시작하지 못했어도 이행한다. 자손은 `stop()`까지 남는다. */
  exited: Promise<TreeExit>;
  /** 대표의 그룹에 중단(SIGINT)을 보낸다. 끄기가 아니다. Windows에는 없다. */
  interrupt(): void;
  /** 사고 재현용: 대표만 강제로 끝낸다. 자손은 남고 `stop()`이 끈다. 끄기 대신 쓰지 않는다. */
  killLeader(): void;
  /**
   * 트리 전체를 끄고 끝난 것을 상한 안에서 확인한다. 확인하지 못하면 원인과 함께 던진다. 여러 번 불러도 한 번만 끄고 같은 결과를
   * 돌려준다. `graceMs`는 SIGTERM 뒤 스스로 끝나기를 기다리는 시간이다(첫 부름의 값만 쓴다. Windows는 바로 끈다).
   */
  stop(options?: { graceMs?: number }): Promise<void>;
};

/**
 * Windows에서 묶음 실행기를 쓸 수 없어 프로그램을 띄우지 않았다. 문구는 제품이 쓴 안내라 실행 시도의 실패 원인으로 그대로 보인다
 * (서버 dispatcher). 무엇이 없어 준비하지 못했는지를 담는다.
 */
export class TreeLaunchRefused extends Error {
  override name = "TreeLaunchRefused";
}

/**
 * Windows에서 묶음 실행기를 쓸 수 없으면 그 이유와 함께 `TreeLaunchRefused`를 던진다. 다른 시스템에서는 아무것도 하지 않는다.
 * 띄우기 전에 다른 자원(격리 실행의 중계)을 여는 쪽은 그 전에 부른다.
 */
export function requireJobObject() {
  if (!windows()) return;
  const problem = jobObjectProblem();
  if (problem !== undefined) throw refusedFor(problem);
}

const refusedFor = (problem: string) =>
  new TreeLaunchRefused(
    `Windows 정리 장치(Job Object)를 준비하지 못해 프로그램을 시작하지 않았습니다. 이유: ${problem}`
  );

/** 실행기가 끄기를 받고 묶음을 비웠다고 답할 때까지의 상한. 실행기가 묶음을 기다리는 10초에 여유를 둔다. */
const launcherStopLimitMs = 20_000;
/** 대표가 끝난 뒤 남은 출력을 읽을 시간. 출력을 물려받은 자손이 쥐고 있으면 이만큼만 기다리고 트리를 끈다. */
const exitDrainMs = 1000;
/** 묶음 없는 Windows에서 대표가 끝나기를 기다리는 상한. */
const leaderStopLimitMs = 10_000;

const windows = () => process.platform === "win32";

/** `promise`를 `ms` 안에 기다린다. 넘기면 `what`과 함께 던진다. */
async function within<T>(promise: Promise<T>, ms: number, what: string) {
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

/**
 * 찾지 못한 프로그램(Windows). 아무것도 띄우지 않고 cross-spawn과 같은 시작 오류(ENOENT)로 끝난 트리를 돌려준다. cross-spawn은 이때
 * cmd.exe를 묶음 밖에서 띄우므로 쓰지 않는다.
 */
function missingProgram(options: TreeLaunch, lease: string): LaunchedTree {
  const [command] = options.command;
  const error = Object.assign(new Error(`spawn ${command} ENOENT`), {
    code: "ENOENT",
    errno: "ENOENT",
    syscall: `spawn ${command}`,
    path: command,
    spawnargs: [...options.command.slice(1), ...options.args],
  });
  const stdio =
    options.stdio === "pipe" ? ["pipe", "pipe", "pipe"] : options.stdio;
  const closedOutput = (kind: unknown) =>
    kind === "pipe" ? Readable.from([]) : null;
  return {
    pid: undefined,
    lease,
    stdin:
      stdio[0] === "pipe"
        ? new Writable({ write: (_chunk, _encoding, done) => done() })
        : null,
    stdout: closedOutput(stdio[1]),
    stderr: closedOutput(stdio[2]),
    started: Promise.resolve({ kind: "failed", reason: error.message, error }),
    exited: Promise.resolve({ code: null, signal: null }),
    interrupt: () => {},
    killLeader: () => {},
    stop: () => Promise.resolve(),
  };
}

export function launchTree(
  options: TreeLaunch & { stdio: "pipe" }
): LaunchedTree<Writable, Readable>;
export function launchTree(options: TreeLaunch): LaunchedTree;
export function launchTree(options: TreeLaunch): LaunchedTree {
  const lease = randomUUID();
  const env = withLease(options.env, lease);
  const stdio =
    options.stdio === "pipe"
      ? (["pipe", "pipe", "pipe"] as const)
      : options.stdio;
  let child: ChildProcess;
  let control: Duplex | undefined;
  if (windows()) {
    const job = jobObjectLaunch(options.command, options.args, {
      env: options.env,
      cwd: options.cwd,
    });
    if (job.kind === "not-found") return missingProgram(options, lease);
    if (job.kind === "unavailable") throw refusedFor(job.reason);
    // 실행기를 띄우지 못하면(백신이 지웠거나 막음) 프로그램은 시작하지 않은 채 시작 실패로 끝난다(아래 error).
    child = spawnChild(job.launch.file, job.launch.args, {
      ...job.launch.options,
      cwd: options.cwd,
      env,
      stdio: [...stdio, "pipe"],
      windowsHide: true,
    });
    control = (child.stdio[3] ?? undefined) as Duplex | undefined;
  } else
    child = spawn(
      options.command[0],
      [...options.command.slice(1), ...options.args],
      {
        cwd: options.cwd,
        env,
        stdio: [...stdio],
        // 자기 프로세스 그룹.
        detached: true,
      }
    );
  const pid = child.pid;
  // 표식을 읽을 수 없는 프로그램은 이 트리가 시작한 뒤에 생겼을 때만 우리 것일 수 있다. 대표의 시작 시각을 기준으로 둔다(Linux).
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
    // 띄운 뒤의 오류(신호를 보내지 못함 등)는 끝남이 아니다. 끝났는지는 stop()이 확인한다.
    if (pid !== undefined) return;
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
  let launcherExit: TreeExit | undefined;
  /** 제어 통로가 실패했으면 그 오류 이름. */
  let controlFailure: string | undefined;
  let controlClosed!: () => void;
  const launcherGone = Promise.all([
    new Promise<void>((resolve) => {
      controlClosed = resolve;
    }),
    new Promise<void>((resolve) =>
      child.once("exit", (code, signal) => {
        launcherExit = { code, signal };
        resolve();
      })
    ),
  ]);
  if (control) {
    let pending = "";
    control.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, newline).trimEnd();
        pending = pending.slice(newline + 1);
        const status = readLauncherStatus(line);
        if (status?.kind === "ok") reportStart({ kind: "running" });
        else if (status?.kind === "failed")
          reportStart({ kind: "failed", reason: status.reason });
        else if (/^exit -?\d+$/.test(line))
          reportExit({ code: Number(line.slice(5)), signal: null });
        else if (line === "ended" || line.startsWith("left: ")) reportEnd(line);
      }
    });
    // 통로의 읽기·쓰기 실패. 끝났는지는 실행기의 답과 통로의 닫힘으로 판단하고, 답 없이 닫혔으면 이 원인을 함께 알린다.
    control.on("error", (error) => {
      controlFailure = failureCode(error);
    });
    control.once("close", () => controlClosed());
    void launcherGone.then(() => {
      // 실행기가 답 없이 끝났다(시작 실패, 강제 종료).
      reportStart({
        kind: "failed",
        reason: "the job object launcher ended before it reported",
      });
      reportExit(launcherExit ?? { code: null, signal: null });
      reportEnd(undefined);
    });
  } else {
    controlClosed();
    child.once("spawn", () => reportStart({ kind: "running" }));
    child.once("exit", (code, signal) => reportExit({ code, signal }));
  }
  const send = (command: string) => {
    if (control && !control.destroyed && control.writable)
      control.write(`${command}\n`);
  };

  /** Windows 묶음 실행기: 끄기를 보내고 묶음이 비었다는 답과 실행기의 끝을 기다린다. */
  const stopThroughLauncher = async () => {
    send("stop");
    const end = await within(
      ended,
      launcherStopLimitMs,
      "the job object launcher did not answer the stop"
    );
    if (end === undefined)
      throw new Error(
        `the job object launcher ended without confirming that its programs ended${controlFailure ? ` (control channel: ${controlFailure})` : ""}`
      );
    if (end !== "ended")
      throw new Error(`programs in the job object did not end (${end})`);
    await within(
      launcherGone,
      leaderStopLimitMs,
      "the job object launcher did not exit"
    );
  };
  /** Linux·macOS: 그룹 밖(새 세션)으로 나간 자손을 표식으로 찾아 끈다. */
  const stopMarked = async () => {
    let left: number[];
    try {
      // 대표의 시작 시각을 읽지 못했으면 가장 넓게 본다.
      ({ left } = await stopLeaseHolders(lease, { since: since ?? 0 }));
    } catch (error) {
      throw new Error(
        "programs with this tree's marker could not be looked up",
        {
          cause: error,
        }
      );
    }
    if (left.length)
      throw new Error(
        `programs with this tree's marker did not stop: ${left.join(", ")}`
      );
  };
  const stopTree = async (graceMs: number) => {
    const start = await started;
    if (start.kind === "failed" || pid === undefined) {
      await within(
        exited,
        leaderStopLimitMs,
        "a program that did not start did not end"
      );
      return;
    }
    // Windows에는 그룹이 없어 바로 돌아온다.
    try {
      await stopProcessGroup(pid, { graceMs });
    } catch (error) {
      throw new Error(`the process group of ${pid} did not stop`, {
        cause: error,
      });
    }
    // Windows는 묶음 실행기로만 띄운다. 통로가 없으면 끝을 확인할 수 없어 stopThroughLauncher가 던진다.
    if (windows()) await stopThroughLauncher();
    else await stopMarked();
    // 그룹이 끝났으면 대표도 끝났다. 그 끝(exit)이 전달될 때까지 기다린다.
    await within(
      exited,
      leaderStopLimitMs,
      `process ${pid} did not report its end`
    );
  };
  let stopping: Promise<void> | undefined;

  return {
    pid,
    lease,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    started,
    exited,
    interrupt: () => {
      if (pid !== undefined && !leaderDone) interruptProcessGroup(pid);
    },
    killLeader: () => {
      if (control) return send("kill-leader");
      if (pid === undefined || leaderDone) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!hasErrorCode("ESRCH")(error)) throw error;
      }
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
}

/** 끝까지 돌린 트리의 결과. `stopped`는 끝나기 전에 끈 이유다. */
export type TreeRun =
  | { started: false; error: unknown; reason: string }
  | {
      started: true;
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: Buffer;
      stderr: Buffer;
      stopped?: "limit" | "aborted" | "output";
    };

/**
 * 짧은 명령을 공용 실행으로 끝까지 돌린다(비동기). 상한(`limitMs`)이나 취소(`signal`), 출력 상한(`overflow: "stop"`)에 닿으면 트리를
 * 끈다. 대표가 스스로 끝나도 남은 자손을 끈다. 어느 경우든 트리 전체가 끝난 것을 확인한 뒤 돌려주고, 확인하지 못하면 던진다.
 * 출력은 각각 `maxOutputBytes`까지 모은다(`overflow: "truncate"`는 넘는 부분만 버리고 계속 돈다).
 */
export async function runTree(
  options: Omit<TreeLaunch, "stdio"> & {
    limitMs: number;
    signal?: AbortSignal;
    maxOutputBytes: number;
    overflow: "stop" | "truncate";
  }
): Promise<TreeRun> {
  const tree = launchTree({ ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stopped: "limit" | "aborted" | "output" | undefined;
  const stopFor = (reason: "limit" | "aborted" | "output") => {
    if (stopped) return;
    stopped = reason;
    // 결과는 아래에서 같은 stop()을 기다려 받는다.
    void settled(tree.stop());
  };
  const collect = (stream: Readable) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      const room = options.maxOutputBytes - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = options.maxOutputBytes;
        if (options.overflow === "stop") stopFor("output");
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    const closed = new Promise<void>((resolve) =>
      stream.once("close", resolve)
    );
    return { closed, bytes: () => Buffer.concat(chunks) };
  };
  const stdout = collect(tree.stdout!);
  const stderr = collect(tree.stderr!);
  const timer = setTimeout(() => stopFor("limit"), options.limitMs);
  const abort = () => stopFor("aborted");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const start = await tree.started;
    if (start.kind === "failed") {
      await tree.stop();
      return { started: false, error: start.error, reason: start.reason };
    }
    const exit = await tree.exited;
    // 대표가 끝났다. 남은 출력을 읽을 시간만 두고 트리를 끈다. 출력을 물려받은 자손이 남으면 출력은 그 자손이 끝나야 닫힌다.
    let drain: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([stdout.closed, stderr.closed]),
      new Promise<void>((resolve) => {
        drain = setTimeout(resolve, exitDrainMs);
      }),
    ]);
    clearTimeout(drain);
    await tree.stop();
    // 트리가 끝났으니 출력은 곧 닫힌다. 묶음 없는 Windows에서 모르는 자손이 출력을 쥐고 있으면 닫히지 않으므로 기다림에 끝을 둔다.
    await continueAfterFailure(
      () =>
        within(
          Promise.all([stdout.closed, stderr.closed]).then(() => undefined),
          leaderStopLimitMs,
          "the output did not close"
        ),
      () => {
        tree.stdout!.destroy();
        tree.stderr!.destroy();
      }
    );
    return {
      started: true,
      code: exit.code,
      signal: exit.signal,
      stdout: stdout.bytes(),
      stderr: stderr.bytes(),
      ...(stopped ? { stopped } : {}),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
