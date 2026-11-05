import { expect, it } from "vitest";
import { shutdownBudget } from "../src/shutdown-budget.ts";

// 종료 시한은 프로세스가 끝나는 시각까지다. 내장 DB의 비상 정지 몫만 남기고, 외부 DB나 짧은 시한에서 정리 시간을 없애지 않는다.
it.each([
  { deadlineMs: 30_000, embedded: true, cleanupMs: 28_500, emergencyMs: 1_500 },
  { deadlineMs: 2_000, embedded: true, cleanupMs: 1_000, emergencyMs: 1_000 },
  { deadlineMs: 1_000, embedded: true, cleanupMs: 500, emergencyMs: 500 },
  { deadlineMs: 1, embedded: true, cleanupMs: 1, emergencyMs: 0 },
  { deadlineMs: 1_000, embedded: false, cleanupMs: 1_000, emergencyMs: 0 },
  { deadlineMs: 30_000, embedded: false, cleanupMs: 30_000, emergencyMs: 0 },
])(
  "splits a $deadlineMs ms deadline (embedded database: $embedded)",
  ({ deadlineMs, embedded, cleanupMs, emergencyMs }) => {
    expect(shutdownBudget(deadlineMs, embedded)).toEqual({
      cleanupMs,
      emergencyMs,
    });
  }
);
