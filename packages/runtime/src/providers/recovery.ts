import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
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
/** The group is already authenticated by spawn ownership or the recovery lease. */
export async function stopProcessGroup(group: number) {
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-group, value);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  if (process.platform === "linux") {
    if (!members(group).length) return;
    signal("SIGTERM");
    const until = Date.now() + 2000;
    while (members(group).length && Date.now() < until) await delay(25);
    if (members(group).length) signal("SIGKILL");
    // A live process in uninterruptible kernel work still owns its slot. Never pretend it exited.
    while (members(group).length) await delay(25);
  } else {
    signal("SIGTERM");
    await delay(2000);
    signal("SIGKILL");
  }
}
/** Start time + boot identity prevent stale PID reuse; descendants inherit an opaque ownership marker. */
export function recordProcess(home: string, pid: number, lease: string) {
  if (process.platform !== "linux") return () => {};
  const directory = path.join(home, "processes");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${pid}.json`);
  writeFileSync(
    file,
    JSON.stringify({ ...identity(pid), boot: boot(), lease }),
    { mode: 0o600 }
  );
  return () => rmSync(file, { force: true });
}
export async function recoverProviderProcesses(dataDir: string) {
  if (process.platform !== "linux") return;
  for (const provider of ["claude", "codex", "opencode", "antigravity"]) {
    const directory = path.join(dataDir, "providers", provider, "processes");
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const name of files) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      const saved = JSON.parse(readFileSync(file, "utf8")) as {
        pid: number;
        start: string;
        group: number;
        boot: string;
        lease?: string;
      };
      if (saved.boot !== boot()) {
        rmSync(file, { force: true });
        continue;
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
      if (
        (leader?.start === saved.start && leader.group === saved.pid) ||
        marker
      )
        await stopProcessGroup(saved.pid);
      else if (!leader && remaining.length)
        throw new Error(
          "Cannot authenticate an orphaned provider process group; manual cleanup required"
        );
      rmSync(file, { force: true });
    }
  }
}
