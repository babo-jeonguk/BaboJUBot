import { randomUUID } from "node:crypto";
import {
  intentRequestSchema,
  type AgentRecoveryBlockReason,
  type IntentOutcome,
  type IntentRequest,
  type OrgToolName,
  type RecoveredIntent,
} from "@babojubot/contracts";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  lockOrganization,
  lockRunningRun,
  violatesUnique,
  type Executor,
} from "./rows.ts";
import {
  agents,
  organizations,
  runs,
  toolOperations,
  wakes,
} from "./schema.ts";
import type { AfterCommit } from "./stored.ts";

// 실행 의도(GLOSSARY)의 수락·조회·버림과 서버 재시작 뒤의 복구 깨우기. 효과와 최초 결과의 정산은 도구 쓰기 틀(tool-calls.ts `toolWrite`)이
// 효과와 같은 transaction에서 하고, 복구 정산을 언제 하는지는 dispatcher가 정한다(모델을 부르기 전).

/** 저장한 실행 의도. `request`는 수락 때 고정한 입력의 JSON 표기 그대로다(이 기능 전의 기록은 없음). */
export type StoredIntent = {
  id: string;
  organizationId: string;
  agentId: string;
  key: string | null;
  tool: string;
  digest: string;
  request: string | null;
  source: unknown;
  status: "accepted" | "completed" | "refused" | "abandoned";
  result: unknown;
  refusal: string | null;
  runId: string;
};

const intentColumns = {
  id: toolOperations.id,
  organizationId: toolOperations.organizationId,
  agentId: toolOperations.agentId,
  key: toolOperations.key,
  tool: toolOperations.tool,
  digest: toolOperations.requestDigest,
  request: toolOperations.request,
  source: toolOperations.source,
  status: toolOperations.status,
  result: toolOperations.result,
  refusal: toolOperations.refusal,
  runId: toolOperations.runId,
};

/** 에이전트가 같은 호출 키로 남긴 실행 의도. 키는 에이전트마다 따로라 다른 에이전트·조직의 같은 키는 보지 않는다. */
export async function findIntentByKey(
  db: Executor,
  agentId: string,
  key: string
): Promise<StoredIntent | undefined> {
  const [row] = await db
    .select(intentColumns)
    .from(toolOperations)
    .where(
      and(eq(toolOperations.agentId, agentId), eq(toolOperations.key, key))
    );
  return row;
}

/** 실행 의도 하나. 정산할 실행 시도가 같은 조직·에이전트인지는 호출자가 확인한다. */
export async function findIntent(
  db: Executor,
  intentId: string
): Promise<StoredIntent | undefined> {
  const [row] = await db
    .select(intentColumns)
    .from(toolOperations)
    .where(eq(toolOperations.id, intentId));
  return row;
}

/** 수락할 실행 의도: 도구, 고정한 입력(JSON 표기)과 그 digest, 원본 자료, 있으면 같은 호출 키. */
export type IntentDraft = {
  key: string | null;
  tool: OrgToolName;
  request: string;
  digest: string;
  source: unknown;
};

/**
 * 실행 의도를 수락한다: 도구·입력·원본 자료를 고정해 `accepted`로 남긴다. 효과는 이 commit 뒤에만 한다.
 * 조직 행 → 실행 시도 행 순서로 잠가(도구 쓰기와 같은 순서) 실행 시도가 아직 도구를 쓸 수 있을 때만 남긴다.
 * 같은 에이전트의 같은 키가 이미 있으면(동시에 온 같은 호출) 새로 남기지 않고 그 의도를 돌려준다.
 */
export async function acceptIntent(
  db: Database,
  run: { id: string },
  draft: IntentDraft
): Promise<
  | { kind: "accepted"; intent: StoredIntent }
  | { kind: "existing"; intent: StoredIntent }
  | { kind: "run_finished" }
