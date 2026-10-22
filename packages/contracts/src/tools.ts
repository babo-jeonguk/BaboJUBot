import { z } from "zod";
import { addWorkerResultSchema, approvalSchema } from "./approval.ts";
import { harnessLibrarySchema } from "./harness.ts";
import { memoryEntryListSchema, memoryEntrySchema } from "./memory.ts";
import { conversationMessageSchema } from "./message.ts";
import { organizationSchema } from "./organization.ts";
import { resultSubmissionSchema } from "./result.ts";
import {
  agentToAgentMessageSchema,
  artifactSchema,
  taskCommentSchema,
  taskDetailSchema,
  taskListSchema,
  taskSchema,
} from "./task.ts";
import {
  researchLinkSchema,
  researchMapSchema,
  researchNodeDetailSchema,
  researchNodeSchema,
} from "./research-map.ts";
import {
  runContextSchema,
  runIdentitySchema,
  wakeReasonSchema,
} from "./run.ts";

// Agent → Control Plane 조직 도구 계약. 모든 도구는 `Authorization: Bearer <실행 시도별 토큰>`으로 호출하고,
// 조직·에이전트·실행 시도는 토큰에서만 정한다. 도구 입력에는 조직을 고르는 값이 없다.
// 어떤 Role이 어느 생애주기 단계에서 어떤 도구를 쓸 수 있는지는 core의 `checkToolCall`이 정한다.
// 승인 결정·최종 완료·승인 정책 변경은 사용자 제어 명령이며 조직 도구가 없다. Lead는 결과 제출까지만 한다.

export const orgToolsBasePath = "/api/tools";

export const orgToolNames = [
  "get_run_context",
  "send_message",
  "get_message",
  "get_harness_library",
  "record_goal",
  "request_initial_approval",
  "create_task",
  "list_tasks",
  "get_task",
  "start_task",
  "complete_task",
  "comment_task",
  "record_artifact",
  "get_artifact",
  "message_agent",
  "add_worker",
  "get_research_map",
  "get_research_node",
  "create_research_node",
  "update_research_node",
  "assign_research_node_parent",
  "change_research_node_parent",
  "add_research_link",
  "discard_research_node",
  "restore_research_node",
  "link_task_research_node",
  "relink_task_research_node",
  "unlink_task_research_node",
  "submit_result",
  "write_memory",
  "recall_memory",
] as const;
export const orgToolNameSchema = z.enum(orgToolNames);
export type OrgToolName = (typeof orgToolNames)[number];

/** 내 실행 맥락 조회 응답: 실행 시도 요청과 같은 신원·깨우기 사유 묶음·맥락 묶음. */
export const runContextResponseSchema = z.object({
  identity: runIdentitySchema,
  wakeReasons: z.array(wakeReasonSchema),
  context: runContextSchema,
});
export type RunContextResponse = z.infer<typeof runContextResponseSchema>;

/** 도구 경로. 경로 변수는 그 조직 안의 기록 ID뿐이다. */
export const orgToolPaths = {
  get_run_context: "/run-context",
  send_message: "/messages",
  get_message: "/messages/:messageId",
  get_harness_library: "/harness-library",
  record_goal: "/goal",
  request_initial_approval: "/initial-approval",
  create_task: "/tasks",
  list_tasks: "/tasks",
  get_task: "/tasks/:taskId",
  start_task: "/tasks/:taskId/start",
  complete_task: "/tasks/:taskId/complete",
  comment_task: "/tasks/:taskId/comments",
  record_artifact: "/artifacts",
  get_artifact: "/artifacts/:artifactId",
  message_agent: "/agent-messages",
  add_worker: "/workers",
  get_research_map: "/research-map",
  get_research_node: "/research-nodes/:nodeId",
  create_research_node: "/research-nodes",
  update_research_node: "/research-nodes/:nodeId",
  assign_research_node_parent: "/research-nodes/:nodeId/parent",
  change_research_node_parent: "/research-nodes/:nodeId/parent/change",
  add_research_link: "/research-links",
  discard_research_node: "/research-nodes/:nodeId/discard",
  restore_research_node: "/research-nodes/:nodeId/restore",
  link_task_research_node: "/tasks/:taskId/research-node",
  relink_task_research_node: "/tasks/:taskId/research-node/relink",
  unlink_task_research_node: "/tasks/:taskId/research-node/unlink",
  submit_result: "/results",
  write_memory: "/memories",
  recall_memory: "/memories",
} as const satisfies Record<OrgToolName, string>;

/** 읽기 도구는 GET, 기록을 남기는 도구는 POST, 기존 기록의 일부 필드를 고치는 도구는 PATCH. */
export const orgToolMethods = {
  get_run_context: "GET",
  send_message: "POST",
  get_message: "GET",
  get_harness_library: "GET",
  record_goal: "POST",
  request_initial_approval: "POST",
  create_task: "POST",
  list_tasks: "GET",
  get_task: "GET",
  start_task: "POST",
  complete_task: "POST",
  comment_task: "POST",
  record_artifact: "POST",
  get_artifact: "GET",
  message_agent: "POST",
  add_worker: "POST",
  get_research_map: "GET",
  get_research_node: "GET",
  create_research_node: "POST",
  update_research_node: "PATCH",
  assign_research_node_parent: "POST",
  change_research_node_parent: "POST",
  add_research_link: "POST",
  discard_research_node: "POST",
  restore_research_node: "POST",
  link_task_research_node: "POST",
  relink_task_research_node: "POST",
  unlink_task_research_node: "POST",
  submit_result: "POST",
  write_memory: "POST",
  recall_memory: "GET",
} as const satisfies Record<OrgToolName, "GET" | "POST" | "PATCH">;

