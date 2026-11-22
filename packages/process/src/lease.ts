import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfProbeFailed,
  settled,
} from "@babojubot/contracts";
import { runCommand } from "./bounded-command.ts";
import { type Clock, realClock } from "./clock.ts";
import { statFields, statRuns } from "./proc-stat.ts";

/**
 * 실행 시도의 표식. 실행 시도마다 고유한 값을 프로그램 환경에 넣으면 그 자손이 모두 물려받는다.
 * Claude Code·Codex·Antigravity는 셸 명령을 새 세션에 띄우므로, 프로그램이 갑자기 죽으면 프로세스 그룹으로는 그 명령에 닿지 못하고 이 표식으로만 찾는다(#219).
 *
 * 알려진 한계: 표식 변수를 일부러 지운 프로그램은 찾지 못한다. 환경을 읽을 수 없게 막은 프로그램(Linux에서 dump 불가로 바꾼 프로그램 등)은
 * 대표가 시작한 뒤 서버와 같은 cgroup에 생겼으면 확인하지 못한 것(`unverified`)으로 남아 정리가 실패하고(신호는 보내지 않는다), 그 전에 있던 것과 다른 cgroup의 것은 무시한다.
 * 같은 cgroup에 실행 중 생긴 관계없는 프로그램도 확인하지 못한 것으로 본다. macOS에서는 그런 프로그램이 아예 보이지 않는다(`ps`가 환경을 보여주지 않는다).
 * 대신 표식이 보이는데 세 조회 사이에 실행 인자가 바뀌어 환경 변수 부분을 확인할 수 없는 프로그램은 확인하지 못한 것으로 남는다(신호는 보내지 않는다).
 * 끝까지 확인할 수 없으면 정리가 실패한다.
 */
export const leaseVariable = "BABOJUBOT_PROCESS_LEASE";
export const leaseEntry = (lease: string) => `${leaseVariable}=${lease}`;
/**
 * 표식 변수 이름. 실행 시도 안에서 다시 띄운 트리(작업자가 돌리는 시험, 기록 중계 등)는 바깥 트리의 표식을 지운 채 새 표식만
 * 가지면 바깥 트리의 끄기가 그 트리에 닿지 못한다. 그래서 띄우는 쪽이 가진 표식을 모두 물려주고 새 표식은 다음 번호의 이름에 둔다.
 * 첫째 이름은 예전 기록·시험과 같은 `BABOJUBOT_PROCESS_LEASE`다.
 */
const leaseName = (index: number) =>
  index === 0 ? leaseVariable : `${leaseVariable}_${index}`;
const leaseNamePattern = new RegExp(`^${leaseVariable}(?:_\\d+)?$`);
/** 환경 항목 하나(`이름=값`)가 이 표식인가. 표식 변수 이름 가운데 하나에 값이 정확히 같아야 한다. */
export function isLeaseEntry(entry: string, lease: string) {
  const equals = entry.indexOf("=");
  return (
    equals > 0 &&
    leaseNamePattern.test(entry.slice(0, equals)) &&
    entry.slice(equals + 1) === lease
  );
}
/** 환경에 든 표식 값. */
const leasesIn = (env: NodeJS.ProcessEnv) =>
  Object.entries(env).flatMap(([name, value]) =>
    leaseNamePattern.test(name) && value ? [value] : []
  );
/**
 * 새로 띄울 트리의 환경. `env`의 표식 변수는 빼고, `env`와 이 프로세스(`own`, 기본은 지금 환경)가 가진 표식을 앞 번호에,
 * 새 표식 `lease`를 마지막 번호에 둔다. 그래서 이 트리의 자손은 바깥 트리들의 표식도 함께 가진다.
 */
export function withLease(
  env: NodeJS.ProcessEnv,
  lease: string,
  own: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const outer = [...new Set([...leasesIn(own), ...leasesIn(env)])].filter(
    (value) => value !== lease
  );
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !leaseNamePattern.test(name))
    ),
    ...Object.fromEntries(
      [...outer, lease].map((value, index) => [leaseName(index), value])
    ),
  };
}