> {
  try {
    return await db.transaction(async (tx) => {
      const [owner] = await tx
        .select({ organizationId: runs.organizationId })
        .from(runs)
        .where(eq(runs.id, run.id));
      if (!owner) return { kind: "run_finished" as const };
      await lockOrganization(tx, owner.organizationId);
      const locked = await lockRunningRun(tx, run.id);
      if (!locked) return { kind: "run_finished" as const };
      if (draft.key !== null) {
        const existing = await findIntentByKey(tx, locked.agentId, draft.key);
        if (existing) return { kind: "existing" as const, intent: existing };
      }
      const [row] = await tx
        .insert(toolOperations)
        .values({
          organizationId: locked.organizationId,
          agentId: locked.agentId,
          key: draft.key,
          tool: draft.tool,
          requestDigest: draft.digest,
          request: draft.request,
          source: draft.source ?? null,
          status: "accepted",
          runId: locked.id,
        })
        .returning(intentColumns);
      return { kind: "accepted" as const, intent: row! };
    });
  } catch (error) {
    // 같은 키를 다른 요청이 먼저 남겼다. 그 의도를 쓴다.
    if (
      draft.key !== null &&
      violatesUnique(error, "tool_operations_agent_id_key_unique")
    ) {
      const [row] = await db
        .select({ agentId: runs.agentId })
        .from(runs)
        .where(eq(runs.id, run.id));
      const existing =
        row && (await findIntentByKey(db, row.agentId, draft.key));
      if (existing) return { kind: "existing", intent: existing };
    }
    throw error;
  }
}

/**
 * 잠근 실행 의도를 정산한다. 도구 쓰기 틀이 효과와 같은 transaction에서 부른다. 정산한 의도는 원본 자료를 비운다.
 */
export async function settleIntent(
  tx: Executor,
  intentId: string,
  settledRunId: string,
  outcome:
    | { status: "completed"; result: unknown }
    | { status: "refused"; refusal: string }
) {
  await tx
    .update(toolOperations)
    .set({
      status: outcome.status,
      result: outcome.status === "completed" ? outcome.result : null,
      refusal: outcome.status === "refused" ? outcome.refusal : null,
      source: null,
      settledRunId,
    })
    .where(
      and(
        eq(toolOperations.id, intentId),
        eq(toolOperations.status, "accepted")
      )
    );
}

/** 정산하려고 잠근 실행 의도. 같은 의도의 동시 정산은 이 잠금으로 직렬화되고 뒤의 쪽은 앞의 결과를 본다. */
export async function lockIntent(
  tx: Executor,
  intentId: string
): Promise<StoredIntent | undefined> {
  const [row] = await tx
    .select(intentColumns)
    .from(toolOperations)
    .where(eq(toolOperations.id, intentId))
    .for("update");
  return row;
}

/** 깨우기 사유에 싣는 정산 상태. */
export const intentOutcomeOf = (intent: {
  status: StoredIntent["status"];
  result: unknown;
  refusal: string | null;
}): IntentOutcome => {
  switch (intent.status) {
    case "accepted":
      return { status: "pending" };
    case "completed":
      return { status: "completed", result: intent.result };
    case "refused":
      return { status: "refused", reason: intent.refusal! };
    case "abandoned":
      return { status: "cancelled" };
  }
};

/**
 * 저장한 입력 표기를 읽는다. 기록이 없거나(이 기능 전 판) 읽을 수 없거나 형식이 맞지 않으면 `null`이며 던지지 않는다.
 * 빈 입력으로 대신하지 않는다. 수행할 의도에서 `null`은 기록 모순이다(`listIntentsToSettle`).
 */
