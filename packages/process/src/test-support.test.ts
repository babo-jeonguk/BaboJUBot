import { describe, expect, it, onTestFinished, vi } from "vitest";
import { reportedPid, within } from "./test-support.ts";

// 상한은 실제 시간으로 잰다. 시험이 가짜 시계를 켜도(`vi.useFakeTimers`) 그 시험의 기다림은 상한에서 실패해야 한다. 가짜 시계에 묶이면
// 시험이 시간을 옮기지 않는 한 상한이 지나지 않아, 상한 없는 기다림이 된다.
it("measures its limit in real time while a test fakes the clock", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });

  await expect(
    within(new Promise<never>(() => {}), 50, "nothing arrived")
  ).rejects.toThrow(new Error("nothing arrived within 50 ms"));
}, 5_000);

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
