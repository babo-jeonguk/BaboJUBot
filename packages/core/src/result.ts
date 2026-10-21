import type {
  DecideResultInput,
  LifecycleStage,
  NewEvent,
  ResultDecision,
  ResultSubmissionStatus,
  SubmitResultInput,
} from "@babojubot/contracts";
import type { RecordSource } from "./organization.ts";
import type { Wake } from "./run.ts";

// 결과 제출 → 사용자의 수정 요청 또는 최종 완료. Lead는 제출만 하고, 최종 완료는 사용자 결정으로만 일어난다(ADR-0003).
// 한 번만 결정한다는 규칙과 결정·단계·깨우기·Event를 함께 남기는 일은 저장 쪽이 강제한다.

type RunRef = { id: string; organizationId: string; agentId: string };

export type NewResultSubmission = {
  id: string;
  organizationId: string;
  submittedByAgentId: string;
  submittedByRunId: string;
  previousSubmissionId: string | null;
  summary: string;
  goal: string;
  completionCriteria: string;
  /** 근거 산출물. 같은 조직의 산출물인지는 저장 쪽이 확인한다. */
  artifactIds: string[];
  createdAt: string;
};

/**
 * Lead의 결과 제출은 조직을 결과 검토 중으로 넘긴다. 검토 기준은 지금 조직의 목표·완료 기준을 고정한 사본이다.
 * 수정 요청 뒤의 재제출은 새 제출이며 직전 제출을 가리킨다.
 */
export function planResultSubmission(
  run: RunRef,
  organization: { goal: string | null; completionCriteria: string | null },
  input: SubmitResultInput,
  previousSubmissionId: string | null,
  { newId, now }: RecordSource
): { submission: NewResultSubmission; stage: LifecycleStage; event: NewEvent } {
  const { goal, completionCriteria } = organization;
  // 목표 기록 없이는 연구 진행에 들어설 수 없다(초기 연구 승인 snapshot에 목표가 있어야 한다).
  if (!goal || !completionCriteria)
    throw new Error(`organization ${run.organizationId} has no recorded goal`);
  const stage: LifecycleStage = "result_review";
  const submission: NewResultSubmission = {
    id: newId(),
    organizationId: run.organizationId,
    submittedByAgentId: run.agentId,
    submittedByRunId: run.id,
    previousSubmissionId,
    summary: input.summary,
    goal,
    completionCriteria,
    artifactIds: input.artifactIds,
    createdAt: now().toISOString(),
  };
  return {
    submission,
    stage,
    event: {
      organizationId: run.organizationId,
      type: "result.submitted",
      payload: {
        submissionId: submission.id,
        runId: run.id,
        agentId: run.agentId,
        artifactIds: submission.artifactIds,
        stage,
      },
    },
  };
}

const resultDecisionStatus: Record<
  ResultDecision,
  Exclude<ResultSubmissionStatus, "pending">
> = {
  request_changes: "changes_requested",
  complete: "completed",
};

export type ResultDecisionPlan = {
  status: Exclude<ResultSubmissionStatus, "pending">;
  note: string | null;
  decidedAt: string;
  stage: LifecycleStage;
  /** 수정 요청이면 제출한 Lead를 의견과 함께 깨운다. 최종 완료는 아무도 깨우지 않는다. */
  wake: Wake | null;
  event: NewEvent;
};

/**
 * 결정을 기다리는 결과 제출에 대한 사용자 결정. 수정 요청은 `연구 진행`으로 돌리고 의견과 함께 제출한 Lead를 깨우며,
 * 최종 완료는 `최종 완료`로 넘긴다. 최종 완료 뒤에는 실행 시도 admission이 거부된다(`admitsRuns`).
 */
export function planResultDecision(
  submission: {
    id: string;
    organizationId: string;
    submittedByAgentId: string;
  },
  input: DecideResultInput,
  { newId, now }: RecordSource
): ResultDecisionPlan {
  const decidedAt = now().toISOString();
  const { organizationId } = submission;
  const note = input.note || null;
  const requestsChanges = input.decision === "request_changes";
  const stage: LifecycleStage = requestsChanges ? "researching" : "completed";
  const wake: Wake | null = requestsChanges
    ? {
        id: newId(),
        organizationId,
        agentId: submission.submittedByAgentId,
        kind: "result_changes_requested",
        resultSubmissionId: submission.id,
        createdAt: decidedAt,
      }
    : null;
  return {
    status: resultDecisionStatus[input.decision],
    note,
    decidedAt,
    stage,
    wake,
    event: {
      organizationId,
      type: "result.decided",
      payload: {
        submissionId: submission.id,
        by: "owner",
        decision: input.decision,
        note,
        stage,
        wokenAgentId: wake?.agentId ?? null,
      },
    },
  };
}