/** 이 제품이 만드는 표식의 모양(`randomUUID`). */
const markerForm =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 물려받은 표식이 이 제품이 만든 모양이 아니다(개행 등). 그 값은 넘기지 않는다. */
export class ForeignMarker extends Error {
  override name = "ForeignMarker";
}

/**
 * 새로 띄울 트리의 환경을 표식과 나머지로 나눈다(표식은 `withLease`와 같다). 감독 실행기는 나머지만 받아 표식을 지니지 않고, 표식은
 * 제어 통로로 받아 프로그램에만 준다. 그래서 표식 정리가 트리의 관리자인 실행기에 닿지 않는다(#268).
 */
export function leaseEnvironment(
  env: NodeJS.ProcessEnv,
  lease: string,
  own: NodeJS.ProcessEnv = process.env
) {
  const full = withLease(env, lease, own);
  const leases = Object.entries(full).flatMap(([name, value]) =>
    leaseNamePattern.test(name) && value !== undefined
      ? [[name, value] as const]
      : []
  );
  // 표식은 제어 통로의 메시지로 넘긴다. 바깥에서 물려받은 값도 이 제품이 만든 모양이어야 한다(#274 외부 리뷰 2회차 SPEC-3).
  for (const [name] of leases.filter(([, value]) => !markerForm.test(value)))
    throw new ForeignMarker(
      `the inherited run marker ${name} is not in the form this product writes`
    );
  const rest = Object.fromEntries(
    Object.entries(full).filter(([name]) => !leaseNamePattern.test(name))
  );
  return { env: rest, leases };
}

/** 끝났거나(ENOENT·ESRCH) 다른 사용자의 것이라 읽을 수 없는(EACCES·EPERM) 프로세스의 /proc 읽기 오류. */
const unreadable = hasErrorCode("ENOENT", "ESRCH", "EACCES", "EPERM");

/** Linux: 프로세스 시작 시각(부팅 뒤 clock tick, /proc/<pid>/stat 22번째 칸). 그 밖의 시스템이거나 끝난 프로세스면 undefined. 읽지 못하면 원인을 남기고 undefined. */
export function processStartTicks(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  // 끝난 프로세스는 시작 시각이 없다(답이다). 그 밖의 읽기 실패는 원인을 남기고 모르는 것으로 본다.
  const stat = orIfProbeFailed(
    () =>
      orIfMissing(
        () => readFileSync(`/proc/${pid}/stat`, "utf8"),
        hasErrorCode("ENOENT", "ESRCH"),
        undefined
      ),
    undefined,
    (error) =>
      console.warn(
        `[provider] could not read the start time of process ${pid} (${failureCode(error)})`
      )
  );
  if (stat === undefined) return undefined;
  const start = Number(statFields(stat)[19]);
  return Number.isFinite(start) ? start : undefined;
}

/** Linux: 환경 변수 항목 하나가 표식과 정확히 같은가. 끝났거나 읽을 수 없는 프로세스(다른 사용자 등)는 아니다. */
export async function holdsLease(pid: number, lease: string) {
  let environment: string;
  try {
    // 환경 변수에는 UTF-8이 아닌 바이트도 올 수 있다. 바이트를 그대로 옮기는 latin1로 읽는다(표식은 ASCII다).
    environment = await readFile(`/proc/${pid}/environ`, "latin1");
  } catch (e) {
    if (unreadable(e)) return false;
    throw e;
  }
  return environment.split("\0").some((entry) => isLeaseEntry(entry, lease));
}

/** 찾은 결과. `holders`는 표식을 확인한 프로그램, `unverified`는 우리 것일 수 있지만 환경을 읽을 수 없어 확인하지 못한 프로그램이다. */
export type LeaseLookup = { holders: number[]; unverified: number[] };

