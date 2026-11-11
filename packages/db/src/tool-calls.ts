import type {
  AgentRole,
  Event,
  LifecycleStage,
  OrgToolName,
  PublicActivity,
  ToolRefusalReason,
} from "@babojubot/contracts";
import { checkToolCall, toolRefusedEvent } from "@babojubot/core";
import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  lockOrganization,
  lockRunningRun,
  type Executor,
} from "./rows.ts";
import {
  findIntentByKey,
  lockIntent,
  settleIntent,
  type StoredIntent,
} from "./intents.ts";
import { organizations, runs } from "./schema.ts";
import type { AfterCommit } from "./stored.ts";

// 조직 도구 호출의 공통 검사와 쓰기 틀. 모든 쓰기는 조직 행 → 실행 시도 행 순서로 잠그고(제어 명령의 취소 요청과 같은 순서),
// 잠금 아래에서 실행 시도가 아직 도구를 쓸 수 있는지와 Role·단계 규칙을 다시 확인한다. 같은 조직의 도구 쓰기는 조직 행 잠금으로 직렬화된다.

export type ActiveRunRef = { id: string; agentRole: AgentRole };
/** 잠근 실행 시도와 그 에이전트의 Role. 도구가 쓰는 기록의 조직·작성자·실행 시도는 여기서만 정한다. */
export type LockedRun = {
  id: string;
  organizationId: string;
  agentId: string;
  role: AgentRole;
};

/** 도구 검사 결과. 거부도 `tool.refused` Event를 남기므로 commit 뒤 할 일(그 Event 알리기)이 있다. */
export type GateResult =
  { ok: true } | { ok: false; reason: ToolRefusalReason; after: AfterCommit };

/** 지금 조직 단계로 Role·단계 규칙을 검사하고, 거부하면 그 실행 시도에 귀속한 `tool.refused` Event를 남긴다. */
async function checkOrRefuse(
  tx: Executor,
  locked: LockedRun,
  stage: LifecycleStage,
  tool: OrgToolName
): Promise<GateResult> {
  const check = checkToolCall(tool, { role: locked.role, stage });
  if (check.ok) return check;
  const event = await insertEvent(
    tx,
    toolRefusedEvent(locked, tool, stage, check.reason)
  );
  return { ...check, after: { events: [event] } };
}

const lockRun = async (tx: Executor, run: ActiveRunRef) => {
  const locked = await lockRunningRun(tx, run.id);
  return locked && { ...locked, role: run.agentRole };
};

/**
 * 조직 도구 호출 전의 Role·단계 검사. 거부하면 그 실행 시도에 귀속한 `tool.refused` Event를 남긴다.
 * 실행 시도가 이미 끝났으면 `undefined`. 쓰기 도구는 저장할 때 잠금 아래에서 다시 검사한다.
 * 쓰기 호출의 같은 호출 키에 이미 실행 의도가 있으면(동시에 온 같은 호출이 먼저 수락함) 거부하지 않는다. 그 호출은 새 쓰기가
 * 아니라 그 의도의 결과 조회다. 거부 판정 뒤 같은 transaction에서 다시 보므로, 처음 조회와 이 검사 사이에 그 의도가 정산되고 단계가 바뀌어도
 * 최초 결과를 받는다.
 */
export async function gateToolCall(
  db: Database,
  run: ActiveRunRef,
  tool: OrgToolName,
  key: string | null = null
): Promise<GateResult | undefined> {
  return db.transaction(async (tx) => {
    const locked = await lockRun(tx, run);
    if (!locked) return undefined;
    const [org] = await tx
      .select({ stage: organizations.stage })
      .from(organizations)
      .where(eq(organizations.id, locked.organizationId));
    const check = checkToolCall(tool, {
      role: locked.role,
      stage: org!.stage,
    });
    // 같은 호출 키의 의도가 이미 있으면 이 호출은 그 결과 조회다. 단계가 그 쓰기를 닫았어도 거부하지 않는다.
    if (!check.ok && key !== null) {
      const intent = await findIntentByKey(tx, locked.agentId, key);
      if (intent) return { ok: true };
    }
    return checkOrRefuse(tx, locked, org!.stage, tool);
  });
}

/**
 * 도구 쓰기의 결과. 저장한 결과(`ok`)와 규칙 거부(`refused`, `tool.refused` Event를 남김)는 commit 뒤 할 일을 담는다.
 * `invalid`는 도구마다 정한 입력·기록 규칙의 거부이며 아무것도 남기지 않는다. 같은 호출 키에 다른 도구·입력이 오면 `idempotency_conflict`,
 * 사용자 제어가 취소해 수행하지 않기로 한 실행 의도를 다시 보내면 `intent_cancelled`다.
 */
export type ToolWrite<T, P extends string> =
  | { kind: "ok"; value: T; after: AfterCommit }
  | { kind: "run_finished" }
  | { kind: "refused"; reason: ToolRefusalReason; after: AfterCommit }
  | {
      kind: "invalid";
      problem: P | "idempotency_conflict" | "intent_cancelled";
    };