export const orgToolOutputSchemas = {
  get_run_context: runContextResponseSchema,
  send_message: conversationMessageSchema,
  get_message: conversationMessageSchema,
  get_harness_library: harnessLibrarySchema,
  record_goal: organizationSchema,
  request_initial_approval: approvalSchema,
  create_task: taskSchema,
  list_tasks: taskListSchema,
  get_task: taskDetailSchema,
  start_task: taskSchema,
  complete_task: taskSchema,
  comment_task: taskCommentSchema,
  record_artifact: artifactSchema,
  get_artifact: artifactSchema,
  message_agent: agentToAgentMessageSchema,
  add_worker: addWorkerResultSchema,
  get_research_map: researchMapSchema,
  get_research_node: researchNodeDetailSchema,
  create_research_node: researchNodeSchema,
  update_research_node: researchNodeSchema,
  assign_research_node_parent: researchNodeSchema,
  change_research_node_parent: researchNodeSchema,
  add_research_link: researchLinkSchema,
  discard_research_node: researchNodeSchema,
  restore_research_node: researchNodeSchema,
  link_task_research_node: taskSchema,
  relink_task_research_node: taskSchema,
  unlink_task_research_node: taskSchema,
  submit_result: resultSubmissionSchema,
  write_memory: memoryEntrySchema,
  recall_memory: memoryEntryListSchema,
} as const satisfies Record<OrgToolName, z.ZodType>;

/**
 * 같은 호출을 다시 보내도 효과가 한 번만 남는 쓰기 도구. 호출에 `Idempotency-Key` header를 주면 그 에이전트의 같은 키는
 * 처음 저장한 결과를 그대로 돌려주고 기록·Event를 다시 남기지 않는다. 서버 재시작 뒤 같은 깨우기를 다시 받은 실행 시도가
 * 이미 남긴 답장·기억을 되풀이하지 않게 한다. 같은 키로 다른 도구나 다른 입력을 보내면 409 `idempotency_conflict`다.
 * 키는 효과 하나를 가리키도록 호출하는 쪽이 정하며, 실행 시도 ID처럼 다시 시도할 때 바뀌는 값으로 정하면 중복을 막지 못한다.
 */
export const idempotentOrgTools = [
  "send_message",
  "write_memory",
] as const satisfies readonly OrgToolName[];
export const idempotencyKeyHeader = "idempotency-key";
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);

/** Role 또는 생애주기 단계 규칙이 도구 호출을 거부한 이유. */
export const toolRefusalReasons = ["role", "stage"] as const;
export const toolRefusalReasonSchema = z.enum(toolRefusalReasons);
export type ToolRefusalReason = z.infer<typeof toolRefusalReasonSchema>;

/**
 * 도구 거부 응답. 토큰이 없거나 끝난 실행 시도의 것이면 401 `invalid_token`,
 * 다른 조직의 기록과 없는 기록은 똑같이 404 `not_found`, 입력이 계약 밖이면 422 `invalid_input`.
 * Role이 쓸 수 없는 도구는 403 `forbidden`, 지금 생애주기 단계에서 닫힌 도구는 409 `stage_closed`이며
 * 두 거부는 Event log에 남는다. 아직 구현하지 않은 도구는 501 `not_implemented`.
 * 작업자 추가는 곧바로 생긴 작업자면 201, 승인 정책 때문에 승인 요청이 되었으면 202다.
 * 작업 규칙의 거부: 담당자가 아닌 착수나 담당자·Lead가 아닌 완료는 403 `not_assignee`,
 * 완료된 작업의 다시 완료는 409 `already_completed`, 지금 상태에서 할 수 없는 착수는 409 `invalid_transition`.
 * 연구 지도 규칙의 거부: 조직 사본 템플릿에 없는 노드·연결 종류는 422 `unknown_kind`, 자기 자신과의 보조 연결은
 * 422 `invalid_input`, 주 연결 순환(자기 자신이나 후손을 주 부모로)은 409 `primary_cycle`, 이미 다른 주 부모가 있는 노드의
 * 주 부모 지정은 409 `primary_parent_exists`, 이미 다른 노드에 연결된 작업의 연결은 409 `task_already_linked`,
 * 폐기된 노드의 편집(폐기 취소 제외)·폐기된 노드로의 새 연결은 409 `node_discarded`.
 * 같은 `Idempotency-Key`로 다른 도구·입력을 보내면 409 `idempotency_conflict`({@link idempotentOrgTools}).
 */
export const orgToolErrorCodes = [
  "invalid_token",
  "not_found",
  "invalid_input",
  "forbidden",
  "stage_closed",
  "not_implemented",
  "not_assignee",
  "already_completed",
  "invalid_transition",
  "unknown_kind",
  "primary_cycle",
  "primary_parent_exists",
  "task_already_linked",
  "node_discarded",
  "idempotency_conflict",
] as const;
export type OrgToolErrorCode = (typeof orgToolErrorCodes)[number];
export const orgToolErrorSchema = z.object({
  error: z.object({ code: z.enum(orgToolErrorCodes) }),
});
