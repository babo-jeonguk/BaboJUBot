import { z } from "zod";

export const messageBodyMaxLength = 10_000;

export const messageAuthors = ["owner", "agent"] as const;
export const messageAuthorSchema = z.enum(messageAuthors);
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

/**
 * 사용자 메시지 전달 방식. `next_run`은 `줄 세우기`(기본, 실행 중이 아니면 그냥 보내기)이고, `interrupt`는 `중단하고 보내기`다.
 * `중단하고 보내기`는 받는 에이전트의 진행 중 실행 시도를 취소하는 제어 명령을 함께 남기고, 메시지는 다음 실행 시도가 받는다.
 * steer는 실행기 지원과 함께 더한다(판 2).
 */
export const messageDeliveries = ["next_run", "interrupt"] as const;
export const messageDeliverySchema = z.enum(messageDeliveries);
export type MessageDelivery = z.infer<typeof messageDeliverySchema>;

const messageBodySchema = z.string().trim().min(1).max(messageBodyMaxLength);

/**
 * Lead 대화에 사용자 메시지를 보내는 입력. 조직과 대화는 경로가, 받는 에이전트는 서버가 정한다.
 * 새 대화는 이 입력으로 첫 메시지를 보낼 때 생긴다(빈 대화는 남지 않는다).
 */
export const sendOwnerMessageInputSchema = z.strictObject({
  body: messageBodySchema,
  delivery: messageDeliverySchema.default("next_run"),
});
export type SendOwnerMessageInput = z.input<typeof sendOwnerMessageInputSchema>;

/** 대화 제목의 최대 글자 수. 새 대화의 제목은 첫 사용자 메시지를 이 길이로 줄인 것이다. */
export const conversationTitleMaxLength = 30;
/** 조직과 함께 생기는 기본 대화의 제목. */
export const defaultConversationTitle = "기본 대화";

/**
 * 사용자와 조직 Research Lead 사이의 대화 하나. 조직마다 기본 대화(`isDefault`) 하나가 조직과 함께 생기고,
 * 사용자는 언제든 새 대화를 시작할 수 있다. Lead가 사용자 메시지 없이 스스로 보내는 메시지는 기본 대화로 간다.
 */
export const conversationSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  title: z.string(),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Conversation = z.infer<typeof conversationSchema>;

/**
 * 대화 목록의 한 줄. `lastActivityAt`은 마지막 메시지 시각(메시지가 없으면 대화가 생긴 시각),
 * `unread`는 사용자가 마지막으로 본 뒤 Lead가 보낸 메시지가 있는지다.
 */
export const conversationSummarySchema = conversationSchema.extend({
  lastActivityAt: z.iso.datetime({ offset: true }),
  unread: z.boolean(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export const conversationSummaryListSchema = z.array(conversationSummarySchema);

/** 사용자가 대화를 이 메시지까지 보았다. 같은 대화의 메시지만 받으며, 본 위치는 앞으로만 간다. */
export const markConversationReadInputSchema = z.strictObject({
  upToMessageId: z.uuid(),
});
export type MarkConversationReadInput = z.infer<
  typeof markConversationReadInputSchema
>;

/**
 * Lead 대화의 메시지 하나. `agentId`는 대화 상대 에이전트(Lead), `conversationId`는 메시지가 속한 대화다.
 * 사용자 메시지는 받은 실행 시도(`deliveredToRunId`, 아직 없으면 다음 실행 시도 대기)를,
 * 에이전트 메시지는 보낸 실행 시도(`sentByRunId`)를 가리킨다.
 */
export const conversationMessageSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  agentId: z.uuid(),
  conversationId: z.uuid(),
  author: messageAuthorSchema,
  body: z.string(),
  delivery: messageDeliverySchema.nullable(),
  sentByRunId: z.uuid().nullable(),
  deliveredToRunId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationMessageListSchema = z.array(conversationMessageSchema);

/** 새 대화를 시작한 결과: 생긴 대화와 그 첫 사용자 메시지. */
export const startConversationResultSchema = z.object({
  conversation: conversationSchema,
  message: conversationMessageSchema,
});
export type StartConversationResult = z.infer<
  typeof startConversationResultSchema
>;

/**
 * 에이전트가 조직 도구로 보내는 답장. 조직은 실행 시도별 토큰이 정한다.
 * `conversationId`는 답장할 같은 조직의 대화다. 생략하면 이 실행 시도가 받은 사용자 메시지의 대화로 가고,
 * 사용자 메시지 없이 깨어났으면 기본 대화로 간다. 여러 대화의 사용자 메시지를 받았으면 생략할 수 없다.
 */
export const sendAgentMessageInputSchema = z.strictObject({
  body: messageBodySchema,
  conversationId: z.uuid().optional(),
});
export type SendAgentMessageInput = z.infer<typeof sendAgentMessageInputSchema>;
