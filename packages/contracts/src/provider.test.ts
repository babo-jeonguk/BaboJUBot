import { describe, expect, it } from "vitest";
import {
  providerChoiceSchema,
  updateProviderLimitInputSchema,
} from "./provider.ts";
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
