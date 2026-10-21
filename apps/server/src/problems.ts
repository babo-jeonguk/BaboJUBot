import type { OrgToolErrorCode } from "@babojubot/contracts";
import type {
  MapRuleProblem,
  ProposalProblem,
  TaskRuleProblem,
} from "@babojubot/core";

/** 도구 규칙의 거부 → 응답 코드·HTTP 상태. 사용자 지도 편집도 같은 표를 쓴다. */
export type ToolProblem =
  ProposalProblem | TaskRuleProblem | MapRuleProblem | "self_message";
export const problemResponses: Record<ToolProblem, [OrgToolErrorCode, number]> =
  {
    goal_missing: ["invalid_input", 422],
    unknown_role: ["invalid_input", 422],
    unknown_template: ["invalid_input", 422],
    self_message: ["invalid_input", 422],
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
  };
