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
import { organizations } from "./schema.ts";

// 조직 도구 호출의 공통 검사와 쓰기 틀. 모든 쓰기는 실행 중인 실행 시도 행 → 조직 행 순서로 잠그고,
// 잠금 아래에서 Role·단계 규칙을 다시 확인한다. 같은 조직의 도구 쓰기는 조직 행 잠금으로 직렬화된다.

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
  const locked = await lockRunningRun(tx, run.id, "share");
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
 * `invalid`는 도구마다 정한 입력·기록 규칙의 거부이며 아무것도 남기지 않는다.
 */
export type ToolWrite<T, P extends string> =
  | { kind: "ok"; value: T; events: Event[]; woken?: string[] }
  | { kind: "run_finished" }
  | { kind: "refused"; reason: ToolRefusalReason; events: Event[] }
  | { kind: "invalid"; problem: P };

/** 조직 도구 쓰기의 공통 틀: 실행 중인 실행 시도와 그 조직 행을 잠그고, 단계 규칙을 다시 확인한 뒤 쓴다. */
export async function toolWrite<T, P extends string>(
  db: Database,
  run: ActiveRunRef,
  tool: OrgToolName,
  activity: PublicActivity,
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
    const locked = await lockRun(tx, run);
    if (!locked) return { kind: "run_finished" };
    const org = (await lockOrganization(tx, locked.organizationId))!;
    const gate = await checkOrRefuse(tx, locked, org.stage, tool);
    if (!gate.ok)
      return { kind: "refused", reason: gate.reason, events: [gate.event] };
    const result = await write(tx, locked, org);
    if (result.kind !== "ok") return result;
    const summary = await insertEvent(tx, {
      organizationId: locked.organizationId,
      type: "run.activity",
      payload: { runId: locked.id, agentId: locked.agentId, activity },
    });
    return { ...result, events: [...result.events, summary] };
  });
}
