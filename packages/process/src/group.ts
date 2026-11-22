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
 * SIGTERM 뒤 `graceMs`만큼 스스로 끝나기를 기다리고 SIGKILL한다. 이 함수는 runtime의 재시작 복구(@babojubot/process/recovery로 가져감)만 쓴다(lint).
 *
 * 감독 실행기의 끄기(`supervisor/src/unix.rs` `end_tree`)와 같은 규칙: 신호 하나가 실패해도 다음 단계는 하고, 조회 실패는 끝났다는
 * 뜻이 아니므로 끝 확인의 시한까지 다시 본다. 끝나지 않으면 신호·조회 실패를 원인에 함께 담는다(#274 외부 리뷰 3회차 STD-4).
 * 다른 점 하나: 실행기는 대표를 거두지 않고 쥐어 그룹 번호가 다른 그룹에 가지 않으므로 조회 결과와 상관없이 신호한다. 이 함수는
 * 기록한 번호로 찾는 길이라 그룹이 빈 뒤에는 그 번호가 다른 그룹에 갈 수 있다. 그래서 신호는 바로 앞의 조회가 그룹이 아직 있다고
 * 본 때에만 보낸다(조회와 신호 사이의 아주 짧은 틈은 남는다).
 */
export async function stopProcessGroup(
  group: number,
  { graceMs = 2000 }: { graceMs?: number } = {}
) {
  /** 그룹이 아직 있는가. 조회가 실패하면 그 원인을 돌려준다(끝난 것으로 보지 않는다). */
  const look = (): boolean | { failure: unknown } => {
    try {
      return groupAlive(group);
    } catch (failure) {
      return { failure };
    }
  };
  /** 그룹이 빌 때까지 `until`까지 본다. 마지막 조회 결과를 돌려준다. */
  const lookUntil = async (until: number) => {
    for (;;) {
      const seen = look();
      if (seen === false || Date.now() >= until) return seen;
      await delay(25);
    }
  };
  /** 바로 앞의 조회가 그룹이 있다고 본 때에만 신호한다. 조회가 실패하면 그 실패로 던진다(신호하지 않는다). */
  const signal = (value: NodeJS.Signals) => {
    const seen = look();
    if (seen === false) return;
    if (seen !== true) throw seen.failure;
    try {
      process.kill(-group, value);
    } catch (e) {
      if (!hasErrorCode("ESRCH")(e)) throw e;
    }
  };
  // Windows에는 프로세스 그룹이 없다(groupAlive가 거짓). 그곳의 트리는 감독 실행기의 묶음이 끈다.
  if (look() === false) return;
  const failures = await attemptEach([
    () => signal("SIGTERM"),
    async () => {
      await lookUntil(Date.now() + graceMs);
      signal("SIGKILL");
    },
  ]);
  // 커널 작업에 묶여 죽지 않는 프로세스를 끝없이 기다리면 그 에이전트가 영원히 멈춘다. 기다림에 끝을 둔다.
  const last = await lookUntil(Date.now() + 10_000);
  if (last === false) return;
  throw combinedFailure(
    last === true
      ? [new Error("Process group did not stop"), ...failures]
      : [
          new Error("whether the process group stopped could not be told"),
          last.failure,
          ...failures,
        ],
    "Process group did not stop"
  );
}
