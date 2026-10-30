import type { AddWorkerProposal } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { planApprovalDecision } from "./approval.ts";
import type { HarnessLibraryContents } from "./harness.ts";
import {
  buildAddWorkerProposal,
  nextWorkerName,
  planAddWorker,
} from "./worker.ts";

const at = "2026-10-22T00:00:00.000Z";
let n = 0;
const source = { newId: () => `id-${++n}`, now: () => new Date(at) };
const run = { id: "run-1", organizationId: "org-1", agentId: "lead-1" };

const files = [
  {
    path: "AGENTS.md",
    content: "# 조사자",
    source: "roles/researcher/AGENTS.md",
    sourceDigest: "d1",
  },
  {
    path: "SOUL.md",
    content: "# 성향",
    source: "roles/researcher/SOUL.md",
    sourceDigest: "d2",
  },
];
const library: HarnessLibraryContents = {
  roles: new Map([
    [
      "researcher",
      {
        label: "문헌 조사자",
        agent: "worker",
        skills: [],
        files,
        heartbeatMinutes: 30,
      },
    ],
    [
      "lead",
      {
        label: "Research Lead",
        agent: "lead",
        skills: [],
        files,
        heartbeatMinutes: 60,
      },
    ],
  ]),
  templates: new Map(),
};
const proposal: AddWorkerProposal = {
  role: "researcher",
  label: "문헌 조사자",
  files,
  heartbeatMinutes: 30,
};

describe("buildAddWorkerProposal", () => {
  it("fixes the library's worker Role contents and refuses Lead or unknown Roles", () => {
    expect(buildAddWorkerProposal({ role: "researcher" }, library)).toEqual(
      proposal
    );
    expect(buildAddWorkerProposal({ role: "lead" }, library)).toBe(
      "unknown_role"
    );
    expect(buildAddWorkerProposal({ role: "nobody" }, library)).toBe(
      "unknown_role"
    );
  });
});

describe("nextWorkerName", () => {
  it("numbers after the highest existing worker of the same label", () => {
    expect(nextWorkerName("문헌 조사자", [])).toBe("문헌 조사자 1");
    expect(
      nextWorkerName("문헌 조사자", [
        "Research Lead",
        "문헌 조사자 1",
        "문헌 조사자 3",
        "실험자 7",
      ])
    ).toBe("문헌 조사자 4");
  });

  it("never takes a name any agent of the organization already has, ignoring case", () => {
    // Lead가 작업자 이름 모양으로 이름을 바꿨으면 그 번호도 쓰인 번호다.
    expect(nextWorkerName("연구원", ["연구원 1"])).toBe("연구원 2");
    // 대소문자만 다른 이름도 같은 표시 이름의 번호로 센다.
    expect(nextWorkerName("Analyst", ["analyst 1", "ANALYST 3"])).toBe(
      "Analyst 4"
    );
    // 가장 큰 번호 + 1을 누가 쓰면 다음 번호로 넘어간다.
    expect(nextWorkerName("Analyst", ["Analyst 1", " analyst 2 "])).toBe(
      "Analyst 3"
    );
  });
});

