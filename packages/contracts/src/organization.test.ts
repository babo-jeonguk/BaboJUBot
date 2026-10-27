import { describe, expect, it } from "vitest";
import { createOrganizationInputSchema } from "./organization.ts";

const goal = "오류율을 절반으로 줄인다";

describe("createOrganizationInputSchema", () => {
  it("accepts a name, a goal and completion criteria, trimming each", () => {
    expect(
      createOrganizationInputSchema.parse({
        name: "  음성 인식 오류 분석  ",
        goal: `  ${goal}\n`,
        completionCriteria: " WER 10% 이하 ",
      })
    ).toEqual({
      name: "음성 인식 오류 분석",
      goal,
      completionCriteria: "WER 10% 이하",
    });
  });

  it("accepts empty or missing completion criteria", () => {
    expect(createOrganizationInputSchema.parse({ name: "조직", goal })).toEqual(
      { name: "조직", goal }
    );
    expect(
      createOrganizationInputSchema.parse({
        name: "조직",
        goal,
        completionCriteria: "   ",
      })
    ).toEqual({ name: "조직", goal, completionCriteria: "" });
  });

  it("requires a goal", () => {
    for (const body of [
      { name: "조직" },
      { name: "조직", goal: "   " },
      { name: "조직", goal: "가".repeat(4_001) },
    ])
      expect(
        createOrganizationInputSchema.safeParse(body).success,
        JSON.stringify(body).slice(0, 40)
      ).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(
      createOrganizationInputSchema.safeParse({ name: "   ", goal }).success
    ).toBe(false);
  });

  it("rejects a name over the length limit", () => {
    expect(
      createOrganizationInputSchema.safeParse({ name: "가".repeat(121), goal })
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
        createOrganizationInputSchema.safeParse({
          name: "조직",
          goal,
          ...extra,
        }).success
      ).toBe(false);
    }
  });
});
