// 기록한 프로세스와 그 그룹 보기(신호는 보내지 않는다). runtime의 재시작 복구만 쓴다. 트리를 끄는 일은 감독 실행기가 한다(#268):
// 실행 중인 트리는 그 실행기가, 서버와 실행기가 함께 죽은 뒤에는 복구가 정리만 청한 실행기가 표식으로 끈다.
import { readFileSync, readdirSync } from "node:fs";
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
