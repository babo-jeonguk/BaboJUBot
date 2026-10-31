import type {
  AgentRole,
  Event,
  InstructionFile,
  PublicActivity,
  RunCancelReason,
  RunContextResponse,
  RunResult,
  WakeReason,
} from "@babojubot/contracts";
import {
  acceptsToolCalls,
  admitsProviderRun,
  admitsRuns,
  instructionsBundleVersion,
  planRunFinish,
  planRunInterruption,
  planRunStart,
  sessionTaskOfPending,
  type NewRun,
  runBlockingStages,
  type RecordSource,
} from "@babojubot/core";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  markDelivered,
  markRequeued,
  runConversations,
} from "./conversations.ts";
import { lockProviderSlot } from "./providers.ts";
import {
  findRunningRunId,
  notSteering,
  selectInstructions,
  selectRunWakes,
  selectWakes,
} from "./run-reads.ts";
import { readSession, writeBackSession } from "./sessions.ts";
import {
  hasPendingHeartbeat,
  insertEvent,
  lockAgent,
  lockRunningRun,
  toAgent,
  toOrganization,
  type Executor,
} from "./rows.ts";
import {
  agents,
  flowTemplates,
  organizations,
  runs,
  runWakes,
  wakes,
} from "./schema.ts";

// 실행 시도의 admission·종료·인증(토큰, 그 실행 시도의 활동·맥락). 대화와 그 메시지(받은 순서·쪽 커서·줄 세운 메시지)는
// conversations.ts가, 실행 시도·에이전트 화면 조회는 run-views.ts가 맡는다. admission은 실행 시도가 받은 깨우기를 대화 module에
// 한 번 알린다(`markDelivered`).

// ---------- 실행 시도 admission ----------

export type ClaimedRun = {
  run: NewRun;
  wakeReasons: WakeReason[];
  /** 지침 bundle 버전을 정한 사본 내용. admission 때 고정해 프로바이더에 그대로 넘긴다. */
  instructions: InstructionFile[];
  event: Event;
};

/**
 * 에이전트의 대기 중인 깨우기를 새 실행 시도 하나에 고정한다. 보통은 모두이고, `중단하고 보내기` 메시지가 기다리면
 * 그 메시지 깨우기만이다(core `bundleWakes`). 나머지는 대기한 채 그 실행 시도가 끝난 뒤의 실행 시도가 받는다. 에이전트 행을 잠근 뒤 실행 중인 실행 시도가
 * 있는지 다시 보므로 여러 호출자가 동시에 불러도 실행 시도는 하나만 생긴다(부분 unique가 마지막 방어선).
 * 실행 중이거나 대기 중인 깨우기가 없으면 아무것도 하지 않는다. 프로바이더는 commit 뒤에 부른다.
 * 지침 bundle 버전은 같은 transaction에서 읽은 그 에이전트의 사본 내용으로 정한다.
 *
 * 조직이 실행 시도를 받지 않는 단계(최종 완료·일시정지·중단, core `admitsRuns`)이거나 에이전트가 일시정지면
 * 깨우기를 남겨 두고 아무것도 하지 않는다. 취소를 요청받고 정리 중인 실행 시도도 실행 중이므로 끝날 때까지 다음 실행 시도는 없다.
 * 단계 검사는 조직 행 `FOR SHARE` 아래에서 하므로 단계 전이(`FOR NO KEY UPDATE`)와 직렬화된다. 전이가 먼저면 바뀐 단계를 보고,
 * admission이 먼저면 전이는 그 실행 시도가 생긴 뒤에 일어난다. 잠금 순서는 조직 → 에이전트다. 에이전트를 먼저 잠그면
 * 조직 행을 잠근 채 깨우기·Event의 FK로 에이전트 행(`KEY SHARE`)을 기다리는 쓰기와 교착한다.
 *
 * 에이전트의 프로바이더 연결에 자리가 없으면(진행 중 실행 시도가 동시 실행 상한 이상, core `admitsProviderRun`) 깨우기를 남겨 두고
 * 아무것도 하지 않는다. 자리 확인은 연결의 상한 행 잠금(`lockProviderSlot`) 아래이므로 조직이 달라도 같은 연결의 admission은
 * 상한을 넘지 않는다. 잠금 순서는 조직 → 에이전트 → 연결 상한이다. 자리가 나면 dispatcher가 그 연결을 기다리는 에이전트를 다시 촉진한다.
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
      and(eq(wakes.agentId, agentId), isNull(wakes.runId), notSteering)
    );
    const sessionTaskId = sessionTaskOfPending(pendingWakes);
    const instructions = await selectInstructions(tx, agentId);
    const plan = planRunStart(
      {
        agent: toAgent(agent),
        pendingWakes,
        instructionsBundleVersion: instructionsBundleVersion(instructions),
        session: await readSession(tx, agentId, sessionTaskId),
        sessionGeneration: agent.sessionGeneration,
      },
      options.source
    );
    if (!plan) return undefined;
    if (!admitsProviderRun(await lockProviderSlot(tx, plan.run.provider)))
      return undefined;

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
    await markDelivered(tx, plan.run, ids);
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
 * 취소를 요청받은 실행 시도는 프로바이더의 결과와 상관없이 `cancelled`로 끝난다(core `planRunFinish`).
 * 다음 세션은 이 실행 시도의 세션 자리에 남긴다. 그사이 에이전트의 프로바이더가 바뀌었으면 남기지 않는다(`writeBackSession`).
 * 잠금 순서는 조직 → 에이전트 → 실행 시도이며, 에이전트 행 잠금이 프로바이더 변경과 직렬화한다.
 */
