import {
  conversationPageSize,
  newMessageRefusal,
  type AgentRole,
  type Conversation,
  type ConversationMessage,
  type ConversationPage,
  type ConversationSummary,
  type RunContextResponse,
} from "@babojubot/contracts";
import {
  chooseReplyConversation,
  planAgentMessage,
  planInterrupt,
  type InterruptPlan,
  type OwnerMessagePlan,
  type RecordSource,
} from "@babojubot/core";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./client.ts";
import {
  insertEvent,
  isUuid,
  lockAgent,
  lockOrganization,
  lockRunningRunOfAgent,
  requestCancellation,
  type Executor,
} from "./rows.ts";
import { conversations, messages, runs, runWakes, wakes } from "./schema.ts";
import { refused, stored, type Stored } from "./stored.ts";
import {
  toolWrite,
  type ActiveRunRef,
  type ToolCall,
  type ToolWrite,
} from "./tool-calls.ts";

// 사용자와 Research Lead의 대화와 그 안의 메시지. 대화 목록·본 위치, 메시지 저장(사용자·Lead), 받은 순서, 쪽 커서,
// 줄 세운 메시지 수·조회, Lead 실행 맥락의 대화를 맡는다. 받은 순서 열쇠·쪽 커서 형식·전달 sequence(`delivered_seq`)와
// 거둔 메시지 제외는 이 파일 밖에 드러내지 않는다. admission은 실행 시도가 받은 깨우기를 `markDelivered`로 한 번 알리고,
// 서버 재시작 재대기는 `markRequeued`로 되돌린다. 줄 세운 메시지 명령은 queued-messages.ts가 이 파일의 조회로 맡는다.

// ---------- 대화 ----------

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
async function receivedConversationIds(
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
async function contextConversations(
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
 * 사용자가 대화를 메시지 하나까지(받은 순서로) 보았다. 본 위치는 앞으로만 가며, 그 메시지가 같은 조직의 그 대화에 없으면 `not_found`다.
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
  // 받은 순서의 위치로 본다. 줄 세운 메시지는 위치가 없어 보낸 순서를 쓴다.
  const [message] = await db
    .select({
      position:
        sql<number>`coalesce(${messagePosition}, ${messages.seq})`.mapWith(
          Number
        ),
    })
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
      readMessageSeq: sql`greatest(coalesce(${conversations.readMessageSeq}, 0), ${message.position})`,
    })
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.id, conversationId)
      )
    );
  return "ok";
}

// ---------- 메시지 저장 ----------

/**
 * 사용자 메시지·깨우기·Event를 한 transaction으로 저장한다. 하나라도 실패하면 아무것도 남지 않는다.
 * 새 대화의 첫 메시지면 그 대화도 같은 transaction에 남기므로, 메시지가 남지 않으면 빈 대화도 남지 않는다.
 * 조직 → 받는 에이전트 순으로 잠근 뒤 받을지 정한다(contracts `newMessageRefusal`, 웹 입력창과 같은 판정). 최종 완료·중단 조직이면 `organization_closed`,
 * 그 에이전트에게 줄 세운 메시지가 상한이면 `queue_full`이고 아무것도 남기지 않는다. 에이전트 행 잠금이 같은 에이전트에게 가는
 * 다른 보내기·거두기·admission과 직렬화하므로 센 수가 상한을 넘지 않는다.
 * `중단하고 보내기`면 같은 transaction에서 받는 에이전트의 진행 중 실행 시도에 취소를 요청하고 그 제어 명령 Event도 남긴다.
 * 조직 행을 먼저 잠가 admission과 직렬화하므로, 메시지는 취소된 실행 시도가 아니라 그 뒤의 실행 시도에 묶인다.
 * commit 뒤 실행기에 취소를 보내고 받는 에이전트를 깨운다. 값은 계획한 새 대화(있으면)와 메시지다.
 */
export async function insertOwnerMessage(
  db: Database,
  plan: OwnerMessagePlan
): Promise<
  Stored<
    { conversation: Conversation | null; message: ConversationMessage },
    "organization_closed" | "queue_full"
  >
