import type {
  Agent,
  AgentRole,
  ApprovalDecision,
  ApprovalKind,
  ApprovalStatus,
  FlowTemplateCopy,
  InitialResearchProposal,
  InstructionCopy,
  InstructionSourceFile,
  LifecycleStage,
  NewEvent,
  OrgToolName,
  RecordGoalInput,
  RequestInitialApprovalInput,
} from "@babojubot/contracts";
import { instructionKindOf, type HarnessLibraryContents } from "./harness.ts";
import type { RecordSource } from "./organization.ts";
import type { Wake } from "./run.ts";

// 목표 기록 → 초기 연구 승인 요청 → 사용자 결정. 초기 연구 승인은 끌 수 없는 제품 규칙이다(ADR-0003).
// 역할 문서가 아니라 여기의 도구 규칙과 저장 쪽의 조건부 갱신이 승인 전 실행을 막는다.

const anyStage = "any" as const;
type ToolRule = {
  roles: readonly AgentRole[];
  stages: readonly LifecycleStage[] | typeof anyStage;
};
const everyone = ["lead", "worker"] as const;
const leadOnly = ["lead"] as const;

/**
 * Role·생애주기 단계별 조직 도구 규칙. `목표 설정`·`계획 수립`·`승인 대기`에는 조회·메시지·계획 도구만 열리고,
 * 작업 생성과 작업자 추가는 `연구 진행`에서만 열린다.
 */
export const toolRules: Record<OrgToolName, ToolRule> = {
  get_run_context: { roles: everyone, stages: anyStage },
  get_message: { roles: everyone, stages: anyStage },
  // 첫 판은 Lead만 사용자와 대화한다. 작업자는 작업 댓글로만 사용자와 이어진다(docs/features.md).
  send_message: { roles: leadOnly, stages: anyStage },
  get_harness_library: { roles: leadOnly, stages: anyStage },
  record_goal: { roles: leadOnly, stages: ["goal_setting", "planning"] },
  request_initial_approval: { roles: leadOnly, stages: ["planning"] },
  create_task: { roles: everyone, stages: ["researching"] },
  add_worker: { roles: leadOnly, stages: ["researching"] },
};

export type ToolCheck = { ok: true } | { ok: false; reason: "role" | "stage" };

/** 이 Role의 에이전트가 이 단계의 조직에서 이 도구를 쓸 수 있는가. Role 거부가 단계 거부보다 먼저다. */
export function checkToolCall(
  tool: OrgToolName,
  { role, stage }: { role: AgentRole; stage: LifecycleStage }
): ToolCheck {
  const rule = toolRules[tool];
  if (!rule.roles.includes(role)) return { ok: false, reason: "role" };
  if (rule.stages !== anyStage && !rule.stages.includes(stage))
    return { ok: false, reason: "stage" };
  return { ok: true };
}

type RunRef = { id: string; organizationId: string; agentId: string };

/** 거부한 도구 호출의 Event. 호출한 실행 시도에 귀속한다. */
export const toolRefusedEvent = (
  run: RunRef,
  tool: OrgToolName,
  stage: LifecycleStage,
  reason: "role" | "stage"
): NewEvent => ({
  organizationId: run.organizationId,
  type: "tool.refused",
  payload: { runId: run.id, agentId: run.agentId, tool, stage, reason },
});

/** 목표 설정에서 기록하면 계획 수립으로 넘어간다. 계획 수립 중에 다시 기록하면 단계는 그대로다. */
export function planGoalRecord(
  run: RunRef,
  input: RecordGoalInput
): { stage: LifecycleStage; event: NewEvent } {
  const stage: LifecycleStage = "planning";
  return {
    stage,
    event: {
      organizationId: run.organizationId,
      type: "organization.goal_recorded",
      payload: { runId: run.id, agentId: run.agentId, ...input, stage },
    },
  };
}

export type ProposalProblem =
  "goal_missing" | "unknown_role" | "unknown_template";

/**
 * 제출 내용과 지금의 하네스 라이브러리로 승인 대상 snapshot을 만든다. 팀 구성의 Role은 라이브러리의 작업자 Role이어야 한다.
 * 이 snapshot이 사용자가 검토하고 승인하는 내용 그대로이며, 승인 때 라이브러리를 다시 읽지 않는다.
 */
export function buildInitialResearchProposal(
  organization: { goal: string | null; completionCriteria: string | null },
  input: RequestInitialApprovalInput,
  library: HarnessLibraryContents
): InitialResearchProposal | ProposalProblem {
  if (!organization.goal || !organization.completionCriteria)
    return "goal_missing";
  const team: InitialResearchProposal["team"] = [];
  for (const member of input.team) {
    const role = library.roles.get(member.role);
    if (!role || role.agent !== "worker") return "unknown_role";
    team.push({
      role: member.role,
      label: role.label,
      count: member.count,
      files: role.files,
    });
  }
  const template = library.templates.get(input.template);
  if (!template) return "unknown_template";
  return {
    goal: organization.goal,
    completionCriteria: organization.completionCriteria,
    plan: input.plan,
    environment: input.environment,
    team,
    template,
  };
}

