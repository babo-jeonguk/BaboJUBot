import {
  defaultMaxConcurrentRuns,
  type AgentDetail,
  type AgentRole,
  type ProviderChoice,
  type UpdateProviderDefaultsInput,
} from "@babojubot/contracts";
import { planAgentProviderChange } from "@babojubot/core";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  isUuid,
  lockAgent,
  lockOrganization,
  toAgent,
  type Executor,
} from "./rows.ts";
import { findAgentDetail } from "./run-views.ts";
import { agents, providerDefaults, providerLimits, runs } from "./schema.ts";
import { refused, stored, type Stored } from "./stored.ts";

// 전역 프로바이더 설정(Lead·작업자 기본값, 연결별 동시 실행 상한)과 에이전트별 프로바이더·모델(#94).
// 연결 ID가 서버에 등록돼 있는지, 모델이 그 연결의 목록에 있는지는 등록부를 가진 서버가 확인한다.

export type ProviderDefaults = {
  leadDefault: ProviderChoice;
  workerDefault: ProviderChoice;
};

/** 전역 Lead·작업자 기본값. migration이 두 행을 만들어 두므로 늘 있다. */
export async function readProviderDefaults(
  db: Executor
): Promise<ProviderDefaults> {
  const rows = await db.select().from(providerDefaults);
  const of = (role: AgentRole): ProviderChoice => {
    const row = rows.find((r) => r.role === role);
    if (!row) throw new Error(`provider default for ${role} is missing`);
    return { provider: row.provider, model: row.model };
  };
  return { leadDefault: of("lead"), workerDefault: of("worker") };
}

/**
 * 사용자의 Lead·작업자 기본값 변경. 이미 있는 에이전트와 이미 올라온 요청은 바꾸지 않고, 이후의 Lead 생성과 작업자 요청만 쓴다.
 * 전역 설정이라 조직 Event는 남기지 않고, commit 뒤 다른 화면에 다시 불러오라는 신호만 보낸다. 값은 변경 뒤의 기본값이다.
 */
export async function updateProviderDefaults(
  db: Database,
  input: UpdateProviderDefaultsInput
): Promise<Stored<ProviderDefaults, never>> {
  return db.transaction(async (tx) => {
    const rows = [
      { role: "lead" as const, ...input.leadDefault },
      { role: "worker" as const, ...input.workerDefault },
    ];
    // 변경 판정도 conflict 행의 잠금 아래에서 한다. 먼저 읽은 snapshot과 비교하면
    // 기다리는 사이 commit된 변경을 되돌려도 같은 값이라고 잘못 판정할 수 있다.
    const changedRows = await tx
      .insert(providerDefaults)
      .values(rows)
      .onConflictDoUpdate({
        target: providerDefaults.role,
        set: {
          provider: sql`excluded.provider`,
          model: sql`excluded.model`,
        },
        setWhere: sql`(${providerDefaults.provider}, ${providerDefaults.model})
          is distinct from (excluded.provider, excluded.model)`,
      })
      .returning({ role: providerDefaults.role });
    const after = await readProviderDefaults(tx);
    return stored(after, {
      events: [],
      settingsChanged: changedRows.length > 0,
    });
  });
}

/** 연결별 동시 실행 상한. 정하지 않은 연결은 기본값이다. */
export async function readProviderLimits(
  db: Executor,
  providerIds: readonly string[]
): Promise<Map<string, number>> {
  const rows = await db.select().from(providerLimits);
  const saved = new Map(rows.map((r) => [r.provider, r.maxConcurrentRuns]));
  return new Map(
    providerIds.map((id) => [id, saved.get(id) ?? defaultMaxConcurrentRuns])
  );
}

/**
 * 사용자의 동시 실행 상한 변경(0은 무제한). 진행 중인 실행 시도는 끊지 않고, commit 뒤 그 연결을 기다리는 에이전트를 다시 촉진한다.
 * admission과 같은 행 잠금으로 직렬화된다. 값은 변경 뒤의 상한이다.
 */
export async function updateProviderLimit(
  db: Database,
  provider: string,
  maxConcurrentRuns: number
): Promise<Stored<number, never>> {
  return db.transaction(async (tx) => {
    // 없는 행에는 FOR UPDATE가 잠글 대상이 없다. 먼저 암묵적 기본값을 행으로 만들고,
    // 실제 값을 바꾼 UPDATE 결과로 알림과 대기 촉진 여부를 정한다.
    await tx
      .insert(providerLimits)
      .values({ provider, maxConcurrentRuns: defaultMaxConcurrentRuns })
      .onConflictDoNothing();
    const changedRows = await tx
      .update(providerLimits)
      .set({ maxConcurrentRuns })
      .where(
        and(
          eq(providerLimits.provider, provider),
          sql`${providerLimits.maxConcurrentRuns} <> ${maxConcurrentRuns}`
        )
      )
      .returning({ provider: providerLimits.provider });
    const changed = changedRows.length > 0;
    return stored(maxConcurrentRuns, {
      events: [],
      settingsChanged: changed,
      providersFreed: changed ? [provider] : [],
    });
  });
}

/**
 * admission의 연결 자리 확인. 연결의 상한 행을 `FOR UPDATE`로 잠근 뒤(없으면 기본값으로 만듦) 진행 중 실행 시도를 센다.
 * 같은 연결의 admission과 상한 변경이 이 잠금으로 직렬화되므로, 센 뒤 다른 admission이 끼어들어 상한을 넘지 않는다.
 * 잠금 순서에서 이 행은 조직 → 에이전트 다음의 마지막이며, 이 잠금 아래에서 다른 행을 기다리지 않는다.
 */
export async function lockProviderSlot(
  tx: Executor,
  provider: string
): Promise<{ maxConcurrentRuns: number; running: number }> {
  await tx
    .insert(providerLimits)
    .values({ provider, maxConcurrentRuns: defaultMaxConcurrentRuns })
    .onConflictDoNothing();
  const [limit] = await tx
    .select({ max: providerLimits.maxConcurrentRuns })
    .from(providerLimits)
    .where(eq(providerLimits.provider, provider))
    .for("update");
  const [count] = await tx
    .select({ running: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.provider, provider), eq(runs.status, "running")));
  return { maxConcurrentRuns: limit!.max, running: count!.running };
}

/**
 * 사용자의 에이전트 프로바이더·모델 변경. 조직 행 → 에이전트 행 잠금 아래에서 바꾸고 그 Event를 같은 transaction에 남긴다.
 * 진행 중인 실행 시도는 admission 때 고정한 값으로 끝나고, 다음 실행 시도부터 새 값이다. commit 뒤 그 에이전트를 촉진해
 * 옛 연결의 자리를 기다리던 깨우기가 새 연결로 시작할 수 있게 한다. 다른 조직의 에이전트와 없는 에이전트는 같은 `not_found`다.
 */
export async function updateAgentProvider(
  db: Database,
  organizationId: string,
  agentId: string,
  input: ProviderChoice
): Promise<Stored<AgentDetail, "organization_closed" | "not_found">> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return refused("not_found");
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return refused("not_found");
    const row = await lockAgent(tx, organizationId, agentId);
    if (!row) return refused("not_found");
    const detail = async () =>
      (await findAgentDetail(tx, organizationId, agentId))!;
    const plan = planAgentProviderChange(toAgent(row), org.stage, input);
    if (plan === "organization_closed") return refused(plan);
    if (plan === "unchanged") return stored(await detail());
    await tx.update(agents).set(plan.update).where(eq(agents.id, agentId));
    const event = await insertEvent(tx, plan.event);
    return stored(await detail(), { events: [event], woken: [agentId] });
  });
}