> {
  return db.transaction(async (tx) => {
    const { organizationId, agentId } = plan.message;
    const org = await lockOrganization(tx, organizationId);
    const agent = await lockAgent(tx, organizationId, agentId);
    const refusal = newMessageRefusal({
      stage: org!.stage,
      queuedCount: await countQueuedMessages(tx, agentId),
    });
    if (refusal) return refused(refusal);
    let control: InterruptPlan | null = null;
    if (plan.message.delivery === "interrupt") {
      const running = await lockRunningRunOfAgent(tx, agentId);
      const planned = planInterrupt(plan.message, {
        stage: org!.stage,
        leadPaused: agent!.paused,
        runningRunId: running,
      });
      if (planned === "organization_closed") return refused(planned);
      control = planned;
    }
    if (plan.conversation)
      await tx.insert(conversations).values(conversationRow(plan.conversation));
    await tx.insert(messages).values(messageRow(plan.message));
    await tx
      .insert(wakes)
      .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
    const value = { conversation: plan.conversation, message: plan.message };
    const woken = [plan.wake.agentId];
    const created = await insertEvent(tx, plan.event);
    if (!control) return stored(value, { events: [created], woken });
    await requestCancellation(tx, control.cancellation);
    return stored(value, {
      events: [created, await insertEvent(tx, control.event)],
      cancellation: control.cancellation,
      woken,
    });
  });
}

/**
 * 조직 도구 메시지 보내기. 메시지와 도구 호출 요약을 종료와 직렬화한 한 transaction으로 남긴다(`toolWrite`).
 * 답장할 대화는 core `chooseReplyConversation`이 정한다. 고른 대화가 같은 조직에 없으면 `not_found`,
 * 여러 대화의 사용자 메시지를 받은 실행 시도가 대화를 고르지 않았으면 `conversation_required`다.
 */
export async function insertAgentMessage(
  db: Database,
  run: ActiveRunRef,
  input: { body: string; conversationId?: string },
  options: ToolCall & { source: RecordSource }
): Promise<
  ToolWrite<ConversationMessage, "not_found" | "conversation_required">
> {
  return toolWrite(db, run, "send_message", options, async (tx, locked) => {
    if (
      input.conversationId &&
      !(await findConversation(tx, locked.organizationId, input.conversationId))
    )
      return { kind: "invalid", problem: "not_found" };
    const fallback = await findDefaultConversation(tx, locked.organizationId);
    const conversationId = chooseReplyConversation(
      input.conversationId,
      await receivedConversationIds(tx, locked.id),
      fallback!.id
    );
    if (conversationId === "conversation_required")
      return { kind: "invalid", problem: conversationId };
    const plan = planAgentMessage(
      locked,
      conversationId,
      input.body,
      options.source
    );
    await tx.insert(messages).values(messageRow(plan.message));
    return {
      kind: "ok",
      value: plan.message,
      events: [await insertEvent(tx, plan.event)],
    };
  });
}

const messageRow = (m: ConversationMessage) => ({
  id: m.id,
  organizationId: m.organizationId,
  agentId: m.agentId,
  conversationId: m.conversationId,
  author: m.author,
  body: m.body,
  delivery: m.delivery,
  sentByRunId: m.sentByRunId,
  createdAt: new Date(m.createdAt),
});

// ---------- 받은 순서 ----------

/**
 * 실행 시도가 깨우기들을 받았다. 그 가운데 사용자 메시지에 받은 순간의 위치(`delivered_seq`)와 시각(`delivered_at`, 실행 시도의
 * 시작 시각)을 적는다. admission transaction 안에서 실행 시도마다 `messages.seq`의 sequence에서 값 하나를 뽑으므로 그 뒤 Lead가
 * 쓰는 메시지보다 앞, 그 전에 쓴 메시지보다 뒤에 놓인다.
 */
export async function markDelivered(
  tx: Executor,
  run: { startedAt: string },
  wakeIds: string[]
) {
  const messageIds = await messagesOfWakes(tx, wakeIds);
  if (!messageIds.length) return;
  const {
    rows: [next],
  } = await tx.execute<{ position: string }>(
    sql`select nextval(pg_get_serial_sequence('messages', 'seq')) as position`
  );
  await tx
    .update(messages)
    .set({
      deliveredSeq: Number(next!.position),
      deliveredAt: new Date(run.startedAt),
    })
    .where(inArray(messages.id, messageIds));
}

