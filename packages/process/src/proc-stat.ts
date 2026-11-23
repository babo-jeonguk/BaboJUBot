// Linux `/proc/<pid>/stat`을 읽는 한 곳(#274). 재시작 복구의 그룹 확인(`group.ts`)과 시험 도움(`process-test-support.ts`)이 같은
// 판정을 쓴다. 감독 실행기의 그룹원 세기(`supervisor/src/unix.rs` `group_member_runs`)와 표식 정리(`supervisor/src/marked.rs`)도 같은 규칙이다.

/** 명령 이름 뒤의 칸들: 0 상태, 1 부모, 2 프로세스 그룹, …, 17 스레드 수, 19 시작 시각(부팅 뒤 clock tick). 명령 이름에 `) `가 들어 있어도 마지막 것 뒤를 읽는다. */
export function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
}

/**
 * 이 칸의 프로세스가 아직 도는가. 상태 글자는 주 스레드의 것이다. 여러 스레드 프로그램(Node.js)은 신호로 끝날 때 주 스레드가 먼저
 * 좀비(Z)가 되고 다른 스레드는 아직 끝나는 중이며, 그 자식은 마지막 스레드가 끝나야 부모를 잃는다. 주 스레드만 끝난 프로그램은 계속
 * 돈다. 그래서 좀비라도 스레드가 둘 이상이면 도는 것으로 본다. 스레드 수를 읽지 못한 좀비도 도는 것으로 본다(끝났다고 단정하지 않는다).
 */
export function statRuns(fields: readonly string[]): boolean {
  const state = fields[0];
  if (state === "X") return false;
  if (state !== "Z") return true;
  const threads = Number(fields[17]);
  return !Number.isInteger(threads) || threads > 1;
}