/** Linux: 환경을 읽지 못한 프로세스가 이 실행 시도 뒤에 생긴 같은 사용자의 산 프로세스인가. 끝났거나 다른 사용자의 것이면 아니다. 같은 사용자의 것을 끝까지 확인하지 못하면 던진다(정리가 실패로 드러난다). */
async function mayBeOurs(
  pid: number,
  since: number,
  serverCgroup: string | undefined
) {
  if (serverCgroup === undefined) return false;
  // 다른 사용자의 프로세스는 상태를 읽지 못할 수 있다(hidepid). 끝났거나 그런 프로세스는 우리 것이 아니다.
  const status = await orIfMissing(
    () => readFile(`/proc/${pid}/status`, "utf8"),
    unreadable,
    undefined
  );
  if (status === undefined) return false;
  const uid = /^Uid:\s+(\d+)/m.exec(status);
  if (!uid || Number(uid[1]) !== process.getuid!()) return false;
  // 같은 사용자의 것이다. 그사이 끝났으면 아니고, 그 밖의 읽기 실패는 던진다.
  const gone = hasErrorCode("ENOENT", "ESRCH");
  const stat = await orIfMissing(
    () => readFile(`/proc/${pid}/stat`, "utf8"),
    gone,
    undefined
  );
  if (stat === undefined) return false;
  const fields = statFields(stat);
  // 끝났지만 거두어지지 않은 프로세스(마지막 스레드까지 끝난 좀비)는 산 것이 아니다.
  if (!statRuns(fields)) return false;
  const start = Number(fields[19]);
  if (!Number.isFinite(start) || start < since) return false;
  // 실행 시도의 자손은 서버의 cgroup을 물려받는다. 다른 cgroup(데스크톱 앱·systemd 서비스)의 프로그램은 우리 것이 아니다.
  const cgroup = await orIfMissing(
    () => readFile(`/proc/${pid}/cgroup`, "utf8"),
    gone,
    undefined
  );
  return cgroup === serverCgroup;
}

async function linuxHolders(
  lease: string,
  since?: number
): Promise<LeaseLookup> {
  const holders: number[] = [];
  const unverified: number[] = [];
  // 서버의 cgroup은 확인이 필요할 때 한 번만 읽는다.
  let serverCgroup: Promise<string | undefined> | undefined;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let environment: string;
    try {
      // 환경 변수에는 UTF-8이 아닌 바이트도 올 수 있다. 바이트를 그대로 옮기는 latin1로 읽는다(표식은 ASCII다).
      environment = await readFile(`/proc/${pid}/environ`, "latin1");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      if (code !== "EACCES" && code !== "EPERM") throw e;
      // 환경을 읽지 못했다. 이 실행 시도 뒤에 생긴 같은 사용자의 산 프로세스면 우리 것일 수 있다.
      if (since !== undefined) {
        // cgroup을 끈 커널에는 서버의 cgroup이 없어 견줄 것이 없으므로 확인하지 않는다. 그 밖의 읽기 실패는 던진다.
        serverCgroup ??= orIfMissing(
          () => readFile("/proc/self/cgroup", "utf8"),
          hasErrorCode("ENOENT"),
          undefined
        );
        if (await mayBeOurs(pid, since, await serverCgroup))
          unverified.push(pid);
      }
      continue;
    }
    if (environment.split("\0").some((entry) => isLeaseEntry(entry, lease)))
      holders.push(pid);
  }
  return { holders, unverified };
}

/** `ps` 목록. 시한(15초)에 끝을 보장하고(`runCommand`), 끝나지 않거나 실패하면 던진다. 공용 실행의 끄기가 쓰는 조회라 그 위에 놓지 않는다. */
const ps = async (extra: string[]) => {
  const result = await runCommand(
    "ps",
    ["-A", "-ww", ...extra, "-o", "pid=,command="],
    {
      env: { ...process.env, LC_ALL: "C" },
      maxOutputBytes: 64 * 1024 * 1024,
      limitMs: 15_000,
    }
  );
  if (result.killed || result.code !== 0)
    throw new Error(
      `ps ended with ${result.killed ? "its time limit" : (result.signal ?? `code ${result.code}`)}`
    );
  return result.stdout;
};