/** 다시 대기한 깨우기의 사용자 메시지는 줄 세운 메시지로 돌아가고, 다음 실행 시도가 받은 순간에 다시 놓인다. */
export async function markRequeued(tx: Executor, wakeIds: string[]) {
  const messageIds = await messagesOfWakes(tx, wakeIds);
  if (!messageIds.length) return;
  await tx
    .update(messages)
    .set({ deliveredSeq: null, deliveredAt: null })
    .where(inArray(messages.id, messageIds));
}

async function messagesOfWakes(tx: Executor, wakeIds: string[]) {
  if (!wakeIds.length) return [];
  const rows = await tx
    .select({ messageId: wakes.messageId })
    .from(wakes)
    .where(inArray(wakes.id, wakeIds));
  return rows.flatMap((w) => (w.messageId ? [w.messageId] : []));
}

/**
 * 대화 속 메시지 위치. 대화는 Lead가 받은 순서다. Lead 메시지는 저장 순서(`seq`), 사용자 메시지는 실행 시도가 받은 순간(`delivered_seq`,
 * 같은 sequence)에 놓이므로 먼저 보냈어도 나중에 받은 메시지는 뒤에 온다. 줄 세운 메시지는 아직 위치가 없다.
 */
const messagePosition = sql<
  number | null
>`case when ${messages.author} = 'agent' then ${messages.seq} else ${messages.deliveredSeq} end`.mapWith(
  Number
);
/** 같은 위치 안의 순서: Lead 메시지, `중단하고 보내기`로 받은 메시지, 줄 세워 받은 메시지. 그다음은 보낸 순서(`seq`)다. */
const positionRank =
  sql<number>`case when ${messages.author} = 'agent' then 0 when ${messages.delivery} = 'interrupt' then 1 else 2 end`.mapWith(
    Number
  );

/** 받은 순서 열쇠 [위치, 같은 위치 안의 순서, 저장 순서]. 대화에 놓인(받은) 메시지에는 위치가 늘 있다. */
type OrderKey = [number, number, number];
const orderKey = sql`(${messagePosition}, ${positionRank}, ${messages.seq})`;
const oldestFirst = [
  asc(messagePosition),
  asc(positionRank),
  asc(messages.seq),
];
/** 받은 순서의 반대: 최근 것부터. */
const latestFirst = [
  desc(messagePosition),
  desc(positionRank),
  desc(messages.seq),
];

/** 순서 열쇠를 붙인 메시지. 열쇠는 받은 순서의 [위치(줄 세운 메시지는 맨 뒤), 같은 위치 안의 순서, 저장 순서]다. */
type OrderedMessage = ConversationMessage & { order: OrderKey };

const byDeliveryOrder = (a: OrderedMessage, b: OrderedMessage) =>
  a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2];

/** 대화 쪽 커서: 받은 순서 열쇠를 감춘 글. 화면은 뜻을 해석하지 않고 그대로 돌려준다. */
const encodeCursor = (key: OrderKey) =>
  Buffer.from(key.join(".")).toString("base64url");
/** 서버가 준 커서가 아니면 null이다. */
function decodeCursor(cursor: string): OrderKey | null {
  const parts = Buffer.from(cursor, "base64url").toString().split(".");
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,18}$/.test(p)))
    return null;
  return parts.map(Number) as OrderKey;
}

// ---------- 조회 ----------

/** 에이전트에게 줄 세운 사용자 메시지 수: 아직 실행 시도가 받지 않았고 거두지 않은 메시지(모든 대화). */
export async function countQueuedMessages(db: Executor, agentId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(wakes, eq(wakes.messageId, messages.id))
    .where(
      and(
        eq(messages.agentId, agentId),
        eq(messages.author, "owner"),
        isNull(messages.withdrawnAt),
        isNull(wakes.runId)
      )
    );
  return row!.count;
}

/**
 * 같은 조직 대화 하나의 기록 한 쪽(Lead가 받은 순서, 오래된 것부터). 커서가 없으면 가장 최근 `limit`개, `before`는 그보다 오래된
 * `limit`개, `after`는 그보다 새 `limit`개다. 열쇠(받은 순서의 [위치, 같은 위치 안의 순서, 저장 순서])로 자르는 keyset 방식이라
 * 그사이 새 메시지가 와도 쪽이 밀리지 않는다. 메시지의 위치는 받은 뒤 바뀌지 않고 새로 받은 메시지는 늘 맨 뒤에 놓인다.
 * 서버가 준 것이 아닌 커서는 `invalid_cursor`다. 줄 세운 메시지는 `listQueuedMessages`가 따로 준다.
 */
