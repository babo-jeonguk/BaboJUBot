import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { settled } from "@babojubot/contracts";
import {
  endLimitMs,
  startError,
  superviseTree,
  within,
  type LaunchedTree,
  type TreeLaunch,
} from "./supervised.ts";
import { ForeignMarker } from "./lease.ts";
import { supervisorLaunch, supervisorProblem } from "./supervisor.ts";

export { prepareSupervisor } from "./supervisor.ts";
export type {
  LaunchedTree,
  TreeExit,
  TreeLaunch,
  TreeStart,
  TreeStdio,
} from "./supervised.ts";

/**
 * 공용 실행(#262). 프로그램을 띄우면서, 그렇게 띄운 프로그램과 그 자손 전체(트리)를 끄는 `stop()`을 함께 돌려준다.
 * 띄우는 방법과 끄는 방법은 한 쌍이라 따로 쓰지 않는다. 오래 도는 자식은 제품 코드·개발 스크립트 모두 이것으로 띄운다(lint).
 *
 * 세 OS 모두 실행 시도마다 감독 실행기(`supervisor.ts`) 하나가 프로그램을 띄우고 그 트리를 쥔다(#268). 실행기를 띄우고 넷째 표준
 * 핸들의 제어 통로로 말하는 일은 `supervised.ts`가 맡고(준비의 시험 실행도 같은 코드), 서버가 사라져 통로가 끝나면 실행기가 스스로 트리를 끈다.
 *
 * | 시스템 | 실행기가 쥐는 것 | `stop()` |
 * | --- | --- | --- |
 * | Linux·macOS | 프로그램의 프로세스 그룹(마지막 신호까지 프로그램을 거두지 않아 그 번호가 다른 프로세스에 가지 않는다). 환경에는 표식(lease) | 실행기가 그룹을 끄고(SIGTERM·유예·SIGKILL, Linux는 그룹 밖으로 나간 고아도) 끝을 확인해 답하고 끝난 뒤, 새 세션으로 그룹을 빠져나간 자손은 표식으로 찾아 끈다(Linux는 둘째 겹) |
 * | Windows | 프로그램을 넣은 묶음(Job Object) | 실행기가 묶음을 끄고, 묶음 안에 남은 프로세스 수가 0이 된 것을 답한다 |
 *
 * `stop()`은 트리 전체가 끝난 것을 상한 안에서 확인하고, 확인하지 못하면 원인과 함께 던진다. 확인은 번호(pid)를 나중에 다시
 * 보는 대신 그룹·표식·묶음의 남은 수로 한다(번호는 재사용된다, #259). 대표가 먼저 끝나도 그 자손은 `stop()`까지 남는다(모든 시스템이
 * 같다). 그래서 띄운 쪽은 대표가 끝났든 아니든 언제나 `stop()`으로 끝낸다.
 *
 * 실행기를 쓸 수 없으면(준비하지 못함, 이 프로세스가 준비하지 않음) 띄우지 않고 무엇이 없었는지 담은 `TreeLaunchRefused`를 던진다.
 * 실행기 없이 띄우는 길은 두지 않는다(#262·#268 사용자 결정). 그 길의 끄기는 서버가 죽었을 때 트리를 끄지 못하고, 번호로 찾아 끄는
 * 복구를 남긴다.
 */

/**
 * 감독 실행기를 쓸 수 없어 프로그램을 띄우지 않았다. 문구는 제품이 쓴 안내라 실행 시도의 실패 원인으로 그대로 보인다
 * (서버 dispatcher). 무엇이 없어 준비하지 못했는지를 담는다.
 */
export class TreeLaunchRefused extends Error {
  override name = "TreeLaunchRefused";
}

/**
 * 감독 실행기를 쓸 수 없으면 그 이유와 함께 `TreeLaunchRefused`를 던진다. 띄우기 전에 다른 자원(격리 실행의 중계)을 여는 쪽은
 * 그 전에 부른다.
 */
export function requireSupervisor() {
  const problem = supervisorProblem();
  if (problem !== undefined) throw refusedFor(problem);
}

const refusedFor = (problem: string) =>
  new TreeLaunchRefused(
    `감독 실행기를 준비하지 못해 프로그램을 시작하지 않았습니다. 이유: ${problem}`
  );

/**
 * 찾지 못한 프로그램(Windows). 아무것도 띄우지 않고 cross-spawn과 같은 시작 오류(ENOENT)로 끝난 트리를 돌려준다.
 */
function missingProgram(options: TreeLaunch, lease: string): LaunchedTree {
  const error = startError(options, "ENOENT");
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
    supervisorStart: Promise.resolve(undefined),
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
  const supervised = supervisorLaunch(options.command, options.args, {
    env: options.env,
    cwd: options.cwd,
  });
  if (supervised.kind === "not-found") return missingProgram(options, lease);
  if (supervised.kind === "unavailable") throw refusedFor(supervised.reason);
  try {
    return superviseTree(supervised.launch, options, lease).tree;
  } catch (error) {
    if (error instanceof ForeignMarker)
      throw new TreeLaunchRefused(
        `실행 시도의 표식이 이 제품이 만든 모양이 아니라 프로그램을 시작하지 않았습니다. 이유: ${error.message}`
      );
    throw error;
  }
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
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const stopFor = (reason: "limit" | "aborted" | "output") => {
    if (stopped) return;
    stopped = reason;
    requestStop();
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
    // 대표가 끝나거나 끄기를 시작할 때까지 기다린다. 끄기를 시작했으면 그 끝은 대표가 아니라 끄기의 결과가 정한다: 트리가 끝나지
    // 않으면 끄기가 상한 뒤 원인과 함께 던지고, 이 실행도 그 원인으로 끝난다. 대표가 먼저 끝났으면 상한은 더 쓰지 않고 바로 남은
    // 트리를 끈다. 출력을 물려받은 자손이 남았어도 출력이 닫히기를 시간으로 기다리지 않는다(#268).
    await Promise.race([tree.exited, stopRequested]);
    clearTimeout(timer);
    await tree.stop();
    // 끄기가 끝났으면 시작 결과와 대표의 끝은 이미 알려졌다.
    const start = await tree.started;
    if (start.kind === "failed")
      return { started: false, error: start.error, reason: start.reason };
    const exit = await tree.exited;
    // 트리가 끝났으니 출력을 쥔 프로그램도 없다. 출력은 곧 닫히고, 닫힐 때까지 읽는다(줄바꿈 없는 마지막 출력 포함). 닫히지 않으면
    // 트리 밖의 누군가가 출력을 쥔 것이라 실패로 알린다.
    try {
      await within(
        Promise.all([stdout.closed, stderr.closed]).then(() => undefined),
        endLimitMs,
        "the output did not close after the tree ended"
      );
    } catch (error) {
      tree.stdout!.destroy();
      tree.stderr!.destroy();
      throw error;
    }
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
