import {
  agentRoles,
  lifecycleStages,
  orgToolNames,
  type InitialResearchProposal,
} from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  availableOrgTools,
  buildInitialResearchProposal,
  checkToolCall,
  planApprovalDecision,
} from "./approval.ts";
import type { HarnessLibraryContents } from "./harness.ts";

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

describe("availableOrgTools", () => {
  it("lists exactly the tools checkToolCall lets each role use in each stage", () => {
    for (const role of agentRoles)
      for (const stage of lifecycleStages)
        expect(availableOrgTools({ role, stage }), `${role} ${stage}`).toEqual(
          orgToolNames.filter((tool) => checkToolCall(tool, { role, stage }).ok)
        );
  });

  it("shows a worker in planning reads but no writes or Lead tools", () => {
    const tools = availableOrgTools({ role: "worker", stage: "planning" });
    expect(tools).toContain("get_task");
    expect(tools).toContain("get_run_context");
    for (const tool of [
      "add_worker",
      "create_task",
      "send_message",
      "request_initial_approval",
    ] as const)
      expect(tools).not.toContain(tool);
  });

  it("leaves only reads and the Lead's replies once the result is under review", () => {
    expect(
      availableOrgTools({ role: "lead", stage: "result_review" }).filter(
        (tool) => !/^(get|list|recall)_/.test(tool)
      )
    ).toEqual(["send_message", "write_memory"]);
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
    // 함께 들어와도 팀 순서가 들어온 시각에 남아 홈 자리가 이름과 상관없이 정해진다.
    expect(Date.parse(a!.createdAt)).toBeLessThan(Date.parse(b!.createdAt));
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

  it("names the team apart from every agent already in the organization", () => {
    // Lead를 작업자 이름 모양으로 바꾼 뒤 팀을 승인해도 이름이 겹치지 않는다.
    const plan = planApprovalDecision(
      approval,
      { decision: "approve" },
      { stage: "awaiting_approval", agentNames: ["연구원 1"] },
      source
    );
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.workers.map((w) => w.name)).toEqual(["연구원 2", "연구원 3"]);
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
        completionCriteria: null,
        workers: [],
        copies: [],
        template: null,
      });
      expect(plan.event.payload).toMatchObject({ decision, note: "사유" });
    }
  });

  it("leaves the organization's own criteria alone when approving", () => {
    const plan = decide({ decision: "approve" });
    expect(plan.completionCriteria).toBeNull();
    expect(plan.event.payload).not.toHaveProperty("completionCriteria");
  });

  it("fixes the Lead's proposed criteria only on approval", () => {
    const proposed = {
      ...approval,
      proposal: {
        ...proposal,
        completionCriteria: "Lead 기준",
        completionCriteriaProposed: true,
      },
    };
    const plan = (input: Parameters<typeof planApprovalDecision>[1]) => {
      const p = planApprovalDecision(proposed, input, awaiting, source);
      if (typeof p === "string") throw new Error(p);
      return p;
    };
    const approved = plan({ decision: "approve" });
    expect(approved.completionCriteria).toBe("Lead 기준");
    expect(approved.event.payload).toMatchObject({
      completionCriteria: "Lead 기준",
    });
    for (const decision of ["reject", "request_changes"] as const) {
      const sentBack = plan({ decision, note: "사유" });
      expect(sentBack.completionCriteria).toBeNull();
      expect(sentBack.event.payload).not.toHaveProperty("completionCriteria");
    }
  });
});

describe("buildInitialResearchProposal", () => {
  const library: HarnessLibraryContents = {
    roles: new Map([
      [
        "researcher",
        { agent: "worker", label: "연구원", files: [], heartbeatMinutes: 60 },
      ],
    ]),
    templates: new Map([
      [
        "basic-research",
        {
          name: "basic-research",
          label: "기본",
          description: "",
          nodeKinds: [],
          linkKinds: [],
          source: "templates/basic-research/template.json",
          sourceDigest: "t",
        },
      ],
    ]),
  } as unknown as HarnessLibraryContents;
  const input = {
    plan: "계획",
    environment: "환경",
    team: [{ role: "researcher", count: 1 }],
    template: "basic-research",
  };

  it("refuses a request without proposed criteria when the organization has none", () => {
    expect(
      buildInitialResearchProposal(
        { goal: "목표", completionCriteria: null },
        input,
        library
      )
    ).toBe("completion_criteria_required");
  });

  it("marks criteria the Lead proposed for an organization without any", () => {
    expect(
      buildInitialResearchProposal(
        { goal: "목표", completionCriteria: null },
        { ...input, completionCriteria: "Lead 기준" },
        library
      )
    ).toMatchObject({
      goal: "목표",
      completionCriteria: "Lead 기준",
      completionCriteriaProposed: true,
    });
  });

  it("keeps the owner's criteria and refuses a request that tries to replace them", () => {
    const owner = { goal: "목표", completionCriteria: "사용자 기준" };
    const built = buildInitialResearchProposal(owner, input, library);
    expect(built).toMatchObject({ completionCriteria: "사용자 기준" });
    expect(built).not.toHaveProperty("completionCriteriaProposed");
    expect(
      buildInitialResearchProposal(
        owner,
        { ...input, completionCriteria: "Lead 기준" },
        library
      )
    ).toBe("completion_criteria_set");
  });

  it("still requires a goal", () => {
    expect(
      buildInitialResearchProposal(
        { goal: null, completionCriteria: null },
        { ...input, completionCriteria: "Lead 기준" },
        library
      )
    ).toBe("goal_missing");
  });
});
