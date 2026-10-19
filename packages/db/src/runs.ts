import type {
  AgentDetail,
  AgentRole,
  ConversationMessage,
  Event,
  InstructionFile,
  PublicActivity,
  RunContextResponse,
  RunDetail,
  RunResult,
  RunSummary,
  WakeReason,
} from "@babojubot/contracts";
import {
  acceptsToolCalls,
  decisionOfStatus,
  instructionsBundleVersion,
  planAgentMessage,
  planRunFinish,
  planRunStart,
  type NewRun,
  type OwnerMessagePlan,
  type PendingWake,
  type RecordSource,
} from "@babojubot/core";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./client.ts";
import {
  insertEvent,
  isUuid,
  lockRunningRun,
  toAgent,
  toEvent,
  toOrganization,
  type Executor,
} from "./rows.ts";
import {
  agents,
  approvals,
  events,
  instructionCopies,
  messages,
  organizations,
  runs,
  wakes,
} from "./schema.ts";

// ---------- 메시지와 깨우기 ----------

/** 사용자 메시지·깨우기·Event를 한 transaction으로 저장한다. 하나라도 실패하면 아무것도 남지 않는다. */
export async function insertOwnerMessage(
  db: Database,
  plan: OwnerMessagePlan
): Promise<Event> {
  return db.transaction(async (tx) => {
    await tx.insert(messages).values(messageRow(plan.message));
    await tx
      .insert(wakes)
      .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
    return insertEvent(tx, plan.event);
  });
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
 * 에이전트의 대기 중인 깨우기를 모두 새 실행 시도 하나에 고정한다. 에이전트 행을 잠근 뒤 실행 중인 실행 시도가
 * 있는지 다시 보므로 여러 호출자가 동시에 불러도 실행 시도는 하나만 생긴다(부분 unique가 마지막 방어선).
 * 실행 중이거나 대기 중인 깨우기가 없으면 아무것도 하지 않는다. 실행기는 commit 뒤에 부른다.
 * 지침 bundle 버전은 같은 transaction에서 읽은 그 에이전트의 사본 내용으로 정한다.
 */
export async function claimNextRun(
  db: Database,
  agentId: string,
  options: { tokenDigest: string; source: RecordSource }
): Promise<ClaimedRun | undefined> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .for("update");
    if (!agent) return undefined;
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
    const ids = pendingWakes.map((w) => w.id);
    const claimed = await tx
      .update(wakes)
      .set({ runId: plan.run.id })
      .where(and(inArray(wakes.id, ids), isNull(wakes.runId)))
      .returning({ id: wakes.id });
    if (claimed.length !== ids.length)
      throw new Error("wake bundle changed while claiming a run");
    const event = await insertEvent(tx, plan.event);
    return {
      run: plan.run,
      wakeReasons: plan.wakeReasons,
      instructions,
      event,
    };
  });
}

/** 종료 결과를 저장한다. 이미 끝난 실행 시도면 아무것도 바꾸지 않고 `undefined`를 돌려준다. */
export async function finishRun(
  db: Database,
  runId: string,
  result: RunResult,
  source: Pick<RecordSource, "now">
): Promise<Event | undefined> {
  return db.transaction(async (tx) => {
    const run = await lockRunningRun(tx, runId, "update");
    if (!run) return undefined;
    const plan = planRunFinish(run, result, source);
    await tx
      .update(runs)
      .set({ ...plan.update, finishedAt: new Date(plan.update.finishedAt) })
      .where(eq(runs.id, runId));
    return insertEvent(tx, plan.event);
  });
}

const interruptedError =
  "서버가 실행 중에 멈춰 이 실행 시도를 끝내지 못했습니다.";

/**
 * 서버가 멈춰 실행 중으로 남은 실행 시도를 실패로 끝낸다. 실행 시도를 돌리는 서버 프로세스가 하나라는 전제다
 * (docs/architecture.md 패키지 구성). worker를 나누면 프로세스별 소유 기록이 필요하다. 그 실행 시도에 묶인 입력의 재처리는 #60에서 정한다.
 * 서버 시작 때 실행기를 부르기 전에 한 번 부른다.
 */
export async function failInterruptedRuns(
  db: Database,
  source: Pick<RecordSource, "now">
): Promise<Event[]> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.status, "running"));
  const finished: Event[] = [];
  for (const { id } of rows) {
    const event = await finishRun(
      db,
      id,
      {
        stopReason: "failed",
        error: interruptedError,
        summary: null,
        usage: null,
        nextSession: null,
      },
      source
    );
    if (event) finished.push(event);
  }
  return finished;
}

/** 대기 중인 깨우기가 있는 에이전트. 서버 시작 때 다시 깨운다. */
export async function listAgentsWithPendingWakes(
  db: Database
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentId: wakes.agentId })
    .from(wakes)
    .where(isNull(wakes.runId));
  return rows.map((r) => r.agentId);
}

// ---------- 실행 시도별 토큰과 조직 도구 ----------

export type ActiveRun = {
  id: string;
  organizationId: string;
  agentId: string;
  agentRole: AgentRole;
};

/** 토큰 digest의 실행 시도가 실행 중일 때만 그 신원을 돌려준다. 끝났거나 없으면 `undefined`. */
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
      agentRole: agents.role,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(runs.tokenDigest, tokenDigest));
  if (!row || !acceptsToolCalls(row.status)) return undefined;
  const { status: _status, ...run } = row;
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
    const run = await lockRunningRun(tx, runId, "share");
    if (!run) return undefined;
    return insertEvent(tx, {
      organizationId: run.organizationId,
      type: "run.activity",
      payload: { runId: run.id, agentId: run.agentId, activity },
    });
  });
}

