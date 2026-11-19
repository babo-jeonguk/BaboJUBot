import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
} from "@babojubot/contracts";
import { holdsLease, stopLeaseHolders } from "./lease.ts";
const boot = () =>
  readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
function identity(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
    .split(") ")
    .at(-1)!
    .split(" ");
  return { pid, start: fields[19], group: Number(fields[2]), state: fields[0] };
}
function members(group: number) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const info = identity(Number(name));
        return info.group === group && info.state !== "Z" && info.state !== "X"
          ? [info]
          : [];
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code === "ENOENT" ||
          (e as NodeJS.ErrnoException).code === "ESRCH" ||
          (e as NodeJS.ErrnoException).code === "EACCES" ||
          (e as NodeJS.ErrnoException).code === "EPERM"
        )
          return [];
        throw e;
      }
    });
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 복구 도우미 명령이 서버를 붙잡을 수 있는 가장 긴 시간. 느린 Windows에서는 PowerShell이 뜨는 데 몇 초 걸린다. */
const helperCommandTimeoutMs = 10_000;
/** Windows에서 시작 시각을 묻는 명령의 제한. 붙잡는 것이 없어 더 기다려도 되고, 실패하면 시작 시각 없는 기록으로 남으며 복구는 이미 그것을 모르는 것으로 다룬다. */
const startRecordTimeoutMs = 30_000;
/**
 * 프로세스 그룹에 중단(SIGINT)을 보낸다. 끄기가 아니라 지금 하던 일을 멈추라는 요청이다. Windows에는 그룹과 중단 신호가 없어 아무것도
 * 하지 않는다. 트리를 끄는 일은 공용 실행(`launch.ts`)의 `stop()`이 맡는다.
 */
