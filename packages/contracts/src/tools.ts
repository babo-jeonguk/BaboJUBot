import { z } from "zod";
import { approvalSchema } from "./approval.ts";
import { harnessLibrarySchema } from "./harness.ts";
import { conversationMessageSchema } from "./message.ts";
import { organizationSchema } from "./organization.ts";
import {
  agentToAgentMessageSchema,
  artifactSchema,
  taskCommentSchema,
  taskDetailSchema,
  taskListSchema,
  taskSchema,
} from "./task.ts";
import {
  runContextSchema,
  runIdentitySchema,
  wakeReasonSchema,
} from "./run.ts";

// Agent → Control Plane 조직 도구 계약. 모든 도구는 `Authorization: Bearer <실행 시도별 토큰>`으로 호출하고,
// 조직·에이전트·실행 시도는 토큰에서만 정한다. 도구 입력에는 조직을 고르는 값이 없다.
// 어떤 Role이 어느 생애주기 단계에서 어떤 도구를 쓸 수 있는지는 core의 `checkToolCall`이 정한다.

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
} as const satisfies Record<OrgToolName, string>;

/** 읽기 도구는 GET, 기록을 남기는 도구는 POST. */
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
} as const satisfies Record<OrgToolName, "GET" | "POST">;

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
  // 작업자 추가(#58)는 아직 없다. 지금은 단계 규칙의 거부만 확인할 수 있다.
  add_worker: z.unknown(),
} as const satisfies Record<OrgToolName, z.ZodType>;

/** Role 또는 생애주기 단계 규칙이 도구 호출을 거부한 이유. */
export const toolRefusalReasons = ["role", "stage"] as const;
export const toolRefusalReasonSchema = z.enum(toolRefusalReasons);
export type ToolRefusalReason = z.infer<typeof toolRefusalReasonSchema>;

/**
 * 도구 거부 응답. 토큰이 없거나 끝난 실행 시도의 것이면 401 `invalid_token`,
 * 다른 조직의 기록과 없는 기록은 똑같이 404 `not_found`, 입력이 계약 밖이면 422 `invalid_input`.
 * Role이 쓸 수 없는 도구는 403 `forbidden`, 지금 생애주기 단계에서 닫힌 도구는 409 `stage_closed`이며
 * 두 거부는 Event log에 남는다. 아직 구현하지 않은 도구는 501 `not_implemented`.
 * 작업 규칙의 거부: 담당자가 아닌 착수나 담당자·Lead가 아닌 완료는 403 `not_assignee`,
 * 완료된 작업의 다시 완료는 409 `already_completed`, 지금 상태에서 할 수 없는 착수는 409 `invalid_transition`.
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
] as const;
export type OrgToolErrorCode = (typeof orgToolErrorCodes)[number];
export const orgToolErrorSchema = z.object({
  error: z.object({ code: z.enum(orgToolErrorCodes) }),
});