export type NewApproval = {
  id: string;
  organizationId: string;
  kind: ApprovalKind;
  requestedByAgentId: string;
  requestedByRunId: string;
  previousApprovalId: string | null;
  proposal: InitialResearchProposal;
  createdAt: string;
};

/** 초기 연구 승인 요청은 조직을 승인 대기로 넘긴다. 반려·수정 요청 뒤의 재제출은 새 요청이며 직전 요청을 가리킨다. */
export function planInitialApprovalRequest(
  run: RunRef,
  proposal: InitialResearchProposal,
  previousApprovalId: string | null,
  { newId, now }: RecordSource
): { approval: NewApproval; stage: LifecycleStage; event: NewEvent } {
  const stage: LifecycleStage = "awaiting_approval";
  const approval: NewApproval = {
    id: newId(),
    organizationId: run.organizationId,
    kind: "initial_research",
    requestedByAgentId: run.agentId,
    requestedByRunId: run.id,
    previousApprovalId,
    proposal,
    createdAt: now().toISOString(),
  };
  return {
    approval,
    stage,
    event: {
      organizationId: run.organizationId,
      type: "approval.requested",
      payload: {
        approvalId: approval.id,
        kind: approval.kind,
        runId: run.id,
        agentId: run.agentId,
        stage,
      },
    },
  };
}

export const decisionStatus: Record<
  ApprovalDecision,
  Exclude<ApprovalStatus, "pending">
> = {
  approve: "approved",
  reject: "rejected",
  request_changes: "changes_requested",
};

export type ApprovalDecisionPlan = {
  status: Exclude<ApprovalStatus, "pending">;
  note: string | null;
  decidedAt: string;
  stage: LifecycleStage;
  workers: Agent[];
  copies: InstructionCopy[];
  template: FlowTemplateCopy | null;
  wake: Wake;
  event: NewEvent;
};

/**
 * 결정을 기다리는 초기 연구 승인 요청에 대한 사용자 결정. 승인하면 `연구 진행`으로 넘어가고, snapshot의 팀 구성대로
 * 작업자를 만들어 각자에게 따로 Role·Soul·Skill 사본을 주며 흐름 템플릿을 조직 사본으로 둔다. 반려·수정 요청은
 * 아무것도 만들지 않고 `계획 수립`으로 돌린다. 어느 결정이든 요청한 Lead를 그 사유로 깨운다.
 * 한 번만 결정할 수 있다는 규칙은 저장 쪽의 조건부 갱신이 강제한다.
 */
export function planApprovalDecision(
  approval: {
    id: string;
    organizationId: string;
    kind: ApprovalKind;
    requestedByAgentId: string;
    proposal: InitialResearchProposal;
  },
  input: { decision: ApprovalDecision; note?: string },
  { newId, now }: RecordSource
): ApprovalDecisionPlan {
  const createdAt = now().toISOString();
  const { organizationId, proposal } = approval;
  const approved = input.decision === "approve";
  const workers: Agent[] = [];
  const copies: InstructionCopy[] = [];
  if (approved)
    for (const member of proposal.team)
      for (let i = 1; i <= member.count; i++) {
        const worker: Agent = {
          id: newId(),
          organizationId,
          role: "worker",
          name: `${member.label} ${i}`,
          createdAt,
        };
        workers.push(worker);
        copies.push(
          ...copyInstructions(worker, member.files, { newId, createdAt })
        );
      }
  const template: FlowTemplateCopy | null = approved
    ? {
        ...proposal.template,
        id: newId(),
        organizationId,
        approvalId: approval.id,
        createdAt,
      }
    : null;
  const note = input.note || null;
  const stage: LifecycleStage = approved ? "researching" : "planning";
  return {
    status: decisionStatus[input.decision],
    note,
    decidedAt: createdAt,
    stage,
    workers,
    copies,
    template,
    wake: {
      id: newId(),
      organizationId,
      agentId: approval.requestedByAgentId,
      kind: "approval_decision",
      approvalId: approval.id,
      createdAt,
    },
    event: {
      organizationId,
      type: "approval.decided",
      payload: {
        approvalId: approval.id,
        kind: approval.kind,
        by: "owner",
        decision: input.decision,
        note,
        stage,
        createdAgentIds: workers.map((w) => w.id),
        wokenAgentId: approval.requestedByAgentId,
      },
    },
  };
}

/** 라이브러리 내용을 에이전트 하나의 사본으로. 사본마다 새 ID를 받으므로 같은 Role의 에이전트끼리도 공유하지 않는다. */
export function copyInstructions(
  agent: Pick<Agent, "id" | "organizationId">,
  files: InstructionSourceFile[],
  { newId, createdAt }: { newId: () => string; createdAt: string }
): InstructionCopy[] {
  return files.map((file) => ({
    ...file,
    id: newId(),
    organizationId: agent.organizationId,
    agentId: agent.id,
    kind: instructionKindOf(file.path),
    createdAt,
  }));
}
