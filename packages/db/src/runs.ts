import {
  conversationPageSize,
  type AgentDetail,
  type AgentRole,
  type ConversationMessage,
  type ConversationPage,
  type Event,
  type InstructionFile,
  type PublicActivity,
  type RunCancelReason,
  type RunContextResponse,
  type RunDetail,
  type RunResult,
  type RunSummary,
  type WakeReason,
} from "@babojubot/contracts";
import {
  acceptsToolCalls,
  admitsRuns,
  chooseReplyConversation,
  decisionOfStatus,
  instructionsBundleVersion,
  ownerMessageRefusal,
  planAgentMessage,
  planInterrupt,
  planRunFinish,
  planRunInterruption,
  planRunStart,
  type InterruptPlan,
  type NewRun,
  type OwnerMessagePlan,
  type PendingWake,
  runBlockingStages,
  type RecordSource,
  type RunCancellation,
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
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./client.ts";
import {
  contextConversations,
  conversationRow,
  findConversation,
  findDefaultConversation,
  latestFirst,
  messagePosition,
  positionRank,
  receivedConversationIds,
} from "./conversations.ts";
import { toolWrite, type ToolCall, type ToolWrite } from "./tool-calls.ts";
import {
  hasPendingHeartbeat,
  insertEvent,
  lockAgent,
  lockRunningRunOfAgent,
  lockOrganization,
  requestCancellation,
  isUuid,
  lockRunningRun,
  toAgent,
  toAgentHeartbeat,
  toEvent,
  toOrganization,
  type Executor,
} from "./rows.ts";
import {
  agentToAgentMessages,
  agents,
  approvals,
  conversations,
  events,
  flowTemplates,
  instructionCopies,
  instructionRevisions,
  messages,
  organizations,
  researchMapEdits,
  resultSubmissions,
  runs,
  runWakes,
  taskComments,
  tasks,
  wakes,
} from "./schema.ts";

// ---------- 메시지와 깨우기 ----------

/**
 * 사용자 메시지·깨우기·Event를 한 transaction으로 저장한다. 하나라도 실패하면 아무것도 남지 않는다.
 * 새 대화의 첫 메시지면 그 대화도 같은 transaction에 남기므로, 메시지가 남지 않으면 빈 대화도 남지 않는다.
 * 조직 → 받는 에이전트 순으로 잠근 뒤 받을지 정한다(core `ownerMessageRefusal`). 최종 완료·중단 조직이면 `organization_closed`,
 * 그 에이전트에게 줄 세운 메시지가 상한이면 `queue_full`이고 아무것도 남기지 않는다. 에이전트 행 잠금이 같은 에이전트에게 가는
 * 다른 보내기·거두기·admission과 직렬화하므로 센 수가 상한을 넘지 않는다.
 * `중단하고 보내기`면 같은 transaction에서 받는 에이전트의 진행 중 실행 시도에 취소를 요청하고 그 제어 명령 Event도 남긴다.
 * 조직 행을 먼저 잠가 admission과 직렬화하므로, 메시지는 취소된 실행 시도가 아니라 그 뒤의 실행 시도에 묶인다.
 * 실행기에 취소를 보내는 일은 commit 뒤 호출자가 `cancellation`으로 한다.
 */
export async function insertOwnerMessage(
  db: Database,
  plan: OwnerMessagePlan
): Promise<
  | { kind: "sent"; events: Event[]; cancellation: RunCancellation | null }
  | { kind: "organization_closed" | "queue_full" }
> {
  return db.transaction(async (tx) => {
    const { organizationId, agentId } = plan.message;
    const org = await lockOrganization(tx, organizationId);
    await lockAgent(tx, organizationId, agentId);
    const refused = ownerMessageRefusal({
      stage: org!.stage,
      queuedCount: await countQueuedMessages(tx, agentId),
    });
    if (refused) return { kind: refused };
    let control: InterruptPlan | null = null;
    if (plan.message.delivery === "interrupt") {
      const running = await lockRunningRunOfAgent(tx, agentId);
      const planned = planInterrupt(plan.message, org!.stage, running);
      if (planned === "organization_closed") return { kind: planned };
      control = planned;
    }
    if (plan.conversation)
      await tx.insert(conversations).values(conversationRow(plan.conversation));
    await tx.insert(messages).values(messageRow(plan.message));
    await tx
      .insert(wakes)
      .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
    const created = await insertEvent(tx, plan.event);
    if (!control)
      return { kind: "sent", events: [created], cancellation: null };
    await requestCancellation(tx, control.cancellation);
    return {
      kind: "sent",
      events: [created, await insertEvent(tx, control.event)],
      cancellation: control.cancellation,
    };
  });
}

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

// ---------- 실행 시도 admission ----------

export type ClaimedRun = {
  run: NewRun;
  wakeReasons: WakeReason[];
  /** 지침 bundle 버전을 정한 사본 내용. admission 때 고정해 실행기에 그대로 넘긴다. */
  instructions: InstructionFile[];
  event: Event;
};

/**
 * 에이전트의 대기 중인 깨우기를 새 실행 시도 하나에 고정한다. 보통은 모두이고, `중단하고 보내기` 메시지가 기다리면
 * 그 메시지 깨우기만이다(core `bundleWakes`). 나머지는 대기한 채 그 실행 시도가 끝난 뒤의 실행 시도가 받는다. 에이전트 행을 잠근 뒤 실행 중인 실행 시도가
 * 있는지 다시 보므로 여러 호출자가 동시에 불러도 실행 시도는 하나만 생긴다(부분 unique가 마지막 방어선).
 * 실행 중이거나 대기 중인 깨우기가 없으면 아무것도 하지 않는다. 실행기는 commit 뒤에 부른다.
 * 지침 bundle 버전은 같은 transaction에서 읽은 그 에이전트의 사본 내용으로 정한다.
 *
 * 조직이 실행 시도를 받지 않는 단계(최종 완료·일시정지·중단, core `admitsRuns`)이거나 에이전트가 일시정지면
 * 깨우기를 남겨 두고 아무것도 하지 않는다. 취소를 요청받고 정리 중인 실행 시도도 실행 중이므로 끝날 때까지 다음 실행 시도는 없다.
 * 단계 검사는 조직 행 `FOR SHARE` 아래에서 하므로 단계 전이(`FOR NO KEY UPDATE`)와 직렬화된다. 전이가 먼저면 바뀐 단계를 보고,
 * admission이 먼저면 전이는 그 실행 시도가 생긴 뒤에 일어난다. 잠금 순서는 조직 → 에이전트다. 에이전트를 먼저 잠그면
 * 조직 행을 잠근 채 깨우기·Event의 FK로 에이전트 행(`KEY SHARE`)을 기다리는 쓰기와 교착한다.
 */
export async function claimNextRun(
  db: Database,
  agentId: string,
  options: { tokenDigest: string; source: RecordSource }
): Promise<ClaimedRun | undefined> {
  return db.transaction(async (tx) => {
    // 에이전트의 조직은 바뀌지 않는다. 잠그기 전에 읽어도 된다.
    const [owner] = await tx
      .select({ organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!owner) return undefined;
    const [org] = await tx
      .select({ stage: organizations.stage })
      .from(organizations)
      .where(eq(organizations.id, owner.organizationId))
      .for("share");
    if (!admitsRuns(org!.stage)) return undefined;
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .for("update");
    if (!agent || agent.paused) return undefined;
    if (await findRunningRunId(tx, agentId)) return undefined;

    const pendingWakes = await selectWakes(
      tx,
      and(eq(wakes.agentId, agentId), isNull(wakes.runId))
    );
    const [previous] = await tx
      .select({
        instructionsBundleVersion: runs.instructionsBundleVersion,
        nextSession: runs.sessionAfter,
      })
      .from(runs)
      .where(eq(runs.agentId, agentId))
      .orderBy(desc(runs.seq))
      .limit(1);
    const instructions = await selectInstructions(tx, agentId);
    const plan = planRunStart(
      {
        agent: toAgent(agent),
        pendingWakes,
        instructionsBundleVersion: instructionsBundleVersion(instructions),
        previousRun: previous,
      },
      options.source
    );
    if (!plan) return undefined;

    await tx.insert(runs).values({
      ...plan.run,
      status: "running",
      tokenDigest: options.tokenDigest,
      startedAt: new Date(plan.run.startedAt),
    });
    const ids = plan.wakeIds;
    const claimed = await tx
      .update(wakes)
      .set({ runId: plan.run.id })
      .where(and(inArray(wakes.id, ids), isNull(wakes.runId)))
      .returning({ id: wakes.id });
    if (claimed.length !== ids.length)
      throw new Error("wake bundle changed while claiming a run");
    await markDelivered(tx, ids, new Date(plan.run.startedAt));
    await tx.insert(runWakes).values(
      ids.map((wakeId) => ({
        organizationId: plan.run.organizationId,
        runId: plan.run.id,
        wakeId,
      }))
    );
    const event = await insertEvent(tx, plan.event);
    return {
      run: plan.run,
      wakeReasons: plan.wakeReasons,
      instructions,
      event,
    };
  });
}

/**
 * 종료 결과를 저장한다. 이미 끝난 실행 시도면 아무것도 바꾸지 않고 `undefined`를 돌려준다.
 * 취소를 요청받은 실행 시도는 실행기의 결과와 상관없이 `cancelled`로 끝난다(core `planRunFinish`).
 */
export async function finishRun(
  db: Database,
  runId: string,
  result: RunResult,
  source: Pick<RecordSource, "now">
): Promise<Event | undefined> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: runs.id,
        organizationId: runs.organizationId,
        agentId: runs.agentId,
        cancelReason: runs.cancelReason,
      })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .for("update");
    if (!run) return undefined;
    const plan = planRunFinish(run, result, source);
    await tx
      .update(runs)
      .set({ ...plan.update, finishedAt: new Date(plan.update.finishedAt) })
      .where(eq(runs.id, runId));
    return insertEvent(tx, plan.event);
  });
}

