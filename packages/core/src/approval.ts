import {
  approvalKindDecisions,
  orgToolNames,
  orgTools,
  type AddWorkerProposal,
  type AgentRole,
  type ApprovalDecision,
  type ApprovalStatus,
  type FlowTemplateCopy,
  type InitialResearchProposal,
  type InstructionCopy,
  type LifecycleStage,
  type NewEvent,
  type OrgToolName,
  type RecordGoalInput,
  type RequestInitialApprovalInput,
  type ToolRefusalReason,
} from "@babojubot/contracts";
import type { HarnessLibraryContents } from "./harness.ts";
import type { NewAgent, RecordSource } from "./organization.ts";
import type { Wake } from "./run.ts";
import { planWorker } from "./worker.ts";

// (조직 생성 때 사용자가 적은 목표 →) 초기 연구 승인 요청 → 사용자 결정. 초기 연구 승인은 끌 수 없는 제품 규칙이다(ADR-0003).
// 목표 기록 도구는 목표 없이 만든 예전 조직(`목표 설정`)에만 남아 있다.
// 역할 문서가 아니라 도구 목록의 Role·단계 데이터로 하는 판정(`checkToolCall`)과 저장 쪽의 조건부 갱신이 승인 전 실행을 막는다.

export type ToolCheck = { ok: true } | { ok: false; reason: ToolRefusalReason };

/**
 * 이 Role의 에이전트가 이 단계의 조직에서 이 도구를 쓸 수 있는가. 도구 목록(contracts `orgTools`) 한 줄의 Role·단계 데이터로
 * 판정하는 유일한 곳이다. Role 거부가 단계 거부보다 먼저다.
 */
export function checkToolCall(
  tool: OrgToolName,
  { role, stage }: { role: AgentRole; stage: LifecycleStage }
): ToolCheck {
  const { roles, stages } = orgTools[tool];
  if (!roles.includes(role)) return { ok: false, reason: "role" };
  if (stages !== "any" && !stages.includes(stage))
    return { ok: false, reason: "stage" };
  return { ok: true };
}

/**
 * 이 Role·단계에서 지금 쓸 수 있는 도구. `checkToolCall`로 거르므로 호출 판정과 어긋나지 않는다.
 * 목록에 있다고 권한이 생기지 않으며, 서버는 호출마다 다시 판정한다(단계는 목록을 받은 뒤에도 바뀐다).
 */
export const availableOrgTools = (actor: {
  role: AgentRole;
  stage: LifecycleStage;
}): OrgToolName[] =>
  orgToolNames.filter((tool) => checkToolCall(tool, actor).ok);

export type RunRef = { id: string; organizationId: string; agentId: string };

/** 거부한 도구 호출의 Event. 호출한 실행 시도에 귀속한다. */
export const toolRefusedEvent = (
  run: RunRef,
  tool: OrgToolName,
  stage: LifecycleStage,
  reason: ToolRefusalReason
): NewEvent => ({
  organizationId: run.organizationId,
  type: "tool.refused",
  payload: { runId: run.id, agentId: run.agentId, tool, stage, reason },
});

/** 목표 설정에서 기록하면 계획 수립으로 넘어간다. */
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
  | "goal_missing"
  | "completion_criteria_required"
  | "completion_criteria_set"
  | "unknown_role"
  | "unknown_template";

/**
 * 제출 내용과 지금의 하네스 라이브러리로 승인 대상 snapshot을 만든다. 팀 구성의 Role은 라이브러리의 작업자 Role이어야 한다.
 * 이 snapshot이 사용자가 검토하고 승인하는 내용 그대로이며, 승인 때 라이브러리를 다시 읽지 않는다.
 *
 * 완료 기준: 조직에 없으면(사용자가 비워 둠) Lead가 이 요청에서 제안해야 하며 snapshot에 Lead 제안으로 표시한다.
 * 조직에 있으면 Lead는 이 요청으로 바꿀 수 없으므로 완료 기준을 함께 내면 거부한다.
 */
export function buildInitialResearchProposal(
  organization: { goal: string | null; completionCriteria: string | null },
  input: RequestInitialApprovalInput,
  library: HarnessLibraryContents
): InitialResearchProposal | ProposalProblem {
  if (!organization.goal) return "goal_missing";
  if (organization.completionCriteria && input.completionCriteria)
    return "completion_criteria_set";
  if (!organization.completionCriteria && !input.completionCriteria)
    return "completion_criteria_required";
  const team: InitialResearchProposal["team"] = [];
  for (const member of input.team) {
    const role = library.roles.get(member.role);
    if (!role || role.agent !== "worker") return "unknown_role";
    team.push({
      role: member.role,
      label: role.label,
      count: member.count,
      files: role.files,
      heartbeatMinutes: role.heartbeatMinutes,
    });
  }
  const template = library.templates.get(input.template);
  if (!template) return "unknown_template";
  const proposed = !organization.completionCriteria;
  return {
    goal: organization.goal,
    completionCriteria:
      organization.completionCriteria ?? input.completionCriteria!,
    ...(proposed ? { completionCriteriaProposed: true } : {}),
    plan: input.plan,
    environment: input.environment,
    team,
    template,
  };
}

