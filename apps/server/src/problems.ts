import type { OrgToolErrorCode } from "@babojubot/contracts";
import type {
  MapRuleProblem,
  ProposalProblem,
  QueuedMessageRefusal,
  TaskRuleProblem,
} from "@babojubot/core";
import type {
  ControlRefusal,
  DecisionRefusal,
  OwnerMapEditRefusal,
  ResultDecisionRefusal,
} from "@babojubot/db";

/** 도구 규칙의 거부 → 응답 코드·HTTP 상태. 사용자 지도 편집의 지도 규칙 거부도 이 표를 쓴다. */
export type ToolProblem =
  | ProposalProblem
  | TaskRuleProblem
  | MapRuleProblem
  | "self_message"
  | "conversation_required"
  | "idempotency_conflict";
export const problemResponses: Record<ToolProblem, [OrgToolErrorCode, number]> =
  {
    goal_missing: ["invalid_input", 422],
    completion_criteria_required: ["completion_criteria_required", 422],
    completion_criteria_set: ["completion_criteria_set", 409],
    unknown_role: ["invalid_input", 422],
    unknown_template: ["invalid_input", 422],
    self_message: ["invalid_input", 422],
    conversation_required: ["invalid_input", 422],
    not_found: ["not_found", 404],
    not_assignee: ["not_assignee", 403],
    already_completed: ["already_completed", 409],
    invalid_transition: ["invalid_transition", 409],
    unknown_kind: ["unknown_kind", 422],
    self_link: ["invalid_input", 422],
    primary_cycle: ["primary_cycle", 409],
    primary_parent_exists: ["primary_parent_exists", 409],
    node_discarded: ["node_discarded", 409],
    task_already_linked: ["task_already_linked", 409],
    idempotency_conflict: ["idempotency_conflict", 409],
  };

/**
 * 사용자가 대시보드(사용자 HTTP)나 가짜 채널에서 한 일의 거부 → 응답 코드·HTTP 상태. 응답 본문은 `{ error: { code } }`다.
 * 지도 규칙의 거부는 조직 도구 표를 그대로 쓴다.
 */
export type OwnerRefusal =
  | DecisionRefusal
  | ResultDecisionRefusal
  | ControlRefusal
  | OwnerMapEditRefusal
  | QueuedMessageRefusal
  | "queue_full"
  | "name_taken"
  | "revision_conflict"
  | "invalid_skill"
  | "archive_not_allowed"
  | "reply_not_allowed";
export const ownerRefusalResponses: Record<OwnerRefusal, [string, number]> = {
  not_found: ["not_found", 404],
  organization_closed: ["organization_closed", 409],
  already_decided: ["already_decided", 409],
  decision_not_allowed: ["decision_not_allowed", 422],
  stage_closed: ["stage_closed", 409],
  queue_full: ["queue_full", 409],
  message_delivered: ["message_delivered", 409],
  name_taken: ["name_taken", 409],
  revision_conflict: ["revision_conflict", 409],
  invalid_skill: ["invalid_skill", 422],
  archive_not_allowed: ["archive_not_allowed", 422],
  reply_not_allowed: ["reply_not_allowed", 422],
  unknown_kind: problemResponses.unknown_kind,
  self_link: problemResponses.self_link,
  primary_cycle: problemResponses.primary_cycle,
  primary_parent_exists: problemResponses.primary_parent_exists,
  node_discarded: problemResponses.node_discarded,
  task_already_linked: problemResponses.task_already_linked,
};