/**
 * 서버가 멈춰 실행기 결과 없이 끝나는 실행 시도를 끝낸다(core `planRunInterruption`). 종료·깨우기 복원·Event는 한 transaction이며,
 * 이미 끝난 실행 시도면 아무것도 바꾸지 않고 `undefined`다. 서버 시작의 복구와 서버 종료 때 취소로 돌아온 실행 시도가 쓴다.
 */
export async function interruptRun(
  db: Database,
  runId: string,
  source: Pick<RecordSource, "now">
): Promise<Event | undefined> {
  return db.transaction(async (tx) => {
    // 실행 시도의 조직·에이전트는 바뀌지 않는다. 잠그기 전에 읽어도 된다.
    const [owner] = await tx
      .select({ organizationId: runs.organizationId, agentId: runs.agentId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!owner) return undefined;
    // 잠금 순서는 조직 → 에이전트 → 실행 시도다. 에이전트 행 잠금으로 heartbeat scheduler·admission과 직렬화해,
    // 대기 heartbeat를 확인한 뒤 새 heartbeat가 생겨 다시 대기시킨 heartbeat와 겹치지 않게 한다.
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, owner.organizationId))
      .for("share");
    await lockAgent(tx, owner.organizationId, owner.agentId);
    const [run] = await tx
      .select({
        id: runs.id,
        organizationId: runs.organizationId,
        agentId: runs.agentId,
        cancelReason: runs.cancelReason,
        sessionBefore: runs.sessionBefore,
      })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .for("update");
    if (!run) return undefined;
    const held = await tx
      .select({ id: wakes.id, kind: wakes.kind })
      .from(wakes)
      .where(eq(wakes.runId, runId))
      .orderBy(asc(wakes.seq));
    const pendingHeartbeat = await hasPendingHeartbeat(tx, run.agentId);
    const plan = planRunInterruption(
      run,
      { wakes: held, pendingHeartbeat },
      source
    );
    await tx
      .update(runs)
      .set({ ...plan.update, finishedAt: new Date(plan.update.finishedAt) })
      .where(eq(runs.id, runId));
    if (plan.requeueWakeIds.length) {
      const requeued = await tx
        .update(wakes)
        .set({ runId: null })
        .where(
          and(inArray(wakes.id, plan.requeueWakeIds), eq(wakes.runId, runId))
        )
        .returning({ messageId: wakes.messageId });
      // 다시 대기한 사용자 메시지는 줄 세운 메시지로 돌아가고, 다음 실행 시도가 받은 순간에 다시 놓인다.
      const messageIds = requeued.flatMap((w) =>
        w.messageId ? [w.messageId] : []
      );
      if (messageIds.length)
        await tx
          .update(messages)
          .set({ deliveredSeq: null, deliveredAt: null })
          .where(inArray(messages.id, messageIds));
    }
    return insertEvent(tx, plan.event);
  });
}

