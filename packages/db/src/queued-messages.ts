import type { ConversationMessage, Event } from "@babojubot/contracts";
import {
  planEdit,
  planSendNow,
  planWithdrawal,
  type QueuedMessageRefusal,
  type QueuedMessageState,
  type RecordSource,
} from "@babojubot/core";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.ts";
import { readMessage } from "./conversations.ts";
import {
  insertEvent,
  isUuid,
  lockAgent,
  lockOrganization,
  lockRunningRunOfAgent,
  requestCancellation,
  type Executor,
} from "./rows.ts";
import { messages, wakes } from "./schema.ts";
import { refused, stored, type Stored } from "./stored.ts";

// 줄 세운 메시지 고치기·거두기·지금 보내기(core queued-message.ts). 잠금 순서는 조직 → 에이전트 → 실행 시도다.
// 에이전트 행 잠금이 admission(`claimNextRun`의 에이전트 `FOR UPDATE`)과 직렬화하므로, 잠근 뒤 읽은 깨우기가
// 아직 실행 시도에 묶이지 않았으면 이 transaction이 끝날 때까지 어떤 실행 시도도 그 깨우기를 받지 못한다.

/** 줄 세운 메시지 명령의 결과. 값은 바뀐 메시지다. */
export type QueuedMessageResult = Stored<
  ConversationMessage,
  QueuedMessageRefusal
>;

/**
 * 줄 세운 메시지를 거둔다. 메시지 행은 남기고 거둔 시각을 적으며, 아직 받지 않은 그 깨우기는 지운다.
 * 거둔 메시지는 대화와 Lead 맥락에서 빠지고 `message.withdrawn`이 남는다. 돌려주는 메시지는 거두기 전 모양이다(`고치기`가 글을 되돌린다).
 */
export async function withdrawQueuedMessage(
  db: Database,
  organizationId: string,
  messageId: string,
  source: Pick<RecordSource, "now">
): Promise<QueuedMessageResult> {
  if (!isUuid(organizationId) || !isUuid(messageId))
    return refused("not_found");
  return db.transaction(async (tx) => {
    const locked = await lockMessageAgent(tx, organizationId, messageId);
    if (!locked) return refused("not_found");
    const found = await readQueuedMessage(tx, organizationId, messageId);
    const plan = planWithdrawal(found?.state);
    if (typeof plan === "string") return refused(plan);
    await tx
      .update(messages)
      .set({ withdrawnAt: source.now() })
      .where(eq(messages.id, messageId));
    await tx
      .delete(wakes)
      .where(and(eq(wakes.messageId, messageId), isNull(wakes.runId)));
    return stored(found!.message, {
      events: [await insertEvent(tx, plan.event)],
    });
  });
}

/**
 * 줄 세운 메시지를 그 자리에서 고친다. 글만 바꾸고 전달 방식·줄 속 위치·깨우기는 그대로이며 `message.edited`에 고치기 전 글을 남긴다.
 * 일시정지 중에도 고칠 수 있다. 실행 시도가 먼저 받았으면 `message_delivered`, 끝난 조직이면 `organization_closed`다.
 */
export async function editQueuedMessage(
  db: Database,
  organizationId: string,
  messageId: string,
  body: string
): Promise<QueuedMessageResult> {
  if (!isUuid(organizationId) || !isUuid(messageId))
    return refused("not_found");
  return db.transaction(async (tx) => {
    const locked = await lockMessageAgent(tx, organizationId, messageId);
    if (!locked) return refused("not_found");
    const found = await readQueuedMessage(tx, organizationId, messageId);
    const plan = planEdit(found?.state, locked.stage, body);
    if (typeof plan === "string") return refused(plan);
    await tx.update(messages).set({ body }).where(eq(messages.id, messageId));
    return stored(
      { ...found!.message, body },
      { events: [await insertEvent(tx, plan.event)] }
    );
  });
}

/**
 * 줄 세운 메시지를 `지금 보내기`로 바꾼다. 전달 방식이 `중단하고 보내기`가 되고 받는 에이전트의 진행 중 실행 시도에 취소를 요청한다.
 * commit 뒤 실행기에 취소를 보내고 받는 에이전트를 깨운다.
 */
export async function sendQueuedMessageNow(
  db: Database,
  organizationId: string,
  messageId: string
): Promise<QueuedMessageResult> {
  if (!isUuid(organizationId) || !isUuid(messageId))
    return refused("not_found");
  return db.transaction(async (tx) => {
    const locked = await lockMessageAgent(tx, organizationId, messageId);
    if (!locked) return refused("not_found");
    const running = await lockRunningRunOfAgent(tx, locked.agent.id);
    const found = await readQueuedMessage(tx, organizationId, messageId);
    const plan = planSendNow(found?.state, {
      stage: locked.stage,
      agentPaused: locked.agent.paused,
      runningRunId: running,
    });
    if (typeof plan === "string") return refused(plan);
    await tx
      .update(messages)
      .set({ delivery: "interrupt" })
      .where(eq(messages.id, messageId));
    await requestCancellation(tx, plan.cancellation);
    const events: Event[] = [];
    for (const event of plan.events) events.push(await insertEvent(tx, event));
    return stored(
      { ...found!.message, delivery: "interrupt" as const },
      { events, cancellation: plan.cancellation, woken: [locked.agent.id] }
    );
  });
}

/** 조직 행을 잠그고 메시지가 가는 에이전트 행을 잠근다. 메시지의 에이전트는 바뀌지 않으므로 잠그기 전에 읽어도 된다. */
async function lockMessageAgent(
  tx: Executor,
  organizationId: string,
  messageId: string
) {
  const org = await lockOrganization(tx, organizationId);
  if (!org) return undefined;
  const [target] = await tx
    .select({ agentId: messages.agentId })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.id, messageId)
      )
    );
  if (!target) return undefined;
  const agent = await lockAgent(tx, organizationId, target.agentId);
  return agent && { stage: org.stage, agent };
}

/** 잠금 뒤 메시지와 그 깨우기의 지금 상태. */
async function readQueuedMessage(
  tx: Executor,
  organizationId: string,
  messageId: string
): Promise<
  | {
      state: QueuedMessageState & { body: string };
      message: ConversationMessage;
    }
  | undefined
> {
  const found = await readMessage(tx, organizationId, messageId);
  if (!found) return undefined;
  const { message, withdrawn } = found;
  return { message, state: { ...message, withdrawn } };
}