/** 이 쓰기가 정산할 실행 의도(intents.ts `acceptIntent`로 수락한 것). */
export type IntentRef = { intentId: string };

/** 조직 도구 쓰기 호출 하나: 남길 공개 활동 요약과, 있으면 정산할 실행 의도. */
export type ToolCall = { activity: PublicActivity; operation?: IntentRef };

/** 정산할 실행 의도가 그 실행 시도의 에이전트·도구와 맞지 않는다. 기록 모순이며 효과를 남기지 않는다. */
export class IntentMismatchError extends Error {
  constructor(intentId: string) {
    super(`execution intent ${intentId} does not belong to this call`);
  }
}

/** 이미 정산한 실행 의도의 최초 결과. 새 기록·Event·깨우기는 없다. 아직 수행하지 않았으면 `undefined`. */
export function replayIntent<T, P extends string>(
  intent: Pick<StoredIntent, "status" | "result" | "refusal">
): ToolWrite<T, P> | undefined {
  switch (intent.status) {
    case "accepted":
      return undefined;
    case "completed":
      return { kind: "ok", value: intent.result as T, after: { events: [] } };
    case "refused":
      return intent.refusal === "role" || intent.refusal === "stage"
        ? { kind: "refused", reason: intent.refusal, after: { events: [] } }
        : { kind: "invalid", problem: intent.refusal as P };
    case "abandoned":
      return { kind: "invalid", problem: "intent_cancelled" };
  }
}

/**
 * 조직 도구 쓰기의 공통 틀: 조직 행과 실행 시도 행을 잠그고, 실행 시도가 끝나거나 취소를 요청받지 않았는지와 단계 규칙을 다시 확인한 뒤 쓴다.
 * 실행 시도 행을 먼저 잠그면 조직 행을 잠근 채 실행 시도에 취소를 요청하는 제어 명령과 교착한다.
 *
 * 실행 의도(`call.operation`)를 주면 그 의도를 잠그고 정산한다. 이미 정산했으면(같은 의도의 동시 호출이 먼저 끝남) 그 최초 결과를
 * 돌려주고 아무것도 다시 남기지 않는다. 아직이면 지금 Role·단계 규칙을 검사해 거부는 효과 없는 확정 거절로, 효과는 최초 결과와
 * 함께 정산한다. 효과와 정산은 같은 transaction이므로 효과가 commit되었으면 결과도 있다. 서버 재시작 뒤의 복구는 새 실행 시도가
 * 같은 의도를 이 틀로 정산하므로, 지금 단계에서 막힌 쓰기는 거절로 정산된다. 실행 시도가 먼저 끝났으면 의도는 수락한 채로 남는다.
 */
export async function toolWrite<T, P extends string>(
  db: Database,
  run: ActiveRunRef,
  tool: OrgToolName,
  { activity, operation }: ToolCall,
  write: (
    tx: Executor,
    locked: LockedRun,
    org: typeof organizations.$inferSelect
  ) => Promise<
    | { kind: "ok"; value: T; events: Event[]; woken?: string[] }
    | { kind: "invalid"; problem: P }
  >
): Promise<ToolWrite<T, P>> {
  return db.transaction(async (tx) => {
    // 실행 시도의 조직은 바뀌지 않는다. 잠그기 전에 읽어도 된다.
    const [owner] = await tx
      .select({ organizationId: runs.organizationId })
      .from(runs)
      .where(eq(runs.id, run.id));
    if (!owner) return { kind: "run_finished" };
    const org = (await lockOrganization(tx, owner.organizationId))!;
    const locked = await lockRun(tx, run);
    if (!locked) return { kind: "run_finished" };
    if (operation) {
      const intent = await lockIntent(tx, operation.intentId);
      if (
        !intent ||
        intent.organizationId !== locked.organizationId ||
        intent.agentId !== locked.agentId ||
        intent.tool !== tool
      )
        throw new IntentMismatchError(operation.intentId);
      const replay = replayIntent<T, P>(intent);
      if (replay) return replay;
    }
    const gate = await checkOrRefuse(tx, locked, org.stage, tool);
    if (!gate.ok) {
      if (operation)
        await settleIntent(tx, operation.intentId, locked.id, {
          status: "refused",
          refusal: gate.reason,
        });
      return { kind: "refused", reason: gate.reason, after: gate.after };
    }
    const result = await write(tx, locked, org);
    if (result.kind === "invalid") {
      if (operation)
        await settleIntent(tx, operation.intentId, locked.id, {
          status: "refused",
          refusal: result.problem,
        });
      return result;
    }
    if (operation)
      await settleIntent(tx, operation.intentId, locked.id, {
        status: "completed",
        result: result.value,
      });
    const summary = await insertEvent(tx, {
      organizationId: locked.organizationId,
      type: "run.activity",
      payload: { runId: locked.id, agentId: locked.agentId, activity },
    });
    return {
      kind: "ok",
      value: result.value,
      after: { events: [...result.events, summary], woken: result.woken },
    };
  });
}
