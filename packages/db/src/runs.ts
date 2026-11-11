import type { OrgToolName } from "@babojubot/contracts";
import {
  hasRunningMaintenance,
  cancelSessionMaintenance,
} from "./compaction.ts";
import type {
  AgentRecoveryBlockReason,
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
  planRunEndBeforeModel,
  planRunInterruption,
  planRunStart,
  sessionTaskOfPending,
  type NewRun,
  type RunFinishPlan,
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
import {
  abandonRunIntents,
  insertIntentRecoveryWake,
  recoveryNotBlocked,
} from "./intents.ts";
import { readSession, writeBackSession } from "./sessions.ts";
import { refused, stored, type AfterCommit, type Stored } from "./stored.ts";
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
 *
 * 그 에이전트의 세션이 압축 중이면(세션이 달라도) 깨우기를 남겨 두고 아무것도 하지 않는다. 압축이 끝나면 `finishCompaction`의 결과로 다시 촉진한다.
 *
 * 실행 의도 복구가 막힌 에이전트(`recovery_state` `blocked`)도 깨우기를 남겨 두고 아무것도 하지 않는다. 새 메시지·heartbeat·서버 재시작은
 * 이 상태를 바꾸지 않고, 사용자의 복구 재시도(`recover` 제어 명령)만 바꾼다.
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
    // 실행 의도 복구가 막힌 에이전트는 사용자가 복구 재시도를 고를 때까지 실행 시도를 시작하지 않는다.
    if (!agent || agent.paused || agent.recoveryState === "blocked")
      return undefined;
    if (
      (await findRunningRunId(tx, agentId)) ||
      (await hasRunningMaintenance(tx, agentId))
    )
      return undefined;

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

    await cancelSessionMaintenance(tx, agentId, sessionTaskId);
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
 * 실행 시도 종료 저장의 결과. `ended`면 이번 저장이 종료를 확정했고, `already_ended`면 이미 끝난 실행 시도라 아무것도 바꾸지 않았다.
 * 어느 쪽이든 commit 뒤 할 일에 그 실행 시도가 admission에서 쓴 프로바이더 연결을 담아, commit 응답을 잃고 다시 저장해도
 * 그 연결의 자리를 기다리는 에이전트를 다시 촉진할 수 있다. Event는 종료를 확정한 저장에만 있다.
 */
export type RunEnding = "ended" | "already_ended";

/**
 * 종료 결과를 저장한다. 상태·사용량·다음 세션·Event를 한 transaction에 남기고 commit 뒤 할 일(Event 알리기·자리가 난 연결 촉진)을 돌려준다.
 * 이미 끝난 실행 시도면 아무것도 바꾸지 않고 Event 없이 자리 촉진만 돌려준다. 없는 실행 시도는 `not_found`다.
 * 취소를 요청받은 실행 시도는 프로바이더의 결과와 상관없이 `cancelled`로 끝난다(core `planRunFinish`).
 * 다음 세션은 이 실행 시도의 세션 자리에 남긴다. 그사이 에이전트의 프로바이더가 바뀌었으면 남기지 않는다(`writeBackSession`).
 * 그 실행 시도가 수락했거나 복구로 정산하려던 실행 의도 가운데 아직 수행하지 않은 것은 버린다(intents.ts `abandonRunIntents`).
 * 잠금 순서는 조직 → 에이전트 → 실행 시도이며, 에이전트 행 잠금이 프로바이더 변경과 직렬화한다.
 */
export async function finishRun(
  db: Database,
  runId: string,
  result: RunResult,
  source: Pick<RecordSource, "now">
): Promise<Stored<RunEnding, "not_found">> {
  return db.transaction(async (tx) => {
    const locked = await lockEndingRun(tx, runId);
    if (locked === "not_found") return refused(locked);
    const { agent, run } = locked;
    if (run.status !== "running") return alreadyEnded(run);
    const plan = planRunFinish(run, result, source);
    await closeRun(
      tx,
      agent,
      run,
      plan,
      result.stopReason === "completed" && result.sessionMaintenance
        ? { ...result.sessionMaintenance, tools: run.toolCatalog ?? [] }
        : null
    );
    await abandonRunIntents(tx, runId);
    return stored<RunEnding>("ended", {
      events: [await insertEvent(tx, plan.event)],
      providersFreed: [run.provider],
    });
  });
}

/** 잠근 실행 시도의 종료 상태를 저장하고 다음 세션을 그 세션 자리에 남긴다(`writeBackSession`). */
async function closeRun(
  tx: Executor,
  agent: { sessionGeneration: number },
  run: Parameters<typeof writeBackSession>[1],
  plan: Pick<RunFinishPlan, "update">,
  maintenance: Parameters<typeof writeBackSession>[4] = null
) {
  await tx
    .update(runs)
    .set({ ...plan.update, finishedAt: new Date(plan.update.finishedAt) })
    .where(eq(runs.id, run.id));
  await writeBackSession(
    tx,
    run,
    agent.sessionGeneration,
    plan.update.sessionAfter,
    maintenance
  );
}

/** 이미 끝난 실행 시도: 아무것도 다시 남기지 않고, 그 실행 시도가 쓴 연결의 자리 촉진만 돌려준다. */
const alreadyEnded = (run: { provider: string }) =>
  stored<RunEnding>("already_ended", {
    events: [],
    providersFreed: [run.provider],
  });

/** 종료할 실행 시도와 그 에이전트를 잠근다. 실행 시도 행은 상태와 상관없이 잠가, 이미 끝났는지 같은 잠금 안에서 본다. */
async function lockEndingRun(tx: Executor, runId: string) {
  const agent = await lockRunAgent(tx, runId);
  if (!agent) return "not_found" as const;
  const [run] = await tx
    .select({ ...finishingRunColumns, status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");
  if (!run) return "not_found" as const;
  return { agent, run };
}

const finishingRunColumns = {
  toolCatalog: runs.toolCatalog,
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
 * commit 뒤 할 일은 Event 알리기, 깨우기를 되돌려 받은 에이전트와 자리가 난 연결의 촉진이다.
 * 이미 끝난 실행 시도면 `finishRun`처럼 아무것도 바꾸지 않고 자리 촉진만 돌려준다. 서버 시작의 복구와 서버 종료 때 취소로 돌아온 실행 시도가 쓴다.
 * `server_restart`로 끝나면 그 실행 시도가 수락한 실행 의도를 알릴 복구 깨우기도 같은 transaction에 남긴다(intents.ts `insertIntentRecoveryWake`).
 */
export async function interruptRun(
  db: Database,
  runId: string,
  source: Pick<RecordSource, "now">
): Promise<Stored<RunEnding, "not_found">> {
  return db.transaction(async (tx) => {
    // 에이전트 행 잠금으로 heartbeat scheduler·admission과 직렬화해,
    // 대기 heartbeat를 확인한 뒤 새 heartbeat가 생겨 다시 대기시킨 heartbeat와 겹치지 않게 한다.
    const locked = await lockEndingRun(tx, runId);
    if (locked === "not_found") return refused(locked);
    const { agent, run } = locked;
    if (run.status !== "running") return alreadyEnded(run);
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
    await closeRun(tx, agent, run, plan);
    const requeued = await requeueWakes(tx, runId, plan.requeueWakeIds);
    // 사용자 제어가 취소한 실행 시도의 수행하지 않은 의도는 버리고, 서버 재시작으로 끝나면 다음 실행 시도가 정산·전달하도록 알린다.
    const recovering = run.cancelReason
      ? (await abandonRunIntents(tx, runId), false)
      : await insertIntentRecoveryWake(
          tx,
          run,
          new Date(plan.update.finishedAt)
        );
    return stored<RunEnding>("ended", {
      events: [await insertEvent(tx, plan.event)],
      woken: requeued.length || recovering ? [run.agentId] : [],
      providersFreed: [run.provider],
    });
  });
}

/** 실행 시도에 묶인 깨우기를 다시 대기시키고 그 사용자 메시지를 줄 세운 메시지로 돌린다. 다시 대기한 깨우기를 돌려준다. */
async function requeueWakes(tx: Executor, runId: string, wakeIds: string[]) {
  if (!wakeIds.length) return [];
  const requeued = await tx
    .update(wakes)
    .set({ runId: null })
    .where(and(inArray(wakes.id, wakeIds), eq(wakes.runId, runId)))
    .returning({ id: wakes.id });
  await markRequeued(
    tx,
    requeued.map((w) => w.id)
  );
  return requeued;
}

/**
 * 모델(프로바이더)을 부르기 전, 실행 의도 복구 정산 단계에서 실행 시도를 끝낸다(core `planRunEndBeforeModel`). 정산이 막혔으면
 * 받은 깨우기를 모두 다시 대기시키고 에이전트를 `blocked`로 두어 사용자가 복구 재시도를 고를 때까지 admission을 막는다.
 * 사용자 제어가 취소했으면 취소로 끝나되 복구 깨우기만 다시 대기시키고, 그 깨우기가 가리키는 수행하지 않은 의도는 버리지 않는다.
 * 종료·깨우기 복원·복구 상태·Event는 한 transaction이다. 이미 끝난 실행 시도는 바꾸지 않는다.
 */
export async function endRunBeforeModel(
  db: Database,
  runId: string,
  ending: { blocked: AgentRecoveryBlockReason } | "cancelled",
  source: Pick<RecordSource, "now">
): Promise<Stored<RunEnding, "not_found">> {
  return db.transaction(async (tx) => {
    const locked = await lockEndingRun(tx, runId);
    if (locked === "not_found") return refused(locked);
    const { agent, run } = locked;
    if (run.status !== "running") return alreadyEnded(run);
    const held = await tx
      .select({ id: wakes.id, kind: wakes.kind })
      .from(wakes)
      .where(eq(wakes.runId, runId))
      .orderBy(asc(wakes.seq));
    const plan = planRunEndBeforeModel(run, ending, { wakes: held }, source);
    await closeRun(tx, agent, run, plan);
    const requeued = await requeueWakes(tx, runId, plan.requeueWakeIds);
    const events = [await insertEvent(tx, plan.event)];
    if (plan.block) {
      await tx
        .update(agents)
        .set({
          recoveryState: "blocked",
          recoveryReason: plan.block,
          recoverySince: new Date(plan.update.finishedAt),
        })
        .where(eq(agents.id, run.agentId));
      events.push(
        await insertEvent(tx, {
          organizationId: run.organizationId,
          type: "agent.recovery_blocked",
          payload: { agentId: run.agentId, runId, reason: plan.block },
        })
      );
    }
    return stored<RunEnding>("ended", {
      events,
      woken: requeued.length && !plan.block ? [run.agentId] : [],
      providersFreed: [run.provider],
    });
  });
}

/**
 * 서버가 멈춰 실행 중으로 남은 실행 시도를 `server_restart`로 끝내고 그 깨우기를 다시 대기시킨다(`interruptRun`).
 * 실행 시도를 돌리는 서버 프로세스가 하나라는 전제다(docs/architecture.md 패키지 구성). worker를 나누면 프로세스별 소유 기록이 필요하다.
 * 서버 시작 때 프로바이더를 부르기 전에 한 번 부른다. 실행 시도마다 따로 저장하므로 중간에 실패하면 이미 끝낸 것은 남고, 다시 부르면 남은 것만 끝낸다.
 * commit 뒤 할 일은 적용하지 않고 모아서, 모든 저장이 성공했을 때만 돌려준다. 호출자는 그 뒤에 적용해야 복구가 끝나기 전에 실행 시도가 시작되지 않는다.
 */
export async function recoverInterruptedRuns(
  db: Database,
  source: Pick<RecordSource, "now">
): Promise<AfterCommit> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.status, "running"))
    .orderBy(asc(runs.seq));
  const events: Event[] = [];
  const woken = new Set<string>();
  const providersFreed = new Set<string>();
  for (const { id } of rows) {
    const ended = await interruptRun(db, id, source);
    // 조회 뒤 다른 쪽이 먼저 끝낸 실행 시도는 이미 그쪽이 알렸다.
    if (ended.kind !== "ok" || ended.value !== "ended") continue;
    events.push(...ended.after.events);
    for (const agentId of ended.after.woken ?? []) woken.add(agentId);
    for (const provider of ended.after.providersFreed ?? [])
      providersFreed.add(provider);
  }
  return {
    events,
    woken: [...woken],
    providersFreed: [...providersFreed],
  };
}

/**
 * 실행 시도를 받는 조직에서 대기 중인 깨우기가 있는 에이전트. 서버 시작·조직 재개, 프로바이더 연결에 자리가 날 때(`provider`) 다시 깨운다.
 * 최종 완료·일시정지·중단 등 admission을 거부하는 조직과 일시정지한 에이전트, 실행 의도 복구가 막힌 에이전트의 깨우기는
 * 남아 있어도 지금 처리할 것이 아니므로 빠진다.
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
        recoveryNotBlocked,
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

/** 실행 시도가 아직 조직 도구를 쓸 수 있으면(실행 중이고 취소를 요청받지 않음, core `acceptsToolCalls`) 그 신원. 그 밖이면 `undefined`. */
export async function findActiveRun(
  db: Database,
  runId: string
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
    .where(eq(runs.id, runId));
  if (!row || !acceptsToolCalls(row)) return undefined;
  const { status: _status, cancelReason: _cancel, ...run } = row;
  return run;
}

/** 실행 시도가 받은 깨우기의 지금 사유. 복구 정산 뒤 실행 의도의 결과를 다시 읽을 때 쓴다. */
export async function loadRunWakeReasons(
  db: Database,
  runId: string
): Promise<WakeReason[]> {
  return (await selectRunWakes(db, runId)).map((w) => w.reason);
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

/** Last catalog actually served to this run; retained with its maintenance metadata at settlement. */
export async function recordRunToolCatalog(
  db: Database,
  runId: string,
  tools: OrgToolName[]
) {
  await db
    .update(runs)
    .set({ toolCatalog: tools })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")));
}
