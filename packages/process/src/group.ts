// 프로세스 그룹 끄기. 공용 실행(launch.ts)의 stop()과 runtime의 재시작 복구만 쓴다(eslint.config.js의 no-group-stop-import).
import { readFileSync, readdirSync } from "node:fs";
export function identity(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
    .split(") ")
    .at(-1)!
    .split(" ");
  return { pid, start: fields[19], group: Number(fields[2]), state: fields[0] };
}
export function members(group: number) {
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
export function groupAlive(group: number) {
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
 * SIGTERM 뒤 `graceMs`만큼 스스로 끝나기를 기다리고 SIGKILL한다. 이 함수는 공용 실행(launch.ts)과 runtime의 재시작 복구(@babojubot/process/recovery로 가져감)만 쓴다(lint).
 */
export async function stopProcessGroup(
  group: number,
  { graceMs = 2000 }: { graceMs?: number } = {}
) {
  // Windows에는 프로세스 그룹이 없다. 그곳의 트리는 감독 실행기의 묶음이 끈다(supervisor.ts). 이 함수는 재시작 복구만 쓴다.
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
