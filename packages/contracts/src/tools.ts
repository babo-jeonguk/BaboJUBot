import { z } from "zod";
import { conversationMessageSchema } from "./message.ts";
import {
  runContextSchema,
  runIdentitySchema,
  wakeReasonSchema,
} from "./run.ts";

// Agent → Control Plane 조직 도구 계약. 모든 도구는 `Authorization: Bearer <실행 시도별 토큰>`으로 호출하고,
// 조직·에이전트·실행 시도는 토큰에서만 정한다. 도구 입력에는 조직을 고르는 값이 없다.

export const orgToolsBasePath = "/api/tools";

export const orgToolNames = [
  "get_run_context",
  "send_message",
  "get_message",
] as const;
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
} as const satisfies Record<OrgToolName, string>;

export const orgToolOutputSchemas = {
  get_run_context: runContextResponseSchema,
  send_message: conversationMessageSchema,
  get_message: conversationMessageSchema,
} as const satisfies Record<OrgToolName, z.ZodType>;

/**
 * 도구 거부 응답. 토큰이 없거나 끝난 실행 시도의 것이면 401 `invalid_token`,
 * 다른 조직의 기록과 없는 기록은 똑같이 404 `not_found`, 입력이 계약 밖이면 422 `invalid_input`.
 */
export const orgToolErrorCodes = [
  "invalid_token",
  "not_found",
  "invalid_input",
  "forbidden",
] as const;
export type OrgToolErrorCode = (typeof orgToolErrorCodes)[number];
export const orgToolErrorSchema = z.object({
  error: z.object({ code: z.enum(orgToolErrorCodes) }),
});
