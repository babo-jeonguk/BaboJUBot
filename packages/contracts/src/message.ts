import { z } from "zod";

export const messageBodyMaxLength = 10_000;

export const messageAuthors = ["owner", "agent"] as const;
export const messageAuthorSchema = z.enum(messageAuthors);
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

/**
 * 사용자 메시지 전달 방식. `next_run`은 `줄 세우기`(기본, 실행 중이 아니면 그냥 보내기)이고, `interrupt`는 `중단하고 보내기`다.
 * `중단하고 보내기`는 받는 에이전트의 진행 중 실행 시도를 취소하는 제어 명령을 함께 남기고, 메시지는 다음 실행 시도가 받는다.
 * 그 실행 시도는 `중단하고 보내기` 메시지만 받으며, 먼저 줄 세운 메시지와 다른 깨우기는 그다음 실행 시도가 받는다(core `bundleWakes`).
 * 아직 실행 시도가 받지 않은 메시지는 사용자가 그 자리에서 고치거나(`고치기`) 거두거나(`취소`) `지금 보내기`로 `중단하고 보내기`로 바꿀 수 있다.
 * steer는 프로바이더 지원과 함께 더한다(판 2).
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

/**
 * Lead 하나에 줄 세울 수 있는 사용자 메시지(아직 실행 시도가 받지 않았고 거두지 않은 메시지)의 상한. 모든 대화를 합해 센다.
 * 상한이면 줄 세우기·중단하고 보내기 모두 받지 않는다(409 `queue_full`). 거두면 자리가 난다.
 */
export const maxQueuedMessages = 20;

/** 줄 세운 메시지를 그 자리에서 고치는 입력. 전달 방식과 줄 속 위치는 그대로다. */
export const editQueuedMessageInputSchema = z.strictObject({
  body: messageBodySchema,
});
export type EditQueuedMessageInput = z.infer<
  typeof editQueuedMessageInputSchema
>;

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
 * 사용자 메시지는 받은 실행 시도(`deliveredToRunId`, 아직 없으면 줄 세운 메시지)와 받은 시각(`deliveredAt`, 그 실행 시도가
 * 시작한 시각)을, 에이전트 메시지는 보낸 실행 시도(`sentByRunId`)를 가리킨다. `createdAt`은 저장한(보낸) 시각이다.
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
  deliveredAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/** 대화의 메시지 목록(줄 세운 메시지 등). 사용자가 거둔 메시지는 빠진다. */
export const conversationMessageListSchema = z.array(conversationMessageSchema);

/** 대화 한 쪽의 메시지 수. 첫 쪽과 더 오래된 쪽이 같다. */
export const conversationPageSize = 50;

/**
 * 대화 한 쪽을 고르는 조회 조건. 커서가 없으면 가장 최근 쪽, `before`는 그보다 오래된 쪽, `after`는 그보다 새 쪽이다.
 * 커서는 서버가 준 값을 그대로 쓴다(뜻을 해석하지 않는다).
 */
export const conversationPageQuerySchema = z
  .strictObject({
    before: z.string().min(1).max(200).optional(),
    after: z.string().min(1).max(200).optional(),
  })
  .refine((q) => !(q.before && q.after), {
    message: "before와 after는 함께 쓰지 않는다",
  });
export type ConversationPageQuery = z.infer<typeof conversationPageQuerySchema>;

/**
 * 대화 한 쪽: Lead 메시지와 실행 시도가 받은 사용자 메시지를 Lead가 받은 순서로, 오래된 것부터 담는다. 줄 세운 메시지는 없다.
 * `hasMore`는 고른 방향(커서 없음·`before`는 더 오래된 쪽, `after`는 더 새 쪽)에 메시지가 더 있는가다.
 * `before`는 이 쪽보다 오래된 쪽을 받을 커서(더 오래된 메시지가 없거나 쪽이 비었으면 null, `after` 조회의 쪽에도 있다),
 * `after`는 이보다 새 메시지를 이어 받을 커서(이 쪽의 가장 새 메시지, 비었으면 받은 커서 그대로이고 처음부터 비었으면 null)다.
 */
export const conversationPageSchema = z.object({
  messages: z.array(conversationMessageSchema),
  hasMore: z.boolean(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type ConversationPage = z.infer<typeof conversationPageSchema>;

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
