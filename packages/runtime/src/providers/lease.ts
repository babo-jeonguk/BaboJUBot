import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

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

const unreadable = (e: unknown) =>
  ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(
    (e as NodeJS.ErrnoException).code ?? ""
  );

/** Linux: 프로세스 시작 시각(부팅 뒤 clock tick, /proc/<pid>/stat 22번째 칸). 그 밖의 시스템이거나 읽지 못하면 undefined. */
export function processStartTicks(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")
      .at(-1)!
      .split(" ");
    const start = Number(fields[19]);
    return Number.isFinite(start) ? start : undefined;
  } catch {
    return undefined;
  }
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
  return environment.split("\0").includes(leaseEntry(lease));
}

/** 찾은 결과. `holders`는 표식을 확인한 프로그램, `unverified`는 우리 것일 수 있지만 환경을 읽을 수 없어 확인하지 못한 프로그램이다. */
export type LeaseLookup = { holders: number[]; unverified: number[] };

/** Linux: 환경을 읽지 못한 프로세스가 이 실행 시도 뒤에 생긴 같은 사용자의 산 프로세스인가. 확인하지 못하면 아니다. */
async function mayBeOurs(
  pid: number,
  since: number,
  serverCgroup: string | undefined
) {
  if (serverCgroup === undefined) return false;
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const uid = /^Uid:\s+(\d+)/m.exec(status);
    if (!uid || Number(uid[1]) !== process.getuid!()) return false;
    const fields = (await readFile(`/proc/${pid}/stat`, "utf8"))
      .split(") ")
      .at(-1)!
      .split(" ");
    // 끝났지만 거두어지지 않은 프로세스(좀비)는 산 것이 아니다.
    if (fields[0] === "Z" || fields[0] === "X") return false;
    const start = Number(fields[19]);
    if (!Number.isFinite(start) || start < since) return false;
    // 실행 시도의 자손은 서버의 cgroup을 물려받는다. 다른 cgroup(데스크톱 앱·systemd 서비스)의 프로그램은 우리 것이 아니다.
    return (await readFile(`/proc/${pid}/cgroup`, "utf8")) === serverCgroup;
  } catch {
    return false;
  }
}

async function linuxHolders(
  lease: string,
  since?: number
): Promise<LeaseLookup> {
  const holders: number[] = [];
  const unverified: number[] = [];
  const entry = leaseEntry(lease);
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
        serverCgroup ??= readFile("/proc/self/cgroup", "utf8").catch(
          () => undefined
        );
        if (await mayBeOurs(pid, since, await serverCgroup))
          unverified.push(pid);
      }
      continue;
    }
    if (environment.split("\0").includes(entry)) holders.push(pid);
  }
  return { holders, unverified };
}

const ps = (extra: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      "ps",
      ["-A", "-ww", ...extra, "-o", "pid=,command="],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15_000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  );

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
  const entry = leaseEntry(lease);
  const holders: number[] = [];
  const unverified: number[] = [];
  for (const [pid, line] of byPid(withEnvironment)) {
    if (!line.split(/\s+/).includes(entry)) continue;
    const command = plainBefore.get(pid);
    const confirmed =
      command !== undefined &&
      plainAfter.get(pid) === command &&
      line.startsWith(command + " ");
    if (!confirmed) {
      unverified.push(pid);
      continue;
    }
    if (
      line
        .slice(command.length + 1)
        .split(/\s+/)
        .includes(entry)
    )
      holders.push(pid);
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (pids: number[], signal: NodeJS.Signals) => {
  for (const pid of pids)
    try {
      process.kill(pid, signal);
    } catch {
      // 이미 끝났거나 신호를 보낼 수 없다. 끝나지 않았으면 다음 조회에 다시 잡혀 결과의 `left`에 남는다.
    }
};
const pollMs = 50;

/** 조회가 전체 시한을 넘겼다는 표시. 처음 조회면 조회 실패로 던지고, 그 뒤의 조회면 버린다(조회 자체의 실패와 구분한다). */
class LookupTimeout extends Error {}

/** 조회가 정해진 시간 안에 끝나지 않으면 `LookupTimeout`을 던진다. 늦게 끝난 조회의 결과는 쓰지 않고, 그 조회의 실패도 처리해 둔다(처리되지 않은 거부가 남지 않게). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new LookupTimeout("Run marker lookup did not finish in time")),
      ms
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
    promise.catch(() => {
      // 시한이 지나 이미 포기한 조회다. 늦은 거부를 여기서 거둔다.
    });
  }
}

/**
 * 이 표식을 가진 프로그램을 시스템 전체에서 찾아 끈다. 보유자는 처음 확인한 때 TERM을 받고, 그 보유자의 유예(graceMs)가 지난 뒤에만 KILL을 받는다.
 * 신호는 매번 바로 앞에서 다시 찾은 번호에만 보낸다(찾기와 신호 사이의 아주 짧은 틈은 남는다). 확인하지 못한 프로그램은 유예 동안 다시 찾아 보며 신호를 보내지 않는다.
 * 조회는 처음 것도 전체 시한(graceMs + waitMs) 안에 끝나야 한다. 처음 조회가 시한을 넘기면 조회 실패로 던진다. 그 뒤의 조회가 시한을 넘기면 버리고 마지막으로 끝난 조회 결과를 돌려준다.
 * 시한이 지난 뒤에는 새로 찾지 않고 신호도 보내지 않는다. 시한이 지난 뒤에 돌아온 조회 결과로도 신호를 보내지 않는다.
 * 더 이상 보이지 않는 프로그램은 `stopped`, 아직 보이거나 확인하지 못한 프로그램은 `left`로 돌려주며 두 곳에 함께 넣지 않는다.
 */
export async function stopLeaseHolders(
  lease: string,
  {
    since,
    find = (value) => leaseHolders(value, { since }),
    graceMs = 2000,
    waitMs = 10_000,
  }: {
    since?: number;
    find?: (lease: string) => Promise<LeaseLookup>;
    graceMs?: number;
    waitMs?: number;
  } = {}
) {
  const begin = Date.now();
  const deadline = begin + graceMs + waitMs;
  const termAt = new Map<number, number>(); // pid별 TERM을 받은 시각
  let lookup = await within(find(lease), Math.max(0, deadline - Date.now()));
  for (;;) {
    const now = Date.now();
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
    await delay(pollMs);
    // 시한이 지난 뒤에는 새로 찾지 않는다. 마지막으로 끝난 조회가 본 것을 그대로 돌려준다.
    if (Date.now() >= deadline) break;
    try {
      lookup = await within(find(lease), deadline - Date.now());
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
