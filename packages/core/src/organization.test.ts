import { describe, expect, it } from "vitest";
import { planOrganizationCreation } from "./organization.ts";

const ids = () => {
  const queue = [
    "org-1",
    "lead-1",
    "copy-1",
    "copy-2",
    "conversation-1",
    "wake-1",
  ];
  return () => queue.shift()!;
};
const leadFiles = ["AGENTS.md", "SOUL.md"].map((path) => ({
  path,
  content: `${path} 내용`,
  source: `roles/lead/${path}`,
  sourceDigest: "d",
}));
const now = () => new Date("2026-10-16T00:00:00.000Z");
const create = (input: { completionCriteria?: string }) =>
  planOrganizationCreation(
    { name: "음성 인식 오류 분석", goal: "오류율을 절반으로", ...input },
    { files: leadFiles, heartbeatMinutes: 90 },
    { newId: ids(), now }
  );

describe("planOrganizationCreation", () => {
  const plan = create({ completionCriteria: "WER 10% 이하" });

  it("starts the organization in planning with the owner's goal and criteria and every approval policy off", () => {
    expect(plan.organization).toEqual({
      id: "org-1",
      name: "음성 인식 오류 분석",
      stage: "planning",
      goal: "오류율을 절반으로",
      completionCriteria: "WER 10% 이하",
      approvalPolicy: { addWorker: false },
      pausedFrom: null,
      createdAt: "2026-10-16T00:00:00.000Z",
    });
  });

  it("leaves the completion criteria unset when the owner left them empty", () => {
    for (const completionCriteria of [undefined, ""]) {
      const { organization, event } = create({ completionCriteria });
      expect(organization.completionCriteria).toBeNull();
      expect(event.payload).toMatchObject({ completionCriteria: null });
    }
  });

  it("wakes the new Lead to draft the initial research request", () => {
    expect(plan.wake).toEqual({
      id: "wake-1",
      organizationId: "org-1",
      agentId: "lead-1",
      kind: "organization_created",
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

  it("starts the default conversation with the Lead together with the organization", () => {
    expect(plan.defaultConversation).toEqual({
      id: "conversation-1",
      organizationId: "org-1",
      title: "기본 대화",
      isDefault: true,
      createdAt: "2026-10-16T00:00:00.000Z",
    });
  });

  it("records an organization.created Event carrying the owner's goal and the woken Lead", () => {
    expect(plan.event).toEqual({
      organizationId: "org-1",
      type: "organization.created",
      payload: {
        name: "음성 인식 오류 분석",
        stage: "planning",
        leadAgentId: "lead-1",
        goal: "오류율을 절반으로",
        completionCriteria: "WER 10% 이하",
        wokenAgentId: "lead-1",
      },
    });
  });
});