/** `ps -o pid=,command=` 출력의 번호별 줄. */
function byPid(listing: string) {
  const lines = new Map<number, string>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) lines.set(Number(match[1]), match[2]!);
  }
  return lines;
}

/**
 * macOS: 같은 목록을 환경 변수 없이(`before`)와 있이(`withEnvironment`), 다시 없이(`after`) 받아, 실행 인자 뒤에 붙은 환경 변수 부분만 공백으로 나눠 정확히 비교한다.
 * `-E` 줄에 표식 문자열이 없으면 우리 것이 아니다. 앞·뒤 두 조회의 실행 인자가 같고 `-E` 줄이 그 실행 인자와 공백 경계에서 이어질 때만 그 뒤를 환경 변수로 보고,
 * 그 안에 표식이 있으면 `holders`에 넣는다. 확인할 수 없으면 `unverified`에 넣는다(실행 인자에만 있는 표식과 환경에 있는 표식을 가릴 수 없다).
 * 확인하지 못한 프로그램에는 신호를 보내지 않고 다음 조회에서 다시 본다.
 */
export function lookupInPs(
  before: string,
  withEnvironment: string,
  after: string,
  lease: string
): LeaseLookup {
  const plainBefore = byPid(before);
  const plainAfter = byPid(after);
  const holders: number[] = [];
  const unverified: number[] = [];
  const marked = (text: string) =>
    text.split(/\s+/).some((token) => isLeaseEntry(token, lease));
  for (const [pid, line] of byPid(withEnvironment)) {
    if (!marked(line)) continue;
    const command = plainBefore.get(pid);
    const confirmed =
      command !== undefined &&
      plainAfter.get(pid) === command &&
      line.startsWith(command + " ");
    if (!confirmed) {
      unverified.push(pid);
      continue;
    }
    if (marked(line.slice(command.length + 1))) holders.push(pid);
  }
  return { holders, unverified };
}

/** 이 표식을 가진 프로그램과, 우리 것일 수 있지만 확인하지 못한 프로그램(서버 자신 제외). 조회 자체가 실패하면(`/proc`·`ps`를 읽지 못함) 던진다. */
export async function leaseHolders(
  lease: string,
  { since }: { since?: number } = {}
): Promise<LeaseLookup> {
  const found: LeaseLookup =
    process.platform === "linux"
      ? await linuxHolders(lease, since)
      : lookupInPs(await ps([]), await ps(["-E"]), await ps([]), lease);
  return {
    holders: found.holders.filter((pid) => pid !== process.pid),
    unverified: found.unverified.filter((pid) => pid !== process.pid),
  };
}

const send = (pids: number[], signal: NodeJS.Signals) => {
  for (const pid of pids)
    // 이미 끝났거나 신호를 보낼 수 없다. 끝나지 않았으면 다음 조회에 다시 잡혀 결과의 `left`에 남는다.
    continueAfterFailure(
      () => process.kill(pid, signal),
      (error) => {
        if (!hasErrorCode("ESRCH")(error))
          console.warn(
            `[provider] could not signal process ${pid}; the next lookup reports it if it is still there (${failureCode(error)})`
          );
      }
    );
};
const pollMs = 50;

/** 조회가 전체 시한을 넘겼다는 표시. 처음 조회면 조회 실패로 던지고, 그 뒤의 조회면 버린다(조회 자체의 실패와 구분한다). */
class LookupTimeout extends Error {}

/** 조회가 정해진 시간 안에 끝나지 않으면 `LookupTimeout`을 던진다. 늦게 끝난 조회의 결과는 쓰지 않고, 그 조회의 실패도 처리해 둔다(처리되지 않은 거부가 남지 않게). */
async function within<T>(
  promise: Promise<T>,
  ms: number,
  clock: Clock
): Promise<T> {
  let timer: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(
      () =>
        reject(new LookupTimeout("Run marker lookup did not finish in time")),
      ms
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clock.clearTimeout(timer);
    // 시한이 지나 이미 포기한 조회다. 늦은 결과는 일부러 버린다.
    void settled(promise);
  }
}

