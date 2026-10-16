import { describe, expect, it } from "vitest";
import { planOrganizationCreation } from "./organization.ts";

const ids = ["org-1", "lead-1"];
const deps = { newId: () => ids.shift()!, now: () => new Date("2026-10-16T00:00:00.000Z") };

describe("planOrganizationCreation", () => {
  const plan = planOrganizationCreation({ name: "음성 인식 오류 분석" }, deps);

  it("starts the organization in goal setting", () => {
    expect(plan.organization).toEqual({
      id: "org-1",
      name: "음성 인식 오류 분석",
      stage: "goal_setting",
      createdAt: "2026-10-16T00:00:00.000Z",
    });
  });

  it("gives the organization exactly one dedicated Research Lead", () => {
    expect(plan.agents).toEqual([
      { id: "lead-1", organizationId: "org-1", role: "lead", name: "Research Lead", createdAt: "2026-10-16T00:00:00.000Z" },
    ]);
  });

  it("records an organization.created Event bound to the new organization", () => {
    expect(plan.event).toEqual({
      organizationId: "org-1",
      type: "organization.created",
      payload: { name: "음성 인식 오류 분석", stage: "goal_setting", leadAgentId: "lead-1" },
    });
  });
});
