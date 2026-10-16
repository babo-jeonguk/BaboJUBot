import { describe, expect, it } from "vitest";
import { createOrganizationInputSchema } from "./organization.ts";

describe("createOrganizationInputSchema", () => {
  it("accepts a name and trims it", () => {
    expect(
      createOrganizationInputSchema.parse({ name: "  음성 인식 오류 분석  " })
    ).toEqual({ name: "음성 인식 오류 분석" });
  });

  it("rejects a blank name", () => {
    expect(
      createOrganizationInputSchema.safeParse({ name: "   " }).success
    ).toBe(false);
  });

  it("rejects a name over the length limit", () => {
    expect(
      createOrganizationInputSchema.safeParse({ name: "가".repeat(121) })
        .success
    ).toBe(false);
  });

  it("rejects fields the server decides", () => {
    for (const extra of [
      { id: "x" },
      { stage: "researching" },
      { leadAgentId: "x" },
    ]) {
      expect(
        createOrganizationInputSchema.safeParse({ name: "조직", ...extra })
          .success
      ).toBe(false);
    }
  });
});