export async function listConversationPage(
  db: Database,
  organizationId: string,
  conversationId: string,
  {
    before,
    after,
    limit = conversationPageSize,
  }: { before?: string; after?: string; limit?: number } = {}
): Promise<ConversationPage | "invalid_cursor"> {
  const beforeKey = before === undefined ? undefined : decodeCursor(before);
  const afterKey = after === undefined ? undefined : decodeCursor(after);
  if (beforeKey === null || afterKey === null) return "invalid_cursor";
  const rows = await selectConversation(db, organizationId, conversationId, {
    before: beforeKey,
    after: afterKey,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  // 한 개 더 읽어 다음 쪽이 있는지 본다. 고른 방향의 끝(오래된 쪽이면 맨 앞, 새 쪽이면 맨 뒤)에서 덜어 낸다.
  const page = !hasMore
    ? rows
    : afterKey
      ? rows.slice(0, limit)
      : rows.slice(1);
  const newest = page.at(-1);
  // `after` 쪽 앞에는 늘 커서의 메시지가 있으므로 비지 않았으면 더 오래된 쪽이 있다.
  const hasOlder = afterKey ? page.length > 0 : hasMore;
  return {
    messages: page.map(withoutOrder),
    hasMore,
    before: hasOlder ? encodeCursor(page[0]!.order) : null,
    after: newest ? encodeCursor(newest.order) : (after ?? null),
  };
}

/** 같은 조직 대화 하나의 줄 세운 메시지 전부. 보낸 순서이며 상한(`maxQueuedMessages`)이 있어 쪽을 나누지 않는다. */
export async function listQueuedMessages(
  db: Database,
  organizationId: string,
  conversationId: string
): Promise<ConversationMessage[]> {
  return (await selectQueuedMessages(db, organizationId, conversationId)).map(
    withoutOrder
  );
}

/** 처음 연 대화 화면이 보는 것: 대화의 가장 최근 쪽 뒤에 줄 세운 메시지 전부. 검사와 도구가 쓴다. */
export async function listConversationMessages(
  db: Database,
  organizationId: string,
  conversationId: string,
  { limit = conversationPageSize }: { limit?: number } = {}
): Promise<ConversationMessage[]> {
  const [page, queued] = await Promise.all([
    listConversationPage(db, organizationId, conversationId, { limit }),
    listQueuedMessages(db, organizationId, conversationId),
  ]);
  return [...(page === "invalid_cursor" ? [] : page.messages), ...queued];
}

/** 조직 안의 메시지 하나. 다른 조직의 메시지·거둔 메시지와 없는 메시지를 구별하지 않는다. */
export async function findMessage(
  db: Database,
  organizationId: string,
  messageId: string
): Promise<ConversationMessage | undefined> {
  if (!isUuid(messageId)) return undefined;
  const [row] = await conversationQuery(db).where(
    and(
      eq(messages.organizationId, organizationId),
      eq(messages.id, messageId),
      isNull(messages.withdrawnAt)
    )
  );
  return row && withoutOrder(toMessage(row));
}

/** 조직 안의 메시지 하나와 거뒀는지. 거둔 메시지도 준다. 줄 세운 메시지 명령이 잠근 뒤 지금 상태를 읽는다. */
export async function readMessage(
  tx: Executor,
  organizationId: string,
  messageId: string
): Promise<{ message: ConversationMessage; withdrawn: boolean } | undefined> {
  const [row] = await conversationQuery(tx).where(
    and(eq(messages.organizationId, organizationId), eq(messages.id, messageId))
  );
  return (
    row && {
      message: withoutOrder(toMessage(row)),
      withdrawn: row.message.withdrawnAt !== null,
    }
  );
}

/**
 * 실행 시도 맥락의 대화. Lead만 대화를 가지며, 기본 대화와 그 실행 시도가 받은 사용자 메시지의 대화마다
 * 이 실행 시도까지 전달된 최근 메시지 50개를 대화 화면과 같은 받은 순서로 합친다.
 */
export async function runConversations(
  db: Executor,
  run: { id: string; organizationId: string; agentId: string; seq: number },
  role: AgentRole
): Promise<
  Pick<RunContextResponse["context"], "conversations" | "conversation">
> {
  if (role !== "lead") return { conversations: [], conversation: [] };
  const found = await contextConversations(db, run.organizationId, run.id);
  const perConversation = await Promise.all(
    found.map((c) =>
      selectConversation(db, run.organizationId, c.id, {
        agentId: run.agentId,
        upToRunSeq: run.seq,
        limit: 50,
      })
    )
  );
  return {
    conversations: found.map(({ organizationId: _org, ...c }) => c),
    conversation: perConversation
      .flat()
      .sort(byDeliveryOrder)
      .map(withoutOrder),
  };
}

// ---------- 내부 ----------

const sentBy = alias(runs, "sent_by");
const deliveredTo = alias(runs, "delivered_to");

const conversationQuery = (db: Executor) =>
  db
    .select({
      message: messages,
      deliveredToRunId: wakes.runId,
      position: messagePosition,
      rank: positionRank,
    })
    .from(messages)
    .leftJoin(wakes, eq(wakes.messageId, messages.id))
    .leftJoin(sentBy, eq(sentBy.id, messages.sentByRunId))
    .leftJoin(deliveredTo, eq(deliveredTo.id, wakes.runId))
    .$dynamic();

/**
 * 대화 하나의 기록: Lead 메시지와 실행 시도가 받은 사용자 메시지. Lead가 받은 순서이며(`messagePosition`), 순서 열쇠(`order`)를
 * 붙여 여러 대화를 합칠 수 있게 한다. 줄 세운 메시지(`selectQueuedMessages`)와 사용자가 거둔 메시지는 없다(화면과 Lead 맥락 모두).
 */
async function selectConversation(
  db: Executor,
  organizationId: string,
  conversationId: string,
  {
    agentId,
    upToRunSeq,
    before,
    after,
    limit,
  }: {
    agentId?: string;
    upToRunSeq?: number;
    before?: OrderKey;
    after?: OrderKey;
    limit: number;
  }
): Promise<OrderedMessage[]> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return [];
  const rows = await conversationQuery(db)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.conversationId, conversationId),
        isNull(messages.withdrawnAt),
        or(eq(messages.author, "agent"), isNotNull(wakes.runId)),
        agentId === undefined ? undefined : eq(messages.agentId, agentId),
        upToRunSeq === undefined
          ? undefined
          : or(lte(sentBy.seq, upToRunSeq), lte(deliveredTo.seq, upToRunSeq)),
        before && sql`${orderKey} < (${before[0]}, ${before[1]}, ${before[2]})`,
        after && sql`${orderKey} > (${after[0]}, ${after[1]}, ${after[2]})`
      )
    )
    .orderBy(...(after ? oldestFirst : latestFirst))
    .limit(limit);
  return (after ? rows : rows.reverse()).map(toMessage);
}