export const decodeIntentRequest = (
  request: string | null
): IntentRequest | null => {
  if (request === null) return null;
  try {
    const parsed = intentRequestSchema.safeParse(JSON.parse(request));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** 실행 시도가 받은 복구 깨우기가 가리키는, 서버 재시작으로 끝난 실행 시도들(subquery). */
const recoveredRunsOf = (db: Executor, runId: string) =>
  db
    .select({ id: wakes.interruptedRunId })
    .from(wakes)
    .where(
      and(
        eq(wakes.runId, runId),
        eq(wakes.kind, "intent_recovery"),
        isNotNull(wakes.interruptedRunId)
      )
    );

/**
 * 실행 시도가 수락했거나 그 실행 시도가 복구로 정산하려던 실행 의도 가운데 아직 수행하지 않은 것을 버린다(`abandoned`).
 * 프로바이더가 결과를 돌려주거나 사용자 제어가 취소해 끝난 실행 시도에 쓴다. 수락한 의도가 남았다면 효과는 commit되지 않았고
 * 그 호출은 오류 응답을 받았거나(실행 시도가 먼저 끝남) 사용자가 그 입력을 취소한 것이므로 되살리지 않는다.
 */
export async function abandonRunIntents(tx: Executor, runId: string) {
  await tx
    .update(toolOperations)
    .set({ status: "abandoned", source: null, settledRunId: runId })
    .where(
      and(
        eq(toolOperations.status, "accepted"),
        or(
          eq(toolOperations.runId, runId),
          inArray(toolOperations.runId, recoveredRunsOf(tx, runId))
        )
      )
    );
}

/**
 * 서버 재시작으로 끝나는 실행 시도가 수락한 실행 의도가 있으면 그 결과를 알릴 복구 깨우기를 남긴다(이미 있으면 그대로).
 * 정산 여부와 상관없이 모두 알린다. 프로바이더 세션은 그 실행 시도 전으로 돌아가므로 이미 받은 결과도 모델은 잃었다.
 * 수행하지 않은 의도는 이 깨우기를 받은 실행 시도가 모델을 부르기 전에 정산한다. 남겼으면 `true`.
 */
export async function insertIntentRecoveryWake(
  tx: Executor,
  run: { id: string; organizationId: string; agentId: string },
  now: Date
): Promise<boolean> {
  const [accepted] = await tx
    .select({ id: toolOperations.id })
    .from(toolOperations)
    .where(eq(toolOperations.runId, run.id))
    .limit(1);
  if (!accepted) return false;
  const inserted = await tx
    .insert(wakes)
    .values({
      id: randomUUID(),
      organizationId: run.organizationId,
      agentId: run.agentId,
      kind: "intent_recovery",
      interruptedRunId: run.id,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: wakes.id });
  return inserted.length > 0;
}

/** 복구 깨우기가 알릴 실행 의도와 끝난 실행 시도의 세션 자리. 깨우기 사유를 만들 때 쓴다. */
export async function selectRecoveredIntents(
  db: Executor,
  interruptedRunIds: string[]
): Promise<Map<string, { taskId: string | null; intents: RecoveredIntent[] }>> {
  const found = new Map<
    string,
    { taskId: string | null; intents: RecoveredIntent[] }
  >();
  if (!interruptedRunIds.length) return found;
  for (const run of await db
    .select({ id: runs.id, taskId: runs.sessionTaskId })
    .from(runs)
    .where(inArray(runs.id, interruptedRunIds)))
    found.set(run.id, { taskId: run.taskId, intents: [] });
  const rows = await db
    .select(intentColumns)
    .from(toolOperations)
    .where(inArray(toolOperations.runId, interruptedRunIds))
    .orderBy(asc(toolOperations.createdAt), asc(toolOperations.id));
  for (const row of rows)
    found.get(row.runId)?.intents.push({
      intentId: row.id,
      tool: row.tool,
      request: decodeIntentRequest(row.request),
      outcome: intentOutcomeOf(row),
    });
  return found;
}

/**
 * 실행 시도가 받은 복구 깨우기가 가리키는, 아직 수행하지 않은 실행 의도. 모델을 부르기 전에 정산할 목록이다.
 * `recovered`는 그 깨우기가 가리키는 실행 시도의 모든 의도(정산 여부와 상관없음)로, 복구 전달 시도를 셀 때 쓴다.
 * 다른 에이전트의 의도가 섞였거나 고정한 입력이 없거나 읽을 수 없으면 기록 모순으로 본다.
 */
export async function listIntentsToSettle(
  db: Executor,
  run: { id: string; organizationId: string; agentId: string }
): Promise<
  | { kind: "ok"; intents: StoredIntent[]; recovered: string[] }
  | { kind: "blocked"; reason: AgentRecoveryBlockReason }
> {
  const recovered = await db
    .select({ id: toolOperations.id })
    .from(toolOperations)
    .where(inArray(toolOperations.runId, recoveredRunsOf(db, run.id)));
  const rows = await db
    .select(intentColumns)
    .from(toolOperations)
    .where(
      and(
        eq(toolOperations.status, "accepted"),
        inArray(toolOperations.runId, recoveredRunsOf(db, run.id))
      )
    )
    .orderBy(asc(toolOperations.createdAt), asc(toolOperations.id));
  for (const row of rows)
    if (
      row.organizationId !== run.organizationId ||
      row.agentId !== run.agentId ||
      decodeIntentRequest(row.request) === null
    )
      return { kind: "blocked", reason: "inconsistent_record" };
  return {
    kind: "ok",
    intents: rows,
    recovered: recovered.map((r) => r.id),
  };
}

/** 서버 재시작을 넘어 세는 복구 전달 시도의 한도. 닿으면 복구 멈춤이다. */
export const intentSettleAttemptLimit = 3;

/**
 * 복구가 전달하려는 실행 의도들의 복구 전달 시도를 하나 센다. 정산 여부와 상관없이 그 복구가 나르는 모든 의도를 센다.
 * 이미 한도에 닿은 의도가 있으면 세지 않고 `false`다(호출자가 멈춘다).
 * 서버가 복구 도중 멈춰도 센 값은 남으므로 재시작이 한도를 되돌리지 않는다.
 */
export async function countSettleAttempt(
  db: Database,
  intentIds: string[]
): Promise<boolean> {
  if (!intentIds.length) return true;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ attempts: toolOperations.settleAttempts })
      .from(toolOperations)
      .where(inArray(toolOperations.id, intentIds))
      .for("update");
    if (rows.some((r) => r.attempts >= intentSettleAttemptLimit)) return false;
    await tx
      .update(toolOperations)
      .set({ settleAttempts: sql`${toolOperations.settleAttempts} + 1` })
      .where(inArray(toolOperations.id, intentIds));
    return true;
  });
}

