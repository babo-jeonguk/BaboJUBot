import { expect, it } from "vitest";
import { statFields, statRuns } from "./proc-stat.ts";

/** 그룹 100의 프로세스 200의 `/proc/<pid>/stat` 줄. 명령 이름에 구분자(`) `)가 들어 있다. */
const stat = (state: string, threads: number) =>
  `200 (node ) S x) ${state} 1 100 100 0 -1 4194304 92 0 0 0 0 0 0 0 20 0 ${threads} 0 148788766 5980160 392`;

it("reads the fields after the command name", () => {
  const fields = statFields(stat("S", 3));
  expect(fields[0]).toBe("S");
  expect(fields[2]).toBe("100");
  expect(fields[17]).toBe("3");
  expect(fields[19]).toBe("148788766");
});

// 상태 글자는 주 스레드의 것이다. 여러 스레드 프로그램(Node.js)은 주 스레드가 좀비가 된 뒤에도 다른 스레드가 돌거나 끝나는 중이고
// (주 스레드만 끝난 프로그램은 계속 돈다), 그 자식은 마지막 스레드가 끝나야 넘어간다. 그래서 스레드가 둘 이상인 좀비는 아직 돈다.
it("counts a process as running until its last thread ends", () => {
  expect(statRuns(statFields(stat("S", 1)))).toBe(true);
  expect(statRuns(statFields(stat("R", 7)))).toBe(true);
  expect(statRuns(statFields(stat("Z", 7)))).toBe(true);
  expect(statRuns(statFields(stat("Z", 1)))).toBe(false);
  expect(statRuns(statFields(stat("X", 1)))).toBe(false);
});