/** 대화 하나의 줄 세운 메시지 전부. 보낸 순서이며 개수를 자르지 않는다. 거둔 메시지는 없다. */
async function selectQueuedMessages(
  db: Executor,
  organizationId: string,
  conversationId: string
): Promise<OrderedMessage[]> {
  if (!isUuid(organizationId) || !isUuid(conversationId)) return [];
  const rows = await conversationQuery(db)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.conversationId, conversationId),
        eq(messages.author, "owner"),
        isNull(messages.withdrawnAt),
        isNull(wakes.runId)
      )
    )
    .orderBy(asc(messages.seq));
  return rows.map(toMessage);
}

const toMessage = ({
  message: {
    seq,
    createdAt,
    withdrawnAt: _withdrawnAt,
    deliveredSeq: _deliveredSeq,
    deliveredAt,
    ...message
  },
  deliveredToRunId,
  position,
  rank,
}: {
  message: typeof messages.$inferSelect;
  deliveredToRunId: string | null;
  position: number | null;
  rank: number;
}): OrderedMessage => ({
  ...message,
  deliveredToRunId,
  deliveredAt: deliveredAt?.toISOString() ?? null,
  createdAt: createdAt.toISOString(),
  order: [position ?? Number.POSITIVE_INFINITY, rank, seq],
});

const withoutOrder = ({
  order: _order,
  ...message
}: OrderedMessage): ConversationMessage => message;
