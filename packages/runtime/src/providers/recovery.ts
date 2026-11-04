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
/** 프로세스와 그 자식들에게 신호를 보낸다. Windows는 프로세스 그룹이 없어 taskkill로 트리를 끝낸다. */
export function signalProcessTree(pid: number, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    // Windows에는 중단 신호가 없다. 입력을 닫은 뒤의 종료 단계에서 끝낸다.
    if (signal === "SIGINT") return;
    const args = ["/T", "/PID", String(pid)];
    if (signal === "SIGKILL") args.unshift("/F");
    execFile("taskkill", args, { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH")
      console.warn("[provider] could not signal a process group");
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
/** The group is already authenticated by spawn ownership or the recovery lease. */
export async function stopProcessGroup(group: number) {
  // Windows는 대표 프로세스가 끝나면 자식을 찾을 수 없다. 취소 때 트리를 끝내는 것으로 대신한다.
  if (!groupAlive(group)) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-group, value);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  signal("SIGTERM");
  const until = Date.now() + 2000;
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
  try {
    const [command, args] = startQuery(pid, platform);
    return parseStart(
      execFileSync(command, args, {
        encoding: "utf8",
        env: startQueryEnv(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch {
    return undefined;
  }
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
    } catch {
      if (tries <= 1) {
        console.warn("[provider] could not save a process start time");
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
    { encoding: "utf8", env: startQueryEnv(), windowsHide: true },
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
/** /proc가 없는 시스템의 복구. 기록한 시작 시각과 같은 프로세스만 우리 것으로 보고 끝낸다. */
async function recoverWithoutProc(
  saved: { pid: number; started?: number },
  platform: NodeJS.Platform
) {
  if (!processAlive(saved.pid)) {
    // 대표는 끝났는데 자식이 남았으면 번호만으로 우리 것인지 알 수 없다. 건드리지 않고 기록을 남긴다.
    if (platform !== "win32" && groupAlive(saved.pid))
      throw new Error("Cannot identify the remaining process group");
    return;
  }
  // 살아 있는데 시작 시각을 모르거나 기록에 없으면 우리 것인지 알 수 없다. 끝난 것으로 치지 않고 기록을 남긴다.
  const started = processStartedAt(saved.pid, platform);
  if (started === undefined || saved.started === undefined)
    throw new Error("Cannot identify a remaining process");
  if (started !== saved.started) return;
  if (platform === "win32") {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(saved.pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  // 기록을 남긴 프로세스는 그룹 대표로 띄웠다. 끝났는지 확인하고 돌아온다.
  await stopProcessGroup(saved.pid);
}
export async function recoverProviderProcesses(
  dataDir: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {}
) {
  let connections: string[];
  try {
    connections = readdirSync(path.join(dataDir, "providers"));
  } catch {
    return;
  }
  for (const provider of connections) {
    const directory = path.join(dataDir, "providers", provider, "processes");
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(`[provider] could not read ${provider} process records`);
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
      } catch {
        console.warn(
          `[provider] could not recover ${provider} process record ${name}; it stays for the next start`
        );
      }
    }
  }
}
type ProcessRecord = {
  pid: number;
  start: string;
  group: number;
  boot: string;
  lease?: string;
  started?: number;
};
/** 쓸 수 없는 기록(깨졌거나, 이름과 번호가 다름)은 어떤 프로세스도 가리키지 않는다. 파일을 읽지 못한 오류는 그대로 던져 기록을 남긴다. */
function readRecord(file: string) {
  let saved: Partial<ProcessRecord> | null;
  try {
    saved = JSON.parse(
      readFileSync(file, "utf8")
    ) as Partial<ProcessRecord> | null;
  } catch (e) {
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
  // 1번은 신호를 보내면 모든 프로세스에 간다. 이 번호는 명령에도 쓰이니 숫자인지 꼭 본다.
  return Number.isInteger(saved?.pid) &&
    saved!.pid! > 1 &&
    saved!.pid === Number(path.basename(file, ".json"))
    ? (saved as ProcessRecord)
    : undefined;
}
async function recoverRecord(saved: ProcessRecord, platform: NodeJS.Platform) {
  if (platform !== "linux") {
    await recoverWithoutProc(saved, platform);
    return;
  }
  if (saved.boot !== boot()) {
    return;
  }
  let leader: ReturnType<typeof identity> | undefined;
  try {
    leader = identity(saved.pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const remaining = members(saved.pid);
  const marker = remaining.some((member) => {
    try {
      return (
        !!saved.lease &&
        readFileSync(`/proc/${member.pid}/environ`).includes(
          Buffer.from(`BABOJUBOT_PROCESS_LEASE=${saved.lease}\0`)
        )
      );
    } catch {
      return false;
    }
  });
  if ((leader?.start === saved.start && leader.group === saved.pid) || marker)
    await stopProcessGroup(saved.pid);
  else if (!leader && remaining.length)
    throw new Error(
      "Cannot authenticate an orphaned provider process group; manual cleanup required"
    );
}
