import { describe, expect, it } from "vitest";
import {
  providerCapabilitiesSchema,
  providerChoiceSchema,
  providerReadinessCheckSchema,
  updateProviderLimitInputSchema,
} from "./provider.ts";
import { usageSchema } from "./run.ts";
import { createOrganizationInputSchema } from "./organization.ts";

describe("provider choice", () => {
  it("takes a connection ID and a model, or no model for the provider's default", () => {
    expect(
      providerChoiceSchema.parse({ provider: "fake-2", model: null })
    ).toEqual({ provider: "fake-2", model: null });
    expect(
      providerChoiceSchema.safeParse({ provider: "Fake 2", model: null })
        .success
    ).toBe(false);
    expect(
      providerChoiceSchema.safeParse({ provider: "fake", model: "  " }).success
    ).toBe(false);
    // 조직 생성의 Lead 칸은 생략하면 서버가 전역 Lead 기본값을 쓴다.
    expect(
      createOrganizationInputSchema.parse({ name: "조직", goal: "목표" }).lead
    ).toBeUndefined();
  });

  it("accepts any cap from 0 (unlimited) up, and nothing below", () => {
    for (const maxConcurrentRuns of [0, 1, 2, 500])
      expect(
        updateProviderLimitInputSchema.safeParse({ maxConcurrentRuns }).success
      ).toBe(true);
    for (const maxConcurrentRuns of [-1, 1.5])
      expect(
        updateProviderLimitInputSchema.safeParse({ maxConcurrentRuns }).success
      ).toBe(false);
  });
});

describe("provider declarations", () => {
  const every = {
    steer: true,
    resume: true,
    reinjectInstructionsOnResume: false,
    usageTokens: true,
    usageCost: false,
    precompact: false,
  };

  it("needs every capability declared, with no defaults and nothing extra", () => {
    expect(providerCapabilitiesSchema.parse(every)).toEqual(every);
    const { usageCost: _left, ...missing } = every;
    expect(providerCapabilitiesSchema.safeParse(missing).success).toBe(false);
    expect(
      providerCapabilitiesSchema.safeParse({ ...every, extra: true }).success
    ).toBe(false);
  });

  it("gives a reason exactly when a provider is not ready or unknown", () => {
    expect(
      providerReadinessCheckSchema.safeParse({ status: "ready", reason: null })
        .success
    ).toBe(true);
    expect(
      providerReadinessCheckSchema.safeParse({
        status: "not_ready",
        reason: "product_login_missing",
      }).success
    ).toBe(true);
    for (const wrong of [
      { status: "ready", reason: "check_failed" },
      { status: "unknown", reason: null },
    ])
      expect(providerReadinessCheckSchema.safeParse(wrong).success).toBe(false);
  });

  it("keeps a reported zero apart from an unreported figure in usage", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 12,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    };
    expect(usageSchema.parse(usage)).toEqual(usage);
    expect(usageSchema.safeParse({ ...usage, inputTokens: -1 }).success).toBe(
      false
    );
    const { cacheReadTokens: _missing, ...partial } = usage;
    expect(usageSchema.safeParse(partial).success).toBe(false);
  });
});