/**
 * 서버가 멈춰 실행 중으로 남은 실행 시도를 `server_restart`로 끝내고 그 깨우기를 다시 대기시킨다(`interruptRun`).
 * 실행 시도를 돌리는 서버 프로세스가 하나라는 전제다(docs/architecture.md 패키지 구성). worker를 나누면 프로세스별 소유 기록이 필요하다.
 * 서버 시작 때 실행기를 부르기 전에 한 번 부른다. 실행 시도마다 따로 저장하므로 중간에 실패해도 다시 부르면 남은 것만 끝낸다.
 */
export async function recoverInterruptedRuns(
  db: Database,
  source: Pick<RecordSource, "now">
): Promise<Event[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.status, "running"))
    .orderBy(asc(runs.seq));
  const finished: Event[] = [];
  for (const { id } of rows) {
    const event = await interruptRun(db, id, source);
    if (event) finished.push(event);
  }
  return finished;
}

/**
 * 실행 시도를 받는 조직에서 대기 중인 깨우기가 있는 에이전트. 서버 시작·조직 재개 때 다시 깨운다.
 * 최종 완료·일시정지·중단 등 admission을 거부하는 조직과 일시정지한 에이전트의 깨우기는 남아 있어도 지금 처리할 것이 아니므로 빠진다.
 */
