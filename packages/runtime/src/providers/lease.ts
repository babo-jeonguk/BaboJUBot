import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/**
 * 실행 시도의 표식. 실행 시도마다 고유한 값을 프로그램 환경에 넣으면 그 자손이 모두 물려받는다.
 * Claude Code·Codex·Antigravity는 셸 명령을 새 세션에 띄우므로, 프로그램이 갑자기 죽으면 프로세스 그룹으로는 그 명령에 닿지 못하고 이 표식으로만 찾는다(#219).
 *
 * 알려진 한계: 표식 변수를 일부러 지운 프로그램, 환경을 읽을 수 없게 막은 프로그램(Linux에서 dump 불가로 바꾼 프로그램 등)은 찾지 못한다.
 * macOS는 다른 변수의 값 안에 공백 뒤로 표식이 통째로 들어 있으면 표식으로 본다(`ps`가 변수 경계를 남기지 않는다).
 */
export const leaseVariable = "BABOJUBOT_PROCESS_LEASE";
export const leaseEntry = (lease: string) => `${leaseVariable}=${lease}`;

const unreadable = (e: unknown) =>
  ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(
    (e as NodeJS.ErrnoException).code ?? ""
  );

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

async function linuxHolders(lease: string) {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    if (await holdsLease(Number(name), lease)) found.push(Number(name));
  }
  return found;
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
 * macOS: 같은 목록을 환경 변수 없이(`commands`)와 있이(`withEnvironment`, `ps -E`) 받아, 실행 인자 뒤에 붙은 환경 변수 부분만 공백으로 나눠 정확히 비교한다.
 * 실행 인자에 표식 문자열을 가진 프로그램은 대상이 아니다. 두 조회 사이에 실행 인자가 바뀐 프로그램은 이번에는 건너뛴다.
 */
export function holdersInPs(
  commands: string,
  withEnvironment: string,
  lease: string
) {
  const plain = byPid(commands);
  const entry = leaseEntry(lease);
  const found: number[] = [];
  for (const [pid, line] of byPid(withEnvironment)) {
    const command = plain.get(pid);
    if (command === undefined || !line.startsWith(command)) continue;
    if (line.slice(command.length).split(/\s+/).includes(entry))
      found.push(pid);
  }
  return found;
}

/** 이 표식을 가진 프로그램(서버 자신 제외). 조회 자체가 실패하면(`/proc`·`ps`를 읽지 못함) 던진다. */
export async function leaseHolders(lease: string) {
  const found =
    process.platform === "linux"
      ? await linuxHolders(lease)
      : holdersInPs(await ps([]), await ps(["-E"]), lease);
  return found.filter((pid) => pid !== process.pid);
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

/**
 * 이 표식을 가진 프로그램을 시스템 전체에서 찾아 끈다. TERM → 유예 → KILL 순서이고, 매 단계 표식으로 다시 찾는다.
 * KILL은 바로 앞에서 다시 찾은 번호에만 보낸다. 그 사이 끝나 다른 프로그램에 재사용된 번호는 받지 않는다(찾기와 신호 사이의 아주 짧은 틈은 남는다).
 * 끈 것(`stopped`)과 기다림이 끝날 때까지 남은 것(`left`)을 돌려준다. 조회가 실패하면 던진다.
 */
export async function stopLeaseHolders(
  lease: string,
  {
    find = leaseHolders,
    graceMs = 2000,
    waitMs = 10_000,
  }: {
    find?: (lease: string) => Promise<number[]>;
    graceMs?: number;
    waitMs?: number;
  } = {}
) {
  let holders = await find(lease);
  if (!holders.length) return { stopped: [], left: [] };
  const signalled = new Set(holders);
  send(holders, "SIGTERM");
  const grace = Date.now() + graceMs;
  while (holders.length && Date.now() < grace) {
    await delay(pollMs);
    holders = await find(lease);
  }
  // 커널 작업에 묶여 죽지 않는 프로그램을 끝없이 기다리지 않는다.
  const deadline = Date.now() + waitMs;
  while (holders.length && Date.now() < deadline) {
    send(holders, "SIGKILL");
    for (const pid of holders) signalled.add(pid);
    await delay(pollMs);
    holders = await find(lease);
  }
  return {
    stopped: [...signalled].filter((pid) => !holders.includes(pid)),
    left: holders,
  };
}
