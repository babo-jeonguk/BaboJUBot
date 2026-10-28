import type { Conversation, ConversationSummary } from "@babojubot/contracts";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { isUuid, type Executor } from "./rows.ts";
import { conversations, messages, runWakes, wakes } from "./schema.ts";

// 사용자와 Research Lead의 대화. 메시지 저장·조회는 runs.ts가, 대화 자체의 조회와 사용자가 본 위치는 여기서 맡는다.

export const conversationRow = (c: Conversation) => ({
  id: c.id,
  organizationId: c.organizationId,
  title: c.title,
  isDefault: c.isDefault,
  createdAt: new Date(c.createdAt),
});

const toConversation = ({
  id,
  organizationId,
  title,
  isDefault,
  createdAt,
}: typeof conversations.$inferSelect): Conversation => ({
  id,
  organizationId,
  title,
  isDefault,
  createdAt: createdAt.toISOString(),
});

/** 조직 안의 대화 하나. 다른 조직의 대화와 없는 대화를 구별하지 않는다. */
export async function findConversation(
  db: Executor,
  organizationId: string,
  conversationId: string
): Promise<Conversation | undefined> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return undefined;
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.id, conversationId)
      )
    );
  return row && toConversation(row);
}

/** 조직의 기본 대화. 조직과 함께 생기므로 조직이 있으면 있다. */
export async function findDefaultConversation(
  db: Executor,
  organizationId: string
): Promise<Conversation | undefined> {
  if (!isUuid(organizationId)) return undefined;
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.isDefault, true)
      )
    );
  return row && toConversation(row);
}

/** 실행 시도가 받은 사용자 메시지들의 대화. 받은 순서대로이며 겹치지 않는다. */
export async function receivedConversationIds(
  db: Executor,
  runId: string
): Promise<string[]> {
  const rows = await db
    .select({ conversationId: messages.conversationId })
    .from(runWakes)
    .innerJoin(wakes, eq(wakes.id, runWakes.wakeId))
    .innerJoin(messages, eq(messages.id, wakes.messageId))
    .where(eq(runWakes.runId, runId))
    .orderBy(wakes.seq);
  return [...new Set(rows.map((r) => r.conversationId))];
}

/** 실행 시도 맥락에 담을 대화: 기본 대화와 그 실행 시도가 받은 사용자 메시지의 대화. 생긴 순서대로. */
export async function contextConversations(
  db: Executor,
  organizationId: string,
  runId: string
): Promise<Conversation[]> {
  const received = await receivedConversationIds(db, runId);
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        received.length
          ? or(
              eq(conversations.isDefault, true),
              inArray(conversations.id, received)
            )
          : eq(conversations.isDefault, true)
      )
    )
    .orderBy(conversations.seq);
  return rows.map(toConversation);
}

/**
 * 조직의 대화 목록. 기본 대화가 맨 위이고 나머지는 마지막 활동(거두지 않은 마지막 메시지, 없으면 생긴 시각)이 최근인 것부터다.
 * 사용자가 본 위치 뒤에 Lead가 보낸 메시지가 있으면 `unread`다.
 */
export async function listConversations(
  db: Database,
  organizationId: string
): Promise<ConversationSummary[]> {
  if (!isUuid(organizationId)) return [];
  const lastActivityAt = sql<Date>`coalesce(max(${messages.createdAt}), ${conversations.createdAt})`;
  const rows = await db
    .select({
      conversation: conversations,
      lastActivityAt: sql<string>`${lastActivityAt}`,
      unread: sql<boolean>`coalesce(bool_or(${messages.author} = 'agent' and ${messages.seq} > coalesce(${conversations.readMessageSeq}, 0)), false)`,
    })
    .from(conversations)
    .leftJoin(
      messages,
      and(
        eq(messages.conversationId, conversations.id),
        isNull(messages.withdrawnAt)
      )
    )
    .where(eq(conversations.organizationId, organizationId))
    .groupBy(conversations.id)
    .orderBy(
      desc(conversations.isDefault),
      desc(lastActivityAt),
      desc(conversations.seq)
    );
  return rows.map((r) => ({
    ...toConversation(r.conversation),
    lastActivityAt: new Date(r.lastActivityAt).toISOString(),
    unread: r.unread,
  }));
}

/**
 * 사용자가 대화를 메시지 하나까지 보았다. 본 위치는 앞으로만 가며, 그 메시지가 같은 조직의 그 대화에 없으면 `not_found`다.
 * 사용자의 보기만 바꾸고 연구 기록·Event·깨우기는 남기지 않는다.
 */
export async function markConversationRead(
  db: Database,
  organizationId: string,
  conversationId: string,
  upToMessageId: string
): Promise<"ok" | "not_found"> {
  if (![organizationId, conversationId, upToMessageId].every(isUuid))
    return "not_found";
  const [message] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.conversationId, conversationId),
        eq(messages.id, upToMessageId)
      )
    );
  if (!message) return "not_found";
  await db
    .update(conversations)
    .set({
      readMessageSeq: sql`greatest(coalesce(${conversations.readMessageSeq}, 0), ${message.seq})`,
    })
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.id, conversationId)
      )
    );
  return "ok";
}
