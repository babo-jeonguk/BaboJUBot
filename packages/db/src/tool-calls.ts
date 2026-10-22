import type {
  AgentRole,
  Event,
  LifecycleStage,
  OrgToolName,
  PublicActivity,
  ToolRefusalReason,
} from "@babojubot/contracts";
import { checkToolCall, toolRefusedEvent } from "@babojubot/core";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  lockOrganization,
  lockRunningRun,
  type Executor,
} from "./rows.ts";
import { organizations, runs, toolOperations } from "./schema.ts";

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

export type GateResult =
  { ok: true } | { ok: false; reason: ToolRefusalReason; event: Event };

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
  return { ...check, event };
}

const lockRun = async (tx: Executor, run: ActiveRunRef) => {
  const locked = await lockRunningRun(tx, run.id);
  return locked && { ...locked, role: run.agentRole };
};

/**
 * 조직 도구 호출 전의 Role·단계 검사. 거부하면 그 실행 시도에 귀속한 `tool.refused` Event를 남긴다.
 * 실행 시도가 이미 끝났으면 `undefined`. 쓰기 도구는 저장할 때 잠금 아래에서 다시 검사한다.
 */
export async function gateToolCall(
  db: Database,
  run: ActiveRunRef,
  tool: OrgToolName
): Promise<GateResult | undefined> {
  return db.transaction(async (tx) => {
    const locked = await lockRun(tx, run);
    if (!locked) return undefined;
    const [org] = await tx
      .select({ stage: organizations.stage })
      .from(organizations)
      .where(eq(organizations.id, locked.organizationId));
    return checkOrRefuse(tx, locked, org!.stage, tool);
  });
}

/**
 * 도구 쓰기의 결과. `woken`은 이 쓰기가 깨운 에이전트로, commit 뒤 실행 시도를 촉진한다.
 * `invalid`는 도구마다 정한 입력·기록 규칙의 거부이며 아무것도 남기지 않는다. 같은 호출 키에 다른 도구·입력이 오면 `idempotency_conflict`다.
 */
export type ToolWrite<T, P extends string> =
  | { kind: "ok"; value: T; events: Event[]; woken?: string[] }
  | { kind: "run_finished" }
  | { kind: "refused"; reason: ToolRefusalReason; events: Event[] }
  | { kind: "invalid"; problem: P | "idempotency_conflict" };

/** 같은 효과를 한 번만 남기는 호출의 키와 입력 digest. 키는 에이전트마다 따로다(contracts `idempotencyKeyHeader`). */
export type ToolOperation = { key: string; digest: string };

/** 조직 도구 쓰기 호출 하나: 남길 공개 활동 요약과, 있으면 같은 호출 키. */
export type ToolCall = { activity: PublicActivity; operation?: ToolOperation };

/**
 * 조직 도구 쓰기의 공통 틀: 조직 행과 실행 시도 행을 잠그고, 실행 시도가 끝나거나 취소를 요청받지 않았는지와 단계 규칙을 다시 확인한 뒤 쓴다.
 * 실행 시도 행을 먼저 잠그면 조직 행을 잠근 채 실행 시도에 취소를 요청하는 제어 명령과 교착한다.
 *
 * 같은 호출 키(`call.operation`)를 주면 그 에이전트가 같은 키로 이미 남긴 결과를 다시 쓰지 않고 돌려준다. 키 기록은 효과와 같은
 * transaction이므로 효과가 commit되었으면 키도 있고, 같은 키의 동시 호출은 조직 행 잠금으로 직렬화된다. 서버 재시작 뒤 같은 깨우기를
 * 다시 받은 실행 시도는 새 실행 시도·토큰이어도 같은 키면 앞 실행 시도의 결과를 받으며 새 기록·Event·깨우기는 없다.
 * Role·단계 규칙은 같은 키여도 먼저 검사한다.
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
    const gate = await checkOrRefuse(tx, locked, org.stage, tool);
    if (!gate.ok)
      return { kind: "refused", reason: gate.reason, events: [gate.event] };
    if (operation) {
      const [done] = await tx
        .select()
        .from(toolOperations)
        .where(
          and(
            eq(toolOperations.agentId, locked.agentId),
            eq(toolOperations.key, operation.key)
          )
        );
      if (done) {
        if (done.tool !== tool || done.requestDigest !== operation.digest)
          return { kind: "invalid", problem: "idempotency_conflict" };
        return { kind: "ok", value: done.result as T, events: [] };
      }
    }
    const result = await write(tx, locked, org);
    if (result.kind !== "ok") return result;
    if (operation)
      await tx.insert(toolOperations).values({
        organizationId: locked.organizationId,
        agentId: locked.agentId,
        key: operation.key,
        tool,
        requestDigest: operation.digest,
        result: result.value,
        runId: locked.id,
      });
    const summary = await insertEvent(tx, {
      organizationId: locked.organizationId,
      type: "run.activity",
      payload: { runId: locked.id, agentId: locked.agentId, activity },
    });
    return { ...result, events: [...result.events, summary] };
  });
}