export async function listAgentsWithPendingWakes(
  db: Database,
  { organizationId }: { organizationId?: string } = {}
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentId: wakes.agentId })
    .from(wakes)
    .innerJoin(organizations, eq(organizations.id, wakes.organizationId))
    .innerJoin(agents, eq(agents.id, wakes.agentId))
    .where(
      and(
        isNull(wakes.runId),
        notInArray(organizations.stage, [...runBlockingStages]),
        eq(agents.paused, false),
        organizationId === undefined
          ? undefined
          : eq(wakes.organizationId, organizationId)
      )
    );
  return rows.map((r) => r.agentId);
}

/** 실행 시도에 요청된 사용자 제어 취소. 실행기 등록 직후 다시 읽어, 등록 전에 commit된 취소를 놓치지 않는다. */
export async function findRunCancelReason(
  db: Database,
  runId: string
): Promise<RunCancelReason | null> {
  const [row] = await db
    .select({ cancelReason: runs.cancelReason })
    .from(runs)
    .where(eq(runs.id, runId));
  return row?.cancelReason ?? null;
}

// ---------- 실행 시도별 토큰과 조직 도구 ----------

export type ActiveRun = {
  id: string;
  organizationId: string;
  agentId: string;
  agentRole: AgentRole;
};

/** 토큰 digest의 실행 시도가 실행 중이고 취소를 요청받지 않았을 때만 그 신원을 돌려준다. 그 밖이면 `undefined`. */
export async function authenticateRun(
  db: Database,
  tokenDigest: string
): Promise<ActiveRun | undefined> {
  const [row] = await db
    .select({
      id: runs.id,
      organizationId: runs.organizationId,
      agentId: runs.agentId,
      status: runs.status,
      cancelReason: runs.cancelReason,
      agentRole: agents.role,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(runs.tokenDigest, tokenDigest));
  if (!row || !acceptsToolCalls(row)) return undefined;
  const { status: _status, cancelReason: _cancel, ...run } = row;
  return run;
}

/**
 * 실행 중인 실행 시도의 공개 활동을 기록한다. 종료와 같은 행 잠금으로 직렬화하므로
 * 종료 뒤에 늦게 온 활동은 남지 않고 `undefined`를 돌려준다.
 */
export async function appendRunActivity(
  db: Database,
  runId: string,
  activity: PublicActivity
): Promise<Event | undefined> {
  return db.transaction(async (tx) => {
    const run = await lockRunningRun(tx, runId);
    if (!run) return undefined;
    return insertEvent(tx, {
      organizationId: run.organizationId,
      type: "run.activity",
      payload: { runId: run.id, agentId: run.agentId, activity },
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
  run: ActiveRun,
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

/** 실행 시도 요청과 내 실행 맥락 조회가 같은 내용을 쓴다. 이 실행 시도까지 전달된 기록만 담는다. */
export async function loadRunContext(
  db: Database,
  runId: string
): Promise<RunContextResponse | undefined> {
  const [row] = await db
    .select({ run: runs, agent: agents, organization: organizations })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .innerJoin(organizations, eq(organizations.id, runs.organizationId))
    .where(eq(runs.id, runId));
  if (!row) return undefined;
  const { run, agent, organization } = row;
  const wakeReasons = (await selectRunWakes(db, run.id)).map((w) => w.reason);
  const [template] = await db
    .select({
      nodeKinds: flowTemplates.nodeKinds,
      linkKinds: flowTemplates.linkKinds,
    })
    .from(flowTemplates)
    .where(eq(flowTemplates.organizationId, run.organizationId));
  return {
    identity: {
      organizationId: run.organizationId,
      agentId: run.agentId,
      runId: run.id,
    },
    wakeReasons,
    context: {
      organization: (({ id, name, stage, goal, completionCriteria }) => ({
        id,
        name,
        stage,
        goal,
        completionCriteria,
      }))(toOrganization(organization)),
      agent: { id: agent.id, role: agent.role, name: agent.name },
      team: await db
        .select({ id: agents.id, role: agents.role, name: agents.name })
        .from(agents)
        .where(eq(agents.organizationId, run.organizationId))
        .orderBy(asc(agents.createdAt), asc(agents.name)),
      ...(await runConversations(db, run, agent.role)),
      researchFlow: template ?? null,
    },
  };
}

/**
 * 실행 시도 맥락의 대화. Lead만 대화를 가지며, 기본 대화와 그 실행 시도가 받은 사용자 메시지의 대화마다
 * 이 실행 시도까지 전달된 최근 메시지 50개를 대화 화면과 같은 받은 순서로 합친다.
 */
async function runConversations(
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

// ---------- Surface 조회 ----------

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

/** 처음 연 대화 화면이 보는 것: 대화 기록의 가장 최근 쪽 뒤에 줄 세운 메시지 전부. 검사와 도구가 쓴다. */
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

/** 조직의 실행 시도. 최근 것부터. */
export async function listRuns(
  db: Database,
  organizationId: string,
  { agentId, limit = 50 }: { agentId?: string; limit?: number } = {}
): Promise<RunSummary[]> {
  if (!isUuid(organizationId)) return [];
  if (agentId !== undefined && !isUuid(agentId)) return [];
  const rows = await db
    .select(runSummaryColumns)
    .from(runs)
    .where(
      and(
        eq(runs.organizationId, organizationId),
        agentId === undefined ? undefined : eq(runs.agentId, agentId)
      )
    )
    .orderBy(desc(runs.seq))
    .limit(limit);
  return rows.map(toRunSummary);
}

/**
 * 조직의 진행 중 실행 시도(취소 정리 중 포함). 최근 목록(`listRuns`)은 개수를 자르므로 오래 실행 중인 것이 빠질 수 있다.
 * 진행 중 실행 시도는 에이전트당 하나뿐이라 자르지 않는다.
 */
export async function listRunningRuns(
  db: Executor,
  organizationId: string
): Promise<RunSummary[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db
    .select(runSummaryColumns)
    .from(runs)
    .where(
      and(eq(runs.organizationId, organizationId), eq(runs.status, "running"))
    )
    .orderBy(desc(runs.seq));
  return rows.map(toRunSummary);
}

/** 실행 시도 상세. 다른 조직의 실행 시도와 없는 실행 시도를 구별하지 않는다. */
export async function findRunDetail(
  db: Database,
  organizationId: string,
  runId: string
): Promise<RunDetail | undefined> {
  if (!isUuid(organizationId) || !isUuid(runId)) return undefined;
  const [row] = await db
    .select({ ...runSummaryColumns, usage: runs.usage })
    .from(runs)
    .where(and(eq(runs.organizationId, organizationId), eq(runs.id, runId)));
  if (!row) return undefined;
  const { usage, ...summary } = row;
  const wakeReasons = (await selectRunWakes(db, runId)).map((w) => w.reason);
  const transcript = await db
    .select()
    .from(events)
    .where(
      and(eq(events.organizationId, organizationId), eq(events.runId, runId))
    )
    .orderBy(asc(events.id));
  return {
    ...toRunSummary(summary),
    wakeReasons,
    usage,
    transcript: transcript.map(toEvent),
  };
}

/** 에이전트 상세: 상태와 최근 실행 시도. */
export async function findAgentDetail(
  db: Database,
  organizationId: string,
  agentId: string,
  { recentRuns = 10 }: { recentRuns?: number } = {}
): Promise<AgentDetail | undefined> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return undefined;
  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(eq(agents.organizationId, organizationId), eq(agents.id, agentId))
    );
  if (!agent) return undefined;
  const recent = await listRuns(db, organizationId, {
    agentId,
    limit: recentRuns,
  });
  return {
    ...toAgent(agent),
    status: (await findRunningRunId(db, agentId)) ? "running" : "idle",
    paused: agent.paused,
    instructionsBundleVersion: instructionsBundleVersion(
      await selectInstructions(db, agentId)
    ),
    heartbeat: toAgentHeartbeat(agent),
    recentRuns: recent,
    queuedMessageCount: await countQueuedMessages(db, agentId),
  };
}

// ---------- 내부 ----------

async function findRunningRunId(db: Executor, agentId: string) {
  const [active] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")))
    .limit(1);
  return active?.id;
}

/** 에이전트의 지침 사본. bundle 버전 계산과 실행기 전달에 쓴다. */
async function selectInstructions(
  db: Executor,
  agentId: string
): Promise<InstructionFile[]> {
  return db
    .select({
      path: instructionCopies.path,
      content: instructionCopies.content,
    })
    .from(instructionCopies)
    .where(eq(instructionCopies.agentId, agentId))
    .orderBy(asc(instructionCopies.path));
}

/** 실행 시도가 받은 깨우기. 서버 재시작으로 다시 대기한 깨우기도 받았던 실행 시도의 기록에 남는다. */
const selectRunWakes = (db: Executor, runId: string) =>
  selectWakes(
    db,
    inArray(
      wakes.id,
      db
        .select({ id: runWakes.wakeId })
        .from(runWakes)
        .where(eq(runWakes.runId, runId))
    )
  );

/** 깨우기와 그 사유. 사유는 깨우기가 가리키는 기록(메시지, 승인 결정, 작업, 작업 댓글, 에이전트 메시지, 연구 지도 편집, 결과 수정 요청)에서 읽는다. heartbeat는 가리키는 기록이 없다. */
async function selectWakes(
  db: Executor,
  where: ReturnType<typeof and> | ReturnType<typeof inArray>
): Promise<PendingWake[]> {
  const rows = await db
    .select({
      wake: wakes,
      body: messages.body,
      delivery: messages.delivery,
      conversationId: messages.conversationId,
      approvalKind: approvals.kind,
      decision: approvals.status,
      note: approvals.decisionNote,
      task: {
        title: tasks.title,
        summary: tasks.reportSummary,
        completedBy: tasks.completedByAgentId,
      },
      comment: { taskId: taskComments.taskId, body: taskComments.body },
      agentToAgent: {
        sender: agentToAgentMessages.senderAgentId,
        body: agentToAgentMessages.body,
      },
      mapEdit: {
        operation: researchMapEdits.operation,
        nodeId: researchMapEdits.nodeId,
        summary: researchMapEdits.summary,
      },
      instructionEdit: {
        agentId: instructionRevisions.agentId,
        copyId: instructionRevisions.copyId,
        number: instructionRevisions.number,
        path: instructionCopies.path,
      },
      resultNote: resultSubmissions.decisionNote,
    })
    .from(wakes)
    .leftJoin(messages, eq(messages.id, wakes.messageId))
    .leftJoin(approvals, eq(approvals.id, wakes.approvalId))
    .leftJoin(tasks, eq(tasks.id, wakes.taskId))
    .leftJoin(taskComments, eq(taskComments.id, wakes.commentId))
    .leftJoin(
      agentToAgentMessages,
      eq(agentToAgentMessages.id, wakes.agentToAgentMessageId)
    )
    .leftJoin(researchMapEdits, eq(researchMapEdits.id, wakes.mapEditId))
    .leftJoin(
      instructionRevisions,
      eq(instructionRevisions.id, wakes.instructionRevisionId)
    )
    .leftJoin(
      instructionCopies,
      eq(instructionCopies.id, instructionRevisions.copyId)
    )
    .leftJoin(
      resultSubmissions,
      eq(resultSubmissions.id, wakes.resultSubmissionId)
    )
    .where(where)
    .orderBy(asc(wakes.seq));
  return rows.map(
    ({
      wake,
      body,
      delivery,
      conversationId,
      approvalKind,
      decision,
      note,
      task,
      comment,
      agentToAgent,
      mapEdit,
      instructionEdit,
      resultNote,
    }) => {
      const wakeId = wake.id;
      const reason = ((): WakeReason => {
        switch (wake.kind) {
          case "owner_message":
            return {
              kind: wake.kind,
              wakeId,
              messageId: wake.messageId!,
              conversationId: conversationId!,
              body: body!,
            };
          case "approval_decision":
            return {
              kind: wake.kind,
              wakeId,
              approvalId: wake.approvalId!,
              approvalKind: approvalKind!,
              decision: decisionOfStatus(decision!),
              note,
            };
          case "task_assigned":
            return {
              kind: wake.kind,
              wakeId,
              taskId: wake.taskId!,
              title: task!.title,
            };
          case "task_completed":
            return {
              kind: wake.kind,
              wakeId,
              taskId: wake.taskId!,
              title: task!.title,
              summary: task!.summary!,
              completedByAgentId: task!.completedBy!,
            };
          case "task_comment":
            return {
              kind: wake.kind,
              wakeId,
              taskId: comment!.taskId,
              commentId: wake.commentId!,
              body: comment!.body,
            };
          case "agent_to_agent_message":
            return {
              kind: wake.kind,
              wakeId,
              messageId: wake.agentToAgentMessageId!,
              senderAgentId: agentToAgent!.sender,
              body: agentToAgent!.body,
            };
          case "research_map_edit":
            return {
              kind: wake.kind,
              wakeId,
              editId: wake.mapEditId!,
              operation: mapEdit!.operation,
              nodeId: mapEdit!.nodeId,
              summary: mapEdit!.summary,
            };
          case "instruction_edit":
            return {
              kind: wake.kind,
              wakeId,
              revisionId: wake.instructionRevisionId!,
              agentId: instructionEdit!.agentId!,
              copyId: instructionEdit!.copyId!,
              path: instructionEdit!.path!,
              revision: instructionEdit!.number!,
            };
          case "result_changes_requested":
            return {
              kind: wake.kind,
              wakeId,
              submissionId: wake.resultSubmissionId!,
              note: resultNote!,
            };
          case "organization_created":
          case "heartbeat":
            return { kind: wake.kind, wakeId };
        }
      })();
      return {
        id: wake.id,
        organizationId: wake.organizationId,
        agentId: wake.agentId,
        createdAt: wake.createdAt.toISOString(),
        reason,
        delivery: wake.kind === "owner_message" ? delivery : null,
      };
    }
  );
}

const sentBy = alias(runs, "sent_by");
const deliveredTo = alias(runs, "delivered_to");

/**
 * 실행 시도가 받은 사용자 메시지에 받은 순간의 위치(`delivered_seq`)와 시각(`delivered_at`, 실행 시도의 시작 시각)을 적는다.
 * admission transaction 안에서 실행 시도마다 `messages.seq`의 sequence에서 값 하나를 뽑으므로 그 뒤 Lead가 쓰는 메시지보다 앞,
 * 그 전에 쓴 메시지보다 뒤에 놓인다.
 */
async function markDelivered(tx: Executor, wakeIds: string[], at: Date) {
  const received = await tx
    .select({ messageId: wakes.messageId })
    .from(wakes)
    .where(inArray(wakes.id, wakeIds));
  const messageIds = received.flatMap((w) =>
    w.messageId ? [w.messageId] : []
  );
  if (!messageIds.length) return;
  const {
    rows: [next],
  } = await tx.execute<{ position: string }>(
    sql`select nextval(pg_get_serial_sequence('messages', 'seq')) as position`
  );
  await tx
    .update(messages)
    .set({ deliveredSeq: Number(next!.position), deliveredAt: at })
    .where(inArray(messages.id, messageIds));
}

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

/** 받은 순서 열쇠 [위치, 같은 위치 안의 순서, 저장 순서]. 대화 기록(받은 메시지)에서는 위치가 늘 있다. */
type OrderKey = [number, number, number];
const orderKey = sql`(${messagePosition}, ${positionRank}, ${messages.seq})`;
const oldestFirst = [
  asc(messagePosition),
  asc(positionRank),
  asc(messages.seq),
];

/** 대화 기록 커서: 받은 순서 열쇠를 감춘 글. 화면은 뜻을 해석하지 않고 그대로 돌려준다. */
const encodeCursor = (key: OrderKey) =>
  Buffer.from(key.join(".")).toString("base64url");
/** 서버가 준 커서가 아니면 null이다. */
function decodeCursor(cursor: string): OrderKey | null {
  const parts = Buffer.from(cursor, "base64url").toString().split(".");
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,18}$/.test(p)))
    return null;
  return parts.map(Number) as OrderKey;
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

/** 순서 열쇠를 붙인 메시지. 열쇠는 받은 순서의 [위치(줄 세운 메시지는 맨 뒤), 같은 위치 안의 순서, 저장 순서]다. */
type OrderedMessage = ConversationMessage & { order: OrderKey };

const byDeliveryOrder = (a: OrderedMessage, b: OrderedMessage) =>
  a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2];

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

export const runSummaryColumns = {
  id: runs.id,
  organizationId: runs.organizationId,
  agentId: runs.agentId,
  status: runs.status,
  cancelReason: runs.cancelReason,
  summary: runs.summary,
  error: runs.error,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  // drizzle은 select 안의 열을 테이블 없이 쓰므로 상관 subquery는 이름을 직접 밝힌다.
  wakeCount: sql<number>`(select count(*) from "run_wakes" where "run_wakes"."run_id" = "runs"."id")::int`,
};

export const toRunSummary = (row: {
  id: string;
  organizationId: string;
  agentId: string;
  status: RunSummary["status"];
  cancelReason: RunSummary["cancelReason"];
  summary: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  wakeCount: number;
}): RunSummary => ({
  ...row,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});
