import { describe, expect, it } from "vitest";
import { reportedPid } from "./test-support.ts";

// 다른 프로세스가 알린 번호는 신호의 대상이 된다. 빈 글자·잘린 글자를 숫자로 바꾸면 0(프로세스 그룹 전체)이나 NaN이 되어, 정리가
// 엉뚱한 대상에 신호하거나 대상 없이 지나간다(#288 외부 리뷰 3회차 STD-4 같은 모양 수색). 그래서 받은 값의 모양을 확인한다.
describe("reportedPid", () => {
  it.each([
    ["4321", 4321],
    ["4321\n", 4321],
    [4321, 4321],
  ])("reads %j as process %i", (value, pid) => {
    expect(reportedPid(value, "the pid file")).toBe(pid);
  });

  it.each([
    "",
    "\n",
    "0",
    "-5",
    "1.5",
    "12abc",
    "4321 Tue",
    0,
    Number.NaN,
    null,
    undefined,
  ])("rejects %j with what it was and what it got", (value) => {
    expect(() => reportedPid(value, "the pid file")).toThrow(
      `the pid file is not a process number: ${JSON.stringify(value)}`
    );
  });
});
