import type { InitialResearchProposal } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { checkToolCall, planApprovalDecision } from "./approval.ts";

const at = "2026-10-18T00:00:00.000Z";
let n = 0;
const source = { newId: () => `id-${++n}`, now: () => new Date(at) };

describe("checkToolCall", () => {
  it("keeps task creation and worker addition closed until research starts", () => {
    for (const stage of [
      "goal_setting",
      "planning",
      "awaiting_approval",
    ] as const)
      for (const tool of ["create_task", "add_worker"] as const)
        expect(checkToolCall(tool, { role: "lead", stage })).toEqual({
          ok: false,
          reason: "stage",
        });
    expect(
      checkToolCall("create_task", { role: "lead", stage: "researching" })
    ).toEqual({ ok: true });
  });

  it("opens task, artifact and agent message writes to every role only while researching, and their reads always", () => {
    const writes = [
      "create_task",
      "start_task",
      "complete_task",
      "comment_task",
      "record_artifact",
      "message_agent",
    ] as const;
    for (const role of ["lead", "worker"] as const)
      for (const tool of writes) {
        expect(checkToolCall(tool, { role, stage: "researching" })).toEqual({
          ok: true,
        });
        expect(
          checkToolCall(tool, { role, stage: "awaiting_approval" })
        ).toEqual({ ok: false, reason: "stage" });
      }
    for (const tool of ["list_tasks", "get_task", "get_artifact"] as const)
      expect(
        checkToolCall(tool, { role: "worker", stage: "planning" })
      ).toEqual({ ok: true });
    // 작업자는 사용자와 Lead 대화를 하지 않는다. 사용자에게는 작업 댓글로 답한다.
    expect(
      checkToolCall("send_message", { role: "worker", stage: "researching" })
    ).toEqual({ ok: false, reason: "role" });
  });

  it("opens goal recording and the initial approval request to the Lead only, in their stages", () => {
    expect(
      checkToolCall("record_goal", { role: "lead", stage: "goal_setting" })
    ).toEqual({ ok: true });
    // 합의한 목표는 계획 수립 이후 다시 기록할 수 없다. 목표 변경은 승인 정책 항목이다(ADR-0003, #58).
    for (const stage of [
      "planning",
      "awaiting_approval",
      "researching",
    ] as const)
      expect(checkToolCall("record_goal", { role: "lead", stage })).toEqual({
        ok: false,
        reason: "stage",
      });
    expect(
      checkToolCall("request_initial_approval", {
        role: "lead",
        stage: "goal_setting",
      })
    ).toEqual({ ok: false, reason: "stage" });
    expect(
      checkToolCall("request_initial_approval", {
        role: "lead",
        stage: "planning",
      })
    ).toEqual({ ok: true });
    expect(
      checkToolCall("record_goal", { role: "worker", stage: "goal_setting" })
    ).toEqual({ ok: false, reason: "role" });
  });
});

describe("planApprovalDecision", () => {
  const file = (path: string) => ({
    path,
    content: `${path} 내용`,
    source: `roles/researcher/${path}`,
    sourceDigest: "d",
  });
  const proposal: InitialResearchProposal = {
    goal: "목표",
    completionCriteria: "기준",
    plan: "계획",
    environment: "환경",
    team: [
      {
        role: "researcher",
        label: "연구원",
        count: 2,
        files: [file("AGENTS.md"), file("SOUL.md")],
      },
    ],
    template: {
      name: "basic-research",
      label: "기본",
      description: "",
      nodeKinds: [{ name: "problem", label: "연구 문제" }],
      linkKinds: [],
      source: "templates/basic-research/template.json",
      sourceDigest: "t",
    },
  };
  const approval = {
    id: "approval-1",
    organizationId: "org-1",
    kind: "initial_research" as const,
    requestedByAgentId: "lead-1",
    proposal,
  };
  const awaiting = { stage: "awaiting_approval" as const, agentNames: [] };
  const decide = (input: Parameters<typeof planApprovalDecision>[1]) => {
    const plan = planApprovalDecision(approval, input, awaiting, source);
    if (typeof plan === "string") throw new Error(plan);
    return plan;
  };

  it("approves into research with one worker per head, each owning separate copies", () => {
    const plan = decide({ decision: "approve" });
    expect(plan.status).toBe("approved");
    expect(plan.stage).toBe("researching");
    expect(plan.workers.map((w) => w.name)).toEqual(["연구원 1", "연구원 2"]);
    const [a, b] = plan.workers;
    const copiesOf = (id: string) =>
      plan.copies.filter((c) => c.agentId === id);
    expect(copiesOf(a!.id).map((c) => c.path)).toEqual([
      "AGENTS.md",
      "SOUL.md",
    ]);
    expect(copiesOf(a!.id).map((c) => c.kind)).toEqual(["role", "soul"]);
    const ids = plan.copies.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(copiesOf(a!.id).map((c) => c.content)).toEqual(
      copiesOf(b!.id).map((c) => c.content)
    );
    expect(plan.template).toMatchObject({
      organizationId: "org-1",
      approvalId: "approval-1",
      name: "basic-research",
    });
    expect(plan.wake).toMatchObject({
      agentId: "lead-1",
      kind: "approval_decision",
      approvalId: "approval-1",
    });
  });

  it("sends the organization back to planning with the reason and creates nothing on reject or change request", () => {
    for (const [decision, status] of [
      ["reject", "rejected"],
      ["request_changes", "changes_requested"],
    ] as const) {
      const plan = decide({ decision, note: "사유" });
      expect(plan).toMatchObject({
        status,
        stage: "planning",
        workers: [],
        copies: [],
        template: null,
      });
      expect(plan.event.payload).toMatchObject({ decision, note: "사유" });
    }
  });
});
