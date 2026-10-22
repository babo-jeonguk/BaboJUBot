import { describe, expect, it } from "vitest";
import { planOrganizationCreation } from "./organization.ts";

const ids = ["org-1", "lead-1", "copy-1", "copy-2"];
const leadFiles = ["AGENTS.md", "SOUL.md"].map((path) => ({
  path,
  content: `${path} 내용`,
  source: `roles/lead/${path}`,
  sourceDigest: "d",
}));
const deps = {
  newId: () => ids.shift()!,
  now: () => new Date("2026-10-16T00:00:00.000Z"),
};

describe("planOrganizationCreation", () => {
  const plan = planOrganizationCreation(
    { name: "음성 인식 오류 분석" },
    { files: leadFiles, heartbeatMinutes: 90 },
    deps
  );

  it("starts the organization in goal setting with every approval policy off", () => {
    expect(plan.organization).toEqual({
      id: "org-1",
      name: "음성 인식 오류 분석",
      stage: "goal_setting",
      goal: null,
      completionCriteria: null,
      approvalPolicy: { addWorker: false },
      pausedFrom: null,
      createdAt: "2026-10-16T00:00:00.000Z",
    });
  });

  it("copies the library's Lead Role and Soul into copies the Lead owns", () => {
    expect(plan.instructionCopies).toEqual([
      expect.objectContaining({
        id: "copy-1",
        agentId: "lead-1",
        organizationId: "org-1",
        kind: "role",
        path: "AGENTS.md",
        source: "roles/lead/AGENTS.md",
      }),
      expect.objectContaining({ id: "copy-2", kind: "soul", path: "SOUL.md" }),
    ]);
  });

  it("gives the organization exactly one dedicated Research Lead with its Role's heartbeat interval", () => {
    expect(plan.agents).toEqual([
      {
        id: "lead-1",
        organizationId: "org-1",
        role: "lead",
        name: "Research Lead",
        createdAt: "2026-10-16T00:00:00.000Z",
        heartbeatMinutes: 90,
      },
    ]);
  });

  it("records an organization.created Event bound to the new organization", () => {
    expect(plan.event).toEqual({
      organizationId: "org-1",
      type: "organization.created",
      payload: {
        name: "음성 인식 오류 분석",
        stage: "goal_setting",
        leadAgentId: "lead-1",
      },
    });
  });
});