/** 조직 도구 메시지 보내기. 메시지와 도구 호출 요약을 종료와 직렬화한 한 transaction으로 남긴다. */
export async function insertAgentMessage(
  db: Database,
  runId: string,
  body: string,
  options: { source: RecordSource; activity: PublicActivity }
): Promise<{ message: ConversationMessage; events: Event[] } | undefined> {
  return db.transaction(async (tx) => {
    const run = await lockRunningRun(tx, runId, "share");
    if (!run) return undefined;
    const plan = planAgentMessage(run, body, options.source);
    await tx.insert(messages).values(messageRow(plan.message));
    const created = await insertEvent(tx, plan.event);
    const activity = await insertEvent(tx, {
      organizationId: run.organizationId,
      type: "run.activity",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        activity: options.activity,
      },
    });
    return { message: plan.message, events: [created, activity] };
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
  const wakeReasons = (await selectWakes(db, eq(wakes.runId, run.id))).map(
    (w) => w.reason
  );
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
      conversation: await selectConversation(
        db,
        run.organizationId,
        run.agentId,
        { upToRunSeq: run.seq, limit: 50 }
      ),
    },
  };
}

/** 조직 안의 메시지 하나. 다른 조직의 메시지와 없는 메시지를 구별하지 않는다. */
export async function findMessage(
  db: Database,
  organizationId: string,
  messageId: string
): Promise<ConversationMessage | undefined> {
  if (!isUuid(messageId)) return undefined;
  const [row] = await conversationQuery(db).where(
    and(eq(messages.organizationId, organizationId), eq(messages.id, messageId))
  );
  return row && toMessage(row);
}

// ---------- Surface 조회 ----------

/** 에이전트와 사용자의 대화. 오래된 것부터 최근 `limit`개. */
export async function listConversation(
  db: Database,
  organizationId: string,
  agentId: string,
  { limit = 200 }: { limit?: number } = {}
): Promise<ConversationMessage[]> {
  return selectConversation(db, organizationId, agentId, { limit });
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
  const wakeReasons = (await selectWakes(db, eq(wakes.runId, runId))).map(
    (w) => w.reason
  );
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
    instructionsBundleVersion: instructionsBundleVersion(
      await selectInstructions(db, agentId)
    ),
    recentRuns: recent,
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

/** 깨우기와 그 사유. 사유는 깨우기가 가리키는 기록(메시지, 승인 결정)에서 읽는다. */
async function selectWakes(
  db: Executor,
  where: ReturnType<typeof and>
): Promise<PendingWake[]> {
  const rows = await db
    .select({
      wake: wakes,
      body: messages.body,
      decision: approvals.status,
      note: approvals.decisionNote,
    })
    .from(wakes)
    .leftJoin(messages, eq(messages.id, wakes.messageId))
    .leftJoin(approvals, eq(approvals.id, wakes.approvalId))
    .where(where)
    .orderBy(asc(wakes.seq));
  return rows.map(({ wake, body, decision, note }) => ({
    id: wake.id,
    organizationId: wake.organizationId,
    agentId: wake.agentId,
    createdAt: wake.createdAt.toISOString(),
    reason:
      wake.kind === "owner_message"
        ? {
            kind: wake.kind,
            wakeId: wake.id,
            messageId: wake.messageId!,
            body: body ?? "",
          }
        : {
            kind: wake.kind,
            wakeId: wake.id,
            approvalId: wake.approvalId!,
            decision: decisionOfStatus(decision!),
            note,
          },
  }));
}

const sentBy = alias(runs, "sent_by");
const deliveredTo = alias(runs, "delivered_to");

const conversationQuery = (db: Executor) =>
  db
    .select({ message: messages, deliveredToRunId: wakes.runId })
    .from(messages)
    .leftJoin(wakes, eq(wakes.messageId, messages.id))
    .leftJoin(sentBy, eq(sentBy.id, messages.sentByRunId))
    .leftJoin(deliveredTo, eq(deliveredTo.id, wakes.runId))
    .$dynamic();

async function selectConversation(
  db: Executor,
  organizationId: string,
  agentId: string,
  { upToRunSeq, limit }: { upToRunSeq?: number; limit: number }
): Promise<ConversationMessage[]> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return [];
  const rows = await conversationQuery(db)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.agentId, agentId),
        upToRunSeq === undefined
          ? undefined
          : or(lte(sentBy.seq, upToRunSeq), lte(deliveredTo.seq, upToRunSeq))
      )
    )
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse().map(toMessage);
}

const toMessage = ({
  message: { seq: _seq, createdAt, ...message },
  deliveredToRunId,
}: {
  message: typeof messages.$inferSelect;
  deliveredToRunId: string | null;
}): ConversationMessage => ({
  ...message,
  deliveredToRunId,
  createdAt: createdAt.toISOString(),
});

const messageRow = (m: ConversationMessage) => ({
  id: m.id,
  organizationId: m.organizationId,
  agentId: m.agentId,
  author: m.author,
  body: m.body,
  delivery: m.delivery,
  sentByRunId: m.sentByRunId,
  createdAt: new Date(m.createdAt),
});

const runSummaryColumns = {
  id: runs.id,
  organizationId: runs.organizationId,
  agentId: runs.agentId,
  status: runs.status,
  summary: runs.summary,
  error: runs.error,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  // drizzle은 select 안의 열을 테이블 없이 쓰므로 상관 subquery는 이름을 직접 밝힌다.
  wakeCount: sql<number>`(select count(*) from "wakes" where "wakes"."run_id" = "runs"."id")::int`,
};

const toRunSummary = (row: {
  id: string;
  organizationId: string;
  agentId: string;
  status: RunSummary["status"];
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
