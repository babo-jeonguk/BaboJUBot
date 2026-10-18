import { z } from "zod";

export const messageBodyMaxLength = 10_000;

export const messageAuthors = ["owner", "agent"] as const;
export const messageAuthorSchema = z.enum(messageAuthors);
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

/**
 * 사용자 메시지 전달 방식. 첫 판은 `다음 실행 시도에 반영`(기본)만 있다.
 * steer와 `중단하고 반영`은 실행기 지원·중단 제어(#59)와 함께 더한다.
 */
export const messageDeliveries = ["next_run"] as const;
export const messageDeliverySchema = z.enum(messageDeliveries);
export type MessageDelivery = z.infer<typeof messageDeliverySchema>;

const messageBodySchema = z.string().trim().min(1).max(messageBodyMaxLength);

/** Lead 대화에 사용자 메시지를 보내는 입력. 조직은 경로가, 받는 에이전트는 서버가 정한다. */
export const sendOwnerMessageInputSchema = z.strictObject({
  body: messageBodySchema,
  delivery: messageDeliverySchema.default("next_run"),
});
export type SendOwnerMessageInput = z.input<typeof sendOwnerMessageInputSchema>;

/**
 * Lead 대화의 메시지 하나. `agentId`는 대화 상대 에이전트(Lead)다.
 * 사용자 메시지는 받은 실행 시도(`deliveredToRunId`, 아직 없으면 다음 실행 시도 대기)를,
 * 에이전트 메시지는 보낸 실행 시도(`sentByRunId`)를 가리킨다.
 */
export const conversationMessageSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  agentId: z.uuid(),
  author: messageAuthorSchema,
  body: z.string(),
  delivery: messageDeliverySchema.nullable(),
  sentByRunId: z.uuid().nullable(),
  deliveredToRunId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationMessageListSchema = z.array(conversationMessageSchema);

/** 에이전트가 조직 도구로 보내는 답장. 받는 대상과 조직은 실행 시도별 토큰이 정한다. */
export const sendAgentMessageInputSchema = z.strictObject({
  body: messageBodySchema,
});
export type SendAgentMessageInput = z.infer<typeof sendAgentMessageInputSchema>;