export async function finishRun(
  db: Database,
  runId: string,
  result: RunResult,
  source: Pick<RecordSource, "now">
): Promise<Event | undefined> {
  return db.transaction(async (tx) => {
    const agent = await lockRunAgent(tx, runId);
    if (!agent) return undefined;
    const [run] = await tx
      .select(finishingRunColumns)
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .for("update");
    if (!run) return undefined;
    const plan = planRunFinish(run, result, source);
    await tx
      .update(runs)
      .set({ ...plan.update, finishedAt: new Date(plan.update.finishedAt) })
      .where(eq(runs.id, runId));
    await writeBackSession(
      tx,
      run,
      agent.sessionGeneration,
      plan.update.sessionAfter
    );
    return insertEvent(tx, plan.event);
  });
}

const finishingRunColumns = {
  id: runs.id,
  organizationId: runs.organizationId,
  agentId: runs.agentId,
  cancelReason: runs.cancelReason,
  provider: runs.provider,
  instructionsBundleVersion: runs.instructionsBundleVersion,
  sessionBefore: runs.sessionBefore,
  sessionTaskId: runs.sessionTaskId,
  sessionGeneration: runs.sessionGeneration,
};

/**
 * 실행 시도의 조직 행(`FOR SHARE`)과 에이전트 행을 잠근다. 잠금 순서는 조직 → 에이전트 → 실행 시도다. 에이전트 행 잠금으로
 * heartbeat scheduler·admission·프로바이더 변경과 직렬화한다. 실행 시도가 없으면 `undefined`.
 */
async function lockRunAgent(tx: Executor, runId: string) {
  // 실행 시도의 조직·에이전트는 바뀌지 않는다. 잠그기 전에 읽어도 된다.
  const [owner] = await tx
    .select({ organizationId: runs.organizationId, agentId: runs.agentId })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!owner) return undefined;
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, owner.organizationId))
    .for("share");
  return lockAgent(tx, owner.organizationId, owner.agentId);
}

/**
 * 서버가 멈춰 프로바이더 결과 없이 끝나는 실행 시도를 끝낸다(core `planRunInterruption`). 종료·깨우기 복원·Event는 한 transaction이며,
 * 이미 끝난 실행 시도면 아무것도 바꾸지 않고 `undefined`다. 서버 시작의 복구와 서버 종료 때 취소로 돌아온 실행 시도가 쓴다.
 */
export async function interruptRun(
  db: Database,
  runId: string,
  source: Pick<RecordSource, "now">
): Promise<Event | undefined> {
  return db.transaction(async (tx) => {
    // 에이전트 행 잠금으로 heartbeat scheduler·admission과 직렬화해,
    // 대기 heartbeat를 확인한 뒤 새 heartbeat가 생겨 다시 대기시킨 heartbeat와 겹치지 않게 한다.
    const agent = await lockRunAgent(tx, runId);
    if (!agent) return undefined;
    const [run] = await tx
      .select(finishingRunColumns)
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
    await writeBackSession(
      tx,
      run,
      agent.sessionGeneration,
      plan.update.sessionAfter
    );
    if (plan.requeueWakeIds.length) {
      const requeued = await tx
        .update(wakes)
        .set({ runId: null })
        .where(
          and(inArray(wakes.id, plan.requeueWakeIds), eq(wakes.runId, runId))
        )
        .returning({ id: wakes.id });
      await markRequeued(
        tx,
        requeued.map((w) => w.id)
      );
    }
    return insertEvent(tx, plan.event);
  });
}

/**
 * 서버가 멈춰 실행 중으로 남은 실행 시도를 `server_restart`로 끝내고 그 깨우기를 다시 대기시킨다(`interruptRun`).
 * 실행 시도를 돌리는 서버 프로세스가 하나라는 전제다(docs/architecture.md 패키지 구성). worker를 나누면 프로세스별 소유 기록이 필요하다.
 * 서버 시작 때 프로바이더를 부르기 전에 한 번 부른다. 실행 시도마다 따로 저장하므로 중간에 실패해도 다시 부르면 남은 것만 끝낸다.
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
 * 실행 시도를 받는 조직에서 대기 중인 깨우기가 있는 에이전트. 서버 시작·조직 재개, 프로바이더 연결에 자리가 날 때(`provider`) 다시 깨운다.
 * 최종 완료·일시정지·중단 등 admission을 거부하는 조직과 일시정지한 에이전트의 깨우기는 남아 있어도 지금 처리할 것이 아니므로 빠진다.
 * 가장 오래 기다린 깨우기가 먼저인 에이전트부터다.
 */
export async function listAgentsWithPendingWakes(
  db: Database,
  {
    organizationId,
    provider,
  }: { organizationId?: string; provider?: string } = {}
): Promise<string[]> {
  const rows = await db
    .select({ agentId: wakes.agentId })
    .from(wakes)
    .innerJoin(organizations, eq(organizations.id, wakes.organizationId))
    .innerJoin(agents, eq(agents.id, wakes.agentId))
    .where(
      and(
        isNull(wakes.runId),
        notSteering,
        notInArray(organizations.stage, [...runBlockingStages]),
        eq(agents.paused, false),
        organizationId === undefined
          ? undefined
          : eq(wakes.organizationId, organizationId),
        provider === undefined ? undefined : eq(agents.provider, provider)
      )
    )
    .groupBy(wakes.agentId)
    .orderBy(sql`min(${wakes.seq})`);
  return rows.map((r) => r.agentId);
}

/** 실행 시도에 요청된 사용자 제어 취소. 프로바이더 등록 직후 다시 읽어, 등록 전에 commit된 취소를 놓치지 않는다. */
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
      organization: (({
        id,
        name,
        stage,
        goal,
        completionCriteria,
        approvalPolicy,
      }) => ({
        id,
        name,
        stage,
        goal,
        completionCriteria,
        approvalPolicy,
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
