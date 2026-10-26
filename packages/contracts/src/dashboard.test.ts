import { describe, expect, it } from "vitest";
import { activeRunCount, runSuccessRate, timeZoneSchema } from "./dashboard.ts";

const finished = (completed: number, failed: number, cancelled = 0) => ({
  completed,
  failed,
  cancelled,
  server_restart: 0,
});

describe("runSuccessRate", () => {
  it("divides completed by completed plus failed, leaving cancellations out", () => {
    expect(runSuccessRate([finished(3, 1, 2)])).toEqual({
      completed: 3,
      failed: 1,
      rate: 0.75,
    });
  });

  it("sums numerators and denominators across days before dividing", () => {
    // 하루씩 낸 비율의 평균(50%)이 아니라 4/5다.
    expect(runSuccessRate([finished(1, 1), finished(3, 0)]).rate).toBe(0.8);
  });

  it("has no rate when no run ended in success or failure", () => {
    expect(runSuccessRate([finished(0, 0, 4)]).rate).toBeNull();
    expect(runSuccessRate([]).rate).toBeNull();
  });
});

describe("activeRunCount", () => {
  it("leaves out runs that are cleaning up after a cancellation", () => {
    expect(activeRunCount({ running: 3, cancelling: 1 })).toBe(2);
  });
});

describe("timeZoneSchema", () => {
  it("accepts IANA names", () => {
    for (const tz of [
      "UTC",
      "Asia/Seoul",
      "America/Argentina/Buenos_Aires",
      "Etc/GMT+9",
    ])
      expect(timeZoneSchema.safeParse(tz).success, tz).toBe(true);
  });

  it("rejects offsets and anything that is not a name", () => {
    for (const tz of [
      "+09:00",
      "",
      "Asia/",
      "/Seoul",
      "Asia Seoul",
      "a".repeat(65),
    ])
      expect(timeZoneSchema.safeParse(tz).success, tz).toBe(false);
  });
});