/**
 * 이 표식을 가진 프로그램을 시스템 전체에서 찾아 끈다. 보유자는 처음 확인한 때 TERM을 받고, 그 보유자의 유예(graceMs)가 지난 뒤에만 KILL을 받는다.
 * 신호는 매번 바로 앞에서 다시 찾은 번호에만 보낸다(찾기와 신호 사이의 아주 짧은 틈은 남는다). 확인하지 못한 프로그램은 유예 동안 다시 찾아 보며 신호를 보내지 않는다.
 * 조회는 처음 것도 전체 시한(graceMs + waitMs) 안에 끝나야 한다. 처음 조회가 시한을 넘기면 조회 실패로 던진다. 그 뒤의 조회가 시한을 넘기면 버리고 마지막으로 끝난 조회 결과를 돌려준다.
 * 시한이 지난 뒤에는 새로 찾지 않고 신호도 보내지 않는다. 시한이 지난 뒤에 돌아온 조회 결과로도 신호를 보내지 않는다.
 * 더 이상 보이지 않는 프로그램은 `stopped`, 아직 보이거나 확인하지 못한 프로그램은 `left`로 돌려주며 두 곳에 함께 넣지 않는다.
 * 시한·유예·다시 찾기 간격은 `clock`(기본은 실제 시계)으로 잰다. 시험은 가짜 시계로 조회가 끝나는 때와 시한의 순서를 정한다(#225).
 */
export async function stopLeaseHolders(
  lease: string,
  {
    since,
    find = (value) => leaseHolders(value, { since }),
    graceMs = 2000,
    waitMs = 10_000,
    clock = realClock,
  }: {
    since?: number;
    find?: (lease: string) => Promise<LeaseLookup>;
    graceMs?: number;
    waitMs?: number;
    clock?: Clock;
  } = {}
) {
  const begin = clock.now();
  const deadline = begin + graceMs + waitMs;
  const termAt = new Map<number, number>(); // pid별 TERM을 받은 시각
  let lookup = await within(
    find(lease),
    Math.max(0, deadline - clock.now()),
    clock
  );
  for (;;) {
    const now = clock.now();
    // 시한이 지난 뒤에 돌아온 조회 결과로는 신호를 보내지 않는다. 결과의 `left`가 아직 남은 것을 알려 준다.
    if (now >= deadline) break;
    for (const pid of lookup.holders) {
      const at = termAt.get(pid);
      if (at === undefined) {
        send([pid], "SIGTERM");
        termAt.set(pid, now);
      } else if (now - at >= graceMs) send([pid], "SIGKILL");
    }
    // 확인하지 못한 것은 유예(graceMs) 동안만 다시 찾아 본다. 보유자가 남아 있으면 시한까지 계속 본다.
    const settled =
      !lookup.holders.length &&
      (!lookup.unverified.length || now - begin >= graceMs);
    if (settled) break;
    await new Promise((resolve) =>
      clock.setTimeout(() => resolve(null), pollMs)
    );
    // 시한이 지난 뒤에는 새로 찾지 않는다. 마지막으로 끝난 조회가 본 것을 그대로 돌려준다.
    if (clock.now() >= deadline) break;
    try {
      lookup = await within(find(lease), deadline - clock.now(), clock);
    } catch (e) {
      // 시한까지 끝나지 않은 조회는 버린다. 조회 자체의 실패는 그대로 던진다.
      if (e instanceof LookupTimeout) break;
      throw e;
    }
  }
  return {
    stopped: [...termAt.keys()].filter(
      (pid) => !lookup.holders.includes(pid) && !lookup.unverified.includes(pid)
    ),
    left: [...new Set([...lookup.holders, ...lookup.unverified])],
  };
}
