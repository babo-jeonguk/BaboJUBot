import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
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
/** 복구 기록. 파일 시각이 곧 시작 시각이라, 그 뒤에 시작한 프로세스는 번호만 같은 남이다. Linux는 부팅·시작 식별자도 남긴다. */
export function recordProcess(home: string, pid: number, lease: string) {
  const directory = path.join(home, "processes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${pid}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      process.platform === "linux"
        ? { ...identity(pid), boot: boot(), lease }
        : { pid, lease }
    ),
    { mode: 0o600 }
  );
  return () => rmSync(file, { force: true });
}
/** /proc가 없는 시스템에서 프로세스 시작 시각. 없으면 `undefined`다. */
function processStartedAt(pid: number, platform: NodeJS.Platform) {
  try {
    const text =
      platform === "win32"
        ? execFileSync(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
            ],
            {
              encoding: "utf8",
              windowsHide: true,
              stdio: ["ignore", "pipe", "ignore"],
            }
          )
        : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C" },
            stdio: ["ignore", "pipe", "ignore"],
          });
    const at = Date.parse(text.trim());
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}
/** /proc가 없는 시스템의 복구. 기록보다 먼저 시작한 프로세스만 우리 것으로 보고 끝낸다. */
async function recoverWithoutProc(
  file: string,
  saved: { pid: number },
  platform: NodeJS.Platform
) {
  const started = processStartedAt(saved.pid, platform);
  if (started === undefined) return;
  // 기록은 프로세스를 띄운 직후에 쓰므로 조금의 여유만 둔다.
  if (started > statSync(file).mtimeMs + 5000) return;
  if (platform === "win32") {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(saved.pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  // 기록을 남긴 프로세스는 그룹 대표로 띄웠다. 시험처럼 그룹이 다르면 그 프로세스만 끝낸다.
  try {
    process.kill(-saved.pid, "SIGTERM");
  } catch {
    process.kill(saved.pid, "SIGTERM");
  }
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
      // 기록 하나 때문에 서버가 뜨지 못하면 안 된다. 경고하고 넘어간다.
      try {
        await recoverRecord(file, platform);
      } catch {
        console.warn(
          `[provider] could not recover ${provider} process record ${name}; check it by hand`
        );
      }
      rmSync(file, { force: true });
    }
  }
}
async function recoverRecord(file: string, platform: NodeJS.Platform) {
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    pid: number;
    start: string;
    group: number;
    boot: string;
    lease?: string;
  };
  if (platform !== "linux") {
    await recoverWithoutProc(file, saved, platform);
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