describe("planAddWorker", () => {
  it("creates the worker with its own copies right away when the policy is off", () => {
    const plan = planAddWorker(
      run,
      proposal,
      {
        policy: { addWorker: false },
        stage: "researching",
        agentNames: [],
        workerDefault: { provider: "fake-2", model: "fake-2-mini" },
      },
      source
    );
    if (plan.kind !== "added") throw new Error(plan.kind);
    expect(plan.worker).toMatchObject({
      organizationId: "org-1",
      role: "worker",
      name: "문헌 조사자 1",
      // 만들 때 읽은 전역 작업자 기본값을 복사한다.
      provider: "fake-2",
      model: "fake-2-mini",
    });
    expect(plan.copies.map((c) => [c.agentId, c.path, c.content])).toEqual([
      [plan.worker.id, "AGENTS.md", "# 조사자"],
      [plan.worker.id, "SOUL.md", "# 성향"],
    ]);
    expect(new Set(plan.copies.map((c) => c.id)).size).toBe(2);
    expect(plan.event).toEqual({
      organizationId: "org-1",
      type: "worker.added",
      payload: {
        runId: "run-1",
        agentId: "lead-1",
        workerAgentId: plan.worker.id,
        role: "researcher",
      },
    });
  });

  it("only files an approval request, keeping the stage, when the policy is on", () => {
    const plan = planAddWorker(
      run,
      proposal,
      {
        policy: { addWorker: true },
        stage: "researching",
        agentNames: [],
        workerDefault: { provider: "fake-2", model: "fake-2-mini" },
      },
      source
    );
    if (plan.kind !== "pending_approval") throw new Error(plan.kind);
    expect(plan.approval).toMatchObject({
      organizationId: "org-1",
      kind: "add_worker",
      requestedByAgentId: "lead-1",
      requestedByRunId: "run-1",
      previousApprovalId: null,
      proposal,
    });
    expect(plan.event).toMatchObject({
      type: "approval.requested",
      payload: { kind: "add_worker", stage: "researching" },
    });
  });
});

describe("planApprovalDecision for add_worker", () => {
  const approval = {
    id: "ap-1",
    organizationId: "org-1",
    kind: "add_worker" as const,
    requestedByAgentId: "lead-1",
    proposal,
  };

  it("approving creates one worker from the snapshot, keeps the stage and wakes the Lead", () => {
    const plan = planApprovalDecision(
      approval,
      { decision: "approve" },
      {
        stage: "result_review",
        agentNames: ["문헌 조사자 1"],
        workerDefault: { provider: "fake-2", model: "fake-2-mini" },
      },
      source
    );
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.status).toBe("approved");
    expect(plan.stage).toBe("result_review");
    expect(plan.workers.map((w) => w.name)).toEqual(["문헌 조사자 2"]);
    expect(plan.copies.map((c) => c.content)).toEqual(["# 조사자", "# 성향"]);
    expect(plan.template).toBeNull();
    expect(plan.wake).toMatchObject({
      agentId: "lead-1",
      kind: "approval_decision",
      approvalId: "ap-1",
    });
    expect(plan.event.payload).toMatchObject({
      kind: "add_worker",
      decision: "approve",
      stage: "result_review",
      createdAgentIds: [plan.workers[0]!.id],
    });
  });

  it("names the new worker apart from a Lead renamed to a worker-shaped name", () => {
    const plan = planApprovalDecision(
      approval,
      { decision: "approve" },
      {
        stage: "researching",
        agentNames: ["문헌 조사자 1"],
        workerDefault: { provider: "fake-2", model: "fake-2-mini" },
      },
      source
    );
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.workers.map((w) => w.name)).toEqual(["문헌 조사자 2"]);
  });

  it("rejecting creates nothing, keeps the stage and wakes the Lead with the reason", () => {
    const plan = planApprovalDecision(
      approval,
      { decision: "reject", note: "지금은 인원이 충분하다" },
      {
        stage: "researching",
        agentNames: [],
        workerDefault: { provider: "fake-2", model: "fake-2-mini" },
      },
      source
    );
    if (typeof plan === "string") throw new Error(plan);
    expect(plan).toMatchObject({
      status: "rejected",
      note: "지금은 인원이 충분하다",
      stage: "researching",
      workers: [],
      copies: [],
    });
    expect(plan.event.payload).toMatchObject({ createdAgentIds: [] });
  });

  it("has no change request for a worker addition", () => {
    expect(
      planApprovalDecision(
        approval,
        { decision: "request_changes", note: "다른 Role로" },
        {
          stage: "researching",
          agentNames: [],
          workerDefault: { provider: "fake-2", model: "fake-2-mini" },
        },
        source
      )
    ).toBe("decision_not_allowed");
  });
});