/** 사용자의 복구 재시도: 그 에이전트의 모든 의도의 복구 전달 시도 횟수를 되돌린다. */
export async function resetSettleAttempts(tx: Executor, agentId: string) {
  await tx
    .update(toolOperations)
    .set({ settleAttempts: 0 })
    .where(eq(toolOperations.agentId, agentId));
}

/**
 * 사용자가 고른 복구 재시도의 정산이 성공했다: 에이전트가 `retrying`이면 막힘을 풀고 Event를 남긴다. 그 밖에는 아무것도 하지 않는다.
 */
export async function resolveAgentRecovery(
  db: Database,
  run: { id: string; organizationId: string; agentId: string }
): Promise<AfterCommit> {
  return db.transaction(async (tx) => {
    // 잠금 순서는 어디서나 조직 → 에이전트다.
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, run.organizationId))
      .for("share");
    const cleared = await tx
      .update(agents)
      .set({ recoveryState: null, recoveryReason: null, recoverySince: null })
      .where(
        and(eq(agents.id, run.agentId), eq(agents.recoveryState, "retrying"))
      )
      .returning({ id: agents.id });
    if (!cleared.length) return { events: [] };
    return {
      events: [
        await insertEvent(tx, {
          organizationId: run.organizationId,
          type: "agent.recovery_resolved",
          payload: { agentId: run.agentId, runId: run.id },
        }),
      ],
    };
  });
}

/** 막힌 복구 상태. admission과 대기 깨우기 목록이 이 에이전트를 빼는 조건이다. */
export const recoveryNotBlocked = sql`${agents.recoveryState} is distinct from 'blocked'`;
