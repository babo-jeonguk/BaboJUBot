import { describe, expect, it } from "vitest";
import {
  addUsage,
  isolateUsageNumbers,
  settleUsage,
  subtractUsage,
  usageAmount,
  usageSchema,
} from "./usage.ts";

const unsafe = Number.MAX_SAFE_INTEGER + 1;

describe("usage number rules", () => {
  it("keeps reported zero, unreported null and the safe range, and marks the rest as anomalies", () => {
    expect(usageAmount("tokens", 0)).toBe(0);
    expect(usageAmount("tokens", Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(usageAmount("tokens", undefined)).toBeNull();
    expect(usageAmount("tokens", null)).toBeNull();
    for (const raw of [1.5, -1, Number.NaN, Infinity, unsafe, "10"])
      expect(settleUsage({ inputTokens: usageAmount("tokens", raw) })).toEqual({
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: null,
        },
        anomalies: [{ field: "inputTokens", reason: "invalid_value" }],
      });
  });

  it("keeps fractional and zero USD and rejects non-finite or negative cost", () => {
    expect(usageAmount("usd", 0.0751)).toBe(0.0751);
    expect(usageAmount("usd", 0)).toBe(0);
    for (const raw of [-0.01, Infinity, Number.NaN])
      expect(
        settleUsage({ costUsd: usageAmount("usd", raw) }).anomalies
      ).toEqual([{ field: "costUsd", reason: "invalid_value" }]);
  });

  it("keeps a sum null once an anomaly is in it, even when valid reports follow", () => {
    let output = addUsage("tokens", null, usageAmount("tokens", 100));
    output = addUsage("tokens", output, usageAmount("tokens", -3));
    output = addUsage("tokens", output, usageAmount("tokens", 50));
    expect(settleUsage({ outputTokens: output })).toMatchObject({
      usage: { outputTokens: null },
      anomalies: [{ field: "outputTokens", reason: "invalid_value" }],
    });
    // Unreported turns are skipped like before.
    expect(addUsage("tokens", addUsage("tokens", null, 100), null)).toBe(100);
    expect(addUsage("tokens", null, null)).toBeNull();
  });

  it("reports an overflowing sum as an anomaly", () => {
    expect(
      settleUsage({
        inputTokens: addUsage("tokens", Number.MAX_SAFE_INTEGER, 1),
      }).anomalies
    ).toEqual([{ field: "inputTokens", reason: "overflow" }]);
  });

  it("does not clamp a decrease and propagates an invalid operand", () => {
    expect(subtractUsage("tokens", 100, 40)).toBe(60);
    expect(subtractUsage("tokens", 100, 100)).toBe(0);
    expect(subtractUsage("tokens", null, 40)).toBeNull();
    expect(subtractUsage("tokens", 100, null)).toBeNull();
    const settled = settleUsage({
      inputTokens: subtractUsage("tokens", 100, 120),
      cacheReadTokens: 120,
      outputTokens: subtractUsage("tokens", 5, usageAmount("tokens", 0.5)),
      costUsd: subtractUsage("usd", 0.3, 0.1),
    });
    expect(settled.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: 120,
      cacheWriteTokens: null,
      costUsd: expect.closeTo(0.2, 9),
    });
    expect(settled.anomalies).toEqual([
      { field: "inputTokens", reason: "negative_result" },
      { field: "outputTokens", reason: "invalid_operand" },
    ]);
  });

  it("isolates only invalid usage numbers and leaves other shapes to the schema", () => {
    const { value, anomalies } = isolateUsageNumbers({
      inputTokens: 3,
      outputTokens: 1.5,
      cacheReadTokens: null,
      cacheWriteTokens: -1,
      costUsd: 0.25,
    });
    expect(value).toEqual({
      inputTokens: 3,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.25,
    });
    expect(anomalies).toEqual([
      { field: "outputTokens", reason: "invalid_value" },
      { field: "cacheWriteTokens", reason: "invalid_value" },
    ]);
    expect(usageSchema.safeParse(value).success).toBe(true);
    // A malformed usage shape is not repaired here.
    const wrong = { inputTokens: 1, extra: 2 };
    expect(isolateUsageNumbers(wrong)).toEqual({ value: wrong, anomalies: [] });
    expect(isolateUsageNumbers(null)).toEqual({ value: null, anomalies: [] });
  });

  it("matches the schema's accepted range", () => {
    const usage = (inputTokens: unknown, costUsd: unknown) => ({
      inputTokens,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd,
    });
    expect(
      usageSchema.safeParse(usage(Number.MAX_SAFE_INTEGER, 0.5)).success
    ).toBe(true);
    expect(usageSchema.safeParse(usage(unsafe, 0)).success).toBe(false);
    expect(usageSchema.safeParse(usage(1.5, 0)).success).toBe(false);
    expect(usageSchema.safeParse(usage(0, Infinity)).success).toBe(false);
  });
});
