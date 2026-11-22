// 프로세스 그룹 끄기. runtime의 재시작 복구만 쓴다(eslint.config.js의 no-group-stop-import). 실행 중인 트리는 감독 실행기가 끈다(#268).
import { readFileSync, readdirSync } from "node:fs";
import {
  attemptEach,
  combinedFailure,
  hasErrorCode,
} from "@babojubot/contracts";
import { statFields, statRuns } from "./proc-stat.ts";
function fieldsOf(pid: number) {
  return statFields(readFileSync(`/proc/${pid}/stat`, "utf8"));
}
export function identity(pid: number) {
  const fields = fieldsOf(pid);
  return { pid, start: fields[19], group: Number(fields[2]), state: fields[0] };
}
export function members(group: number) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const pid = Number(name);
        const fields = fieldsOf(pid);
        return Number(fields[2]) === group && statRuns(fields)
          ? [{ pid, start: fields[19], group, state: fields[0] }]
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
/** 그룹에 살아 있는 프로세스가 있는가. Linux는 끝난 프로세스(마지막 스레드까지 끝난 좀비)를 빼고 세고, 그 밖의 POSIX는 신호 0으로 확인한다. */
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
 * SIGTERM 뒤 `graceMs`만큼 스스로 끝나기를 기다리고 SIGKILL한다. 신호 하나가 실패해도 다음 신호와 끝 확인을 건너뛰지 않고, 끝나지 않으면 그 실패를 원인에 함께 담는다. 이 함수는 runtime의 재시작 복구(@babojubot/process/recovery로 가져감)만 쓴다(lint).
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
      if (!hasErrorCode("ESRCH")(e)) throw e;
    }
  };
  // TERM → 유예 → KILL → 끝 확인의 차례는 지키되, 신호 하나가 실패해도 다음 단계는 한다. 신호의 실패는 끝 확인에 맡긴다: 끝났으면
  // 끝난 것이고, 끝나지 않았으면 그 실패를 원인에 함께 담는다(#274 외부 리뷰 3회차 STD-4).
  const failures = await attemptEach([
    () => signal("SIGTERM"),
    async () => {
      const until = Date.now() + graceMs;
      while (groupAlive(group) && Date.now() < until) await delay(25);
      if (groupAlive(group)) signal("SIGKILL");
    },
  ]);
  // 커널 작업에 묶여 죽지 않는 프로세스를 끝없이 기다리면 그 에이전트가 영원히 멈춘다. 기다림에 끝을 둔다.
  const deadline = Date.now() + 10_000;
  while (groupAlive(group)) {
    if (Date.now() >= deadline)
      throw combinedFailure(
        [new Error("Process group did not stop"), ...failures],
        "Process group did not stop"
      );
    await delay(25);
  }
}