/** 승인 요청의 종류와 그 검토 내용. 종류마다 내용의 모양이 다르다. */
export type ApprovalSubject =
  | { kind: "initial_research"; proposal: InitialResearchProposal }
  | { kind: "add_worker"; proposal: AddWorkerProposal };

export type NewApproval = {
  id: string;
  organizationId: string;
  requestedByAgentId: string;
  requestedByRunId: string;
  previousApprovalId: string | null;
  createdAt: string;
} & ApprovalSubject;

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

/** 결정된 승인 요청의 상태 → 사용자가 내린 결정. 결정을 기다리는 요청에는 결정이 없다. */
export function decisionOfStatus(status: ApprovalStatus): ApprovalDecision {
  const found = (
    Object.entries(decisionStatus) as [ApprovalDecision, ApprovalStatus][]
  ).find(([, s]) => s === status);
  if (!found) throw new Error(`approval status ${status} has no decision`);
  return found[0];
}

export type ApprovalDecisionPlan = {
  status: Exclude<ApprovalStatus, "pending">;
  note: string | null;
  decidedAt: string;
  stage: LifecycleStage;
  /** 이 결정으로 조직의 완료 기준이 되는 Lead 제안. 제안을 승인할 때만 있다. */
  completionCriteria: string | null;
  workers: NewAgent[];
  copies: InstructionCopy[];
  template: FlowTemplateCopy | null;
  wake: Wake;
  event: NewEvent;
};

export type PendingApproval = {
  id: string;
  organizationId: string;
  requestedByAgentId: string;
} & ApprovalSubject;

/**
 * 결정을 기다리는 승인 요청에 대한 사용자 결정. 종류마다 내릴 수 있는 결정과 효과가 다르며, 그 종류에 없는 결정은
 * `decision_not_allowed`다. 어느 결정이든 요청한 Lead를 그 사유로 깨운다.
 * 한 번만 결정할 수 있다는 규칙은 저장 쪽의 조건부 갱신이 강제한다.
 *
 * - 초기 연구 승인: 승인하면 `연구 진행`으로 넘어가고, snapshot의 팀 구성대로 작업자를 만들어 각자에게 따로
 *   Role·Soul·Skill 사본을 주며 흐름 템플릿을 조직 사본으로 둔다. snapshot의 완료 기준이 Lead 제안이면 조직의 완료 기준이 된다.
 *   반려·수정 요청은 아무것도 만들지 않고(제안한 완료 기준도 정하지 않음) `계획 수립`으로 돌린다.
 * - 작업자 추가: 승인하면 snapshot으로 작업자 한 명과 그 사본을 만든다. 단계와 상관없이 승인할 수 있고(#58 사용자 결정),
 *   반려는 아무것도 만들지 않는다. 어느 결정도 조직 단계를 바꾸지 않는다.
 *
 * `agentNames`는 결정 때 조직의 모든 에이전트 이름이다. 새 작업자 이름은 이 이름들·함께 만드는 작업자 이름과 겹치지 않는다.
 */
export function planApprovalDecision(
  approval: PendingApproval,
  input: { decision: ApprovalDecision; note?: string },
  { stage, agentNames }: { stage: LifecycleStage; agentNames: string[] },
  { newId, now }: RecordSource
): ApprovalDecisionPlan | "decision_not_allowed" {
  const allowed: readonly ApprovalDecision[] =
    approvalKindDecisions[approval.kind];
  if (!allowed.includes(input.decision)) return "decision_not_allowed";
  const createdAt = now().toISOString();
  const { organizationId } = approval;
  const approved = input.decision === "approve";
  const workers: NewAgent[] = [];
  const copies: InstructionCopy[] = [];
  let template: FlowTemplateCopy | null = null;
  let completionCriteria: string | null = null;
  let nextStage = stage;
  if (approval.kind === "initial_research") {
    const { proposal } = approval;
    if (approved && proposal.completionCriteriaProposed)
      completionCriteria = proposal.completionCriteria;
    if (approved)
      for (const member of proposal.team)
        for (let i = 1; i <= member.count; i++) {
          // 함께 들어오는 작업자도 팀 순서대로 홈 자리를 받도록 1ms씩 늦춰 들어온 순서를 남긴다.
          const added = planWorker(
            organizationId,
            member,
            [...agentNames, ...workers.map((w) => w.name)],
            {
              newId,
              createdAt: new Date(
                Date.parse(createdAt) + workers.length
              ).toISOString(),
            }
          );
          workers.push(added.worker);
          copies.push(...added.copies);
        }
    template = approved
      ? {
          ...proposal.template,
          id: newId(),
          organizationId,
          approvalId: approval.id,
          createdAt,
        }
      : null;
    nextStage = approved ? "researching" : "planning";
  } else if (approved) {
    const added = planWorker(organizationId, approval.proposal, agentNames, {
      newId,
      createdAt,
    });
    workers.push(added.worker);
    copies.push(...added.copies);
  }
  const note = input.note || null;
  return {
    status: decisionStatus[input.decision],
    note,
    decidedAt: createdAt,
    stage: nextStage,
    completionCriteria,
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
        stage: nextStage,
        createdAgentIds: workers.map((w) => w.id),
        wokenAgentId: approval.requestedByAgentId,
        ...(completionCriteria ? { completionCriteria } : {}),
      },
    },
  };
}