export function interruptProcessGroup(group: number) {
  if (process.platform === "win32") return;
  try {
    process.kill(-group, "SIGINT");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH")
      console.warn("[provider] could not interrupt a process group");
  }
}
/** 그룹에 살아 있는 프로세스가 있는가. Linux는 좀비를 빼고 세고, 그 밖의 POSIX는 신호 0으로 확인한다. */
function groupAlive(group: number) {
  if (process.platform === "win32") return false;
  if (process.platform === "linux") return members(group).length > 0;
  try {
    process.kill(-group, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/**
 * 그룹을 끄고 끝난 것을 상한 안에서 확인한다. 확인하지 못하면 던진다. 그룹은 띄운 쪽(`launch.ts`)이나 복구 기록이 이미 확인했다.
 * SIGTERM 뒤 `graceMs`만큼 스스로 끝나기를 기다리고 SIGKILL한다. 이 함수는 runtime 안의 공용 실행과 재시작 복구만 쓴다(lint).
 */
export async function stopProcessGroup(
  group: number,
  { graceMs = 2000 }: { graceMs?: number } = {}
) {
  // Windows는 대표 프로세스가 끝나면 자식을 찾을 수 없다. 대표인 묶음 실행기가 끝나며 묶음을 닫아 남은 것을 끈다(job-object.ts).
  if (!groupAlive(group)) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-group, value);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  signal("SIGTERM");
  const until = Date.now() + graceMs;
  while (groupAlive(group) && Date.now() < until) await delay(25);
  if (groupAlive(group)) signal("SIGKILL");
  // 커널 작업에 묶여 죽지 않는 프로세스를 끝없이 기다리면 그 에이전트가 영원히 멈춘다. 기다림에 끝을 둔다.
  const deadline = Date.now() + 10_000;
  while (groupAlive(group)) {
    if (Date.now() >= deadline) throw new Error("Process group did not stop");
    await delay(25);
  }
}
/** 프로세스 시작 시각을 묻는 명령. 같은 프로세스면 언제 물어도 같은 값이 나온다. */
function startQuery(
  pid: number,
  platform: NodeJS.Platform
): [string, string[]] {
  return platform === "win32"
    ? [
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
      ]
    : ["ps", ["-o", "lstart=", "-p", String(pid)]];
}
const startQueryEnv = () => ({ ...process.env, LC_ALL: "C" });
function parseStart(text: string) {
  const at = Date.parse(text.trim());
  return Number.isFinite(at) ? at : undefined;
}
/** /proc가 없는 시스템에서 프로세스 시작 시각. 물어볼 수 없으면 `undefined`다. */
export function processStartedAt(pid: number, platform: NodeJS.Platform) {
  return orIfUnreadable(() => {
    const [command, args] = startQuery(pid, platform);
    return parseStart(
      execFileSync(command, args, {
        encoding: "utf8",
        env: startQueryEnv(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: helperCommandTimeoutMs,
      })
    );
  }, undefined);
}
// Windows는 다른 프로그램이 파일을 열어 둔 동안 덮어쓰기를 거절한다. 잠깐이므로 약 5초 동안 다시 시도한다.
const startSaveTries = 20;
const startSaveRetryMs = 250;
/** 복구 기록. 프로세스 번호는 재사용되므로 시작 시각으로 같은 프로세스인지 판단한다. Linux는 부팅 식별자도 남긴다. */
export function recordProcess(
  home: string,
  pid: number,
  lease: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {}
) {
  const directory = path.join(home, "processes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${pid}.json`);
  const temp = `${file}.tmp`;
  const write = (record: object) => {
    try {
      writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      renameSync(temp, file);
    } catch (e) {
      rmSync(temp, { force: true });
      throw e;
    }
  };
  if (platform === "linux") {
    write({ ...identity(pid), boot: boot(), lease });
    return () => rmSync(file, { force: true });
  }
  write({ pid, lease });
  // PowerShell은 답이 느려 실행을 붙잡지 않는다. 그 전에 서버가 죽으면 시작 시각이 없는 기록으로 남아 건드리지 않는다.
  let forgotten = false;
  const saveStarted = (started: number, tries: number) => {
    if (forgotten) return;
    try {
      write({ pid, lease, started });
    } catch (error) {
      if (tries <= 1) {
        console.warn(
          `[provider] could not save a process start time (${failureCode(error)})`
        );
        return;
      }
      setTimeout(
        () => saveStarted(started, tries - 1),
        startSaveRetryMs
      ).unref();
    }
  };
  const [command, args] = startQuery(pid, platform);
  execFile(
    command,
    args,
    {
      encoding: "utf8",
      env: startQueryEnv(),
      windowsHide: true,
      timeout: startRecordTimeoutMs,
    },
    (error, stdout) => {
      const started = error ? undefined : parseStart(stdout);
      if (started !== undefined) saveStarted(started, startSaveTries);
    }
  );
  return () => {
    forgotten = true;
    rmSync(file, { force: true });
  };
}
/** 번호로 프로세스가 있는지 본다. 권한이 없어 거절돼도 있는 것이다. Windows에서도 동작한다. */
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** 우리 것인지 확인하지 못하고 남긴 것. 표식 정리 뒤에도 남았으면 기록을 남긴다. */
type Unidentified = { remains: () => boolean; reason: string };
/** /proc가 없는 시스템의 그룹 복구. 기록한 시작 시각과 같은 프로세스만 우리 것으로 보고 끝낸다. */
async function recoverWithoutProc(
  saved: { pid: number; started?: number },
  platform: NodeJS.Platform
): Promise<Unidentified | undefined> {
  if (!processAlive(saved.pid)) {
    // 대표는 끝났는데 자식이 남았으면 번호만으로 우리 것인지 알 수 없다. 표식으로 확인되는 것만 끈다.
    return platform !== "win32" && groupAlive(saved.pid)
      ? {
          remains: () => groupAlive(saved.pid),
          reason: "Cannot identify the remaining process group",
        }
      : undefined;
  }
  // 살아 있는데 시작 시각을 모르거나 기록에 없으면 번호만으로 우리 것인지 알 수 없다. 끝난 것으로 치지 않고 표식으로 확인되는 것만 끈다.
  const started = processStartedAt(saved.pid, platform);
  if (started === undefined || saved.started === undefined)
    return {
      remains: () => processAlive(saved.pid),
      reason: "Cannot identify a remaining process",
    };
  if (started !== saved.started) return;
  if (platform === "win32") {
    // 기록한 프로세스(번호와 시작 시각이 같은 것)의 트리를 끄고, 그 프로세스가 끝난 것을 상한 안에서 확인한다. 이미 끝나
    // taskkill이 실패할 수 있으므로 실패는 남기고 아래 확인으로 판단한다. 부모가 먼저 끝난 자손은 Windows가 번호로 찾을 수 없다.
    continueAfterFailure(
      () =>
        execFileSync("taskkill", ["/F", "/T", "/PID", String(saved.pid)], {
          windowsHide: true,
          stdio: "ignore",
          timeout: helperCommandTimeoutMs,
        }),
      (error) =>
        console.warn(
          `[provider] taskkill of a recorded process did not succeed; checking whether it ended (${failureCode(error)})`
        )
    );
    const deadline = Date.now() + helperCommandTimeoutMs;
    // 산 프로세스의 번호는 그 프로세스가 끝나기 전에는 바뀌지 않는다. 번호가 남아 있으면 시작 시각으로 같은 프로세스인지 보고,
    // 시작 시각을 읽지 못하면 끝났다고 치지 않는다.
    const sameProcess = () => {
      if (!processAlive(saved.pid)) return false;
      const now = processStartedAt(saved.pid, platform);
      return now === undefined || now === saved.started;
    };
    while (sameProcess()) {
      if (Date.now() >= deadline)
        throw new Error("Recorded process did not stop");
      await delay(250);
    }
    return;
  }
  // 기록을 남긴 프로세스는 그룹 대표로 띄웠다. 끝났는지 확인하고 돌아온다.
  await stopProcessGroup(saved.pid);
}
export async function recoverProviderProcesses(
  dataDir: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {}
) {
  const connections =
    continueAfterFailure(
      () =>
        orIfMissing(
          () => readdirSync(path.join(dataDir, "providers")),
          hasErrorCode("ENOENT"),
          []
        ),
      (error) =>
        console.warn(
          `[provider] the provider process records could not be listed; leftover processes are not recovered at this start (${failureCode(error)})`
        )
    ) ?? [];
  for (const provider of connections) {
    const directory = path.join(dataDir, "providers", provider, "processes");
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          `[provider] could not read ${provider} process records; they are not recovered at this start (${failureCode(e)})`
        );
      continue;
    }
    for (const name of files) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      // 기록 하나 때문에 서버가 뜨지 못하면 안 된다. 끝났음을 확인하지 못한 기록은 남겨 다음 시작 때 다시 본다.
      try {
        const saved = readRecord(file);
        if (saved) await recoverRecord(saved, platform);
        rmSync(file, { force: true });
      } catch (error) {
        console.warn(
          `[provider] could not recover ${provider} process record ${name}; it stays for the next start (${failureCode(error)})`
        );
      }
    }
  }
}
/** 복구 기록에서 쓰는 필드. 번호 말고는 없어도 된다: /proc가 없는 시스템의 기록에는 시작 시각·부팅 식별자가 없고 시작 시각(`started`)은 나중에 채워진다. */
// 1번은 신호를 보내면 모든 프로세스에 간다. 이 번호는 명령에도 쓰이니 숫자인지 꼭 본다.
const processRecordSchema = z.object({
  pid: z.number().int().gt(1),
  start: z.string().optional(),
  boot: z.string().optional(),
  lease: z.string().optional(),
  started: z.number().optional(),
});
type ProcessRecord = z.infer<typeof processRecordSchema>;
/** 쓸 수 없는 기록(깨졌거나, 이름과 번호가 다름)은 어떤 프로세스도 가리키지 않는다. 파일을 읽지 못한 오류는 그대로 던져 기록을 남긴다. */
function readRecord(file: string) {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
  const record = processRecordSchema.safeParse(saved);
  return record.success &&
    record.data.pid === Number(path.basename(file, ".json"))
    ? record.data
    : undefined;
}
async function recoverRecord(saved: ProcessRecord, platform: NodeJS.Platform) {
  // 다른 부팅의 기록이 가리키는 프로세스는 이미 없다.
  if (platform === "linux" && saved.boot !== boot()) return;
  const unidentified =
    platform === "linux"
      ? await recoverLinuxGroup(saved)
      : await recoverWithoutProc(saved, platform);
  // 그룹 밖(새 세션)으로 나간 자손도 이 실행 시도의 표식을 가진다. 표식으로 시스템 전체에서 찾아 끈다(#219). Windows는 묶음이 끈다.
  if (saved.lease && platform !== "win32") {
    // 기록한 대표의 시작 시각 뒤에 생긴, 환경을 읽을 수 없는 프로그램은 우리 것일 수 있어 확인하지 못한 것으로 남는다.
    const since = Number.isFinite(Number(saved.start))
      ? Number(saved.start)
      : undefined;
    const { left } = await stopLeaseHolders(saved.lease, { since });
    if (left.length)
      throw new Error("Programs with the run marker did not stop");
  }
  if (unidentified?.remains())
    throw new Error(`${unidentified.reason}; manual cleanup required`);
}
async function recoverLinuxGroup(
  saved: ProcessRecord
): Promise<Unidentified | undefined> {
  let leader: ReturnType<typeof identity> | undefined;
  try {
    leader = identity(saved.pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const remaining = members(saved.pid);
  let memberHoldsLease = false;
  for (const member of remaining)
    if (saved.lease && (await holdsLease(member.pid, saved.lease))) {
      memberHoldsLease = true;
      break;
    }
  if (
    (leader && leader.start === saved.start && leader.group === saved.pid) ||
    memberHoldsLease
  )
    await stopProcessGroup(saved.pid);
  else if (!leader && remaining.length)
    return {
      remains: () => members(saved.pid).length > 0,
      reason: "Cannot authenticate an orphaned provider process group",
    };
}
