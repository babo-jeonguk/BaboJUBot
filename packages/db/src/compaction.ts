import { stored } from "./stored.ts";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { SessionState } from "@babojubot/contracts";
import { admitsProviderRun } from "@babojubot/core";
import type { Database } from "./client.ts";
import type { Executor } from "./rows.ts";
import {
  agentSessions,
  agents,
  organizations,
  runs,
  sessionMaintenanceLeases as leases,
} from "./schema.ts";
import { lockProviderSlot, readProviderDefaults } from "./providers.ts";

/** 에이전트의 세션 하나라도 압축 중인가. 압축과 실행 시도는 세션이 달라도 에이전트 단위로 배타다. */
export async function hasRunningMaintenance(db: Executor, agentId: string) {
  const [row] = await db
    .select({ id: leases.id })
    .from(leases)
    .where(and(eq(leases.agentId, agentId), eq(leases.status, "running")))
    .limit(1);
  return !!row;
}
export async function cancelSessionMaintenance(
  db: Executor,
  agentId: string,
  taskId: string | null
) {
  await db
    .update(agentSessions)
    .set({ maintenance: null })
    .where(
      and(
        eq(agentSessions.agentId, agentId),
        taskId === null
          ? isNull(agentSessions.taskId)
          : eq(agentSessions.taskId, taskId)
      )
    );
}
export async function listCompactionCandidates(db: Database) {
  return db
    .select({
      id: agentSessions.id,
      organizationId: agentSessions.organizationId,
      agentId: agentSessions.agentId,
    })
    .from(agentSessions)
    .where(isNotNull(agentSessions.maintenance));
}
export async function claimCompaction(
  db: Database,
  candidate: { id: string; organizationId: string; agentId: string },
  now: Date,
  providers: readonly string[]
) {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, candidate.organizationId))
      .for("share");
    if (!org || org.stage === "stopped" || org.stage === "completed") return;
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, candidate.agentId))
      .for("update");
    const [session] = await tx
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, candidate.id));
    if (
      !agent ||
      !session?.maintenance ||
      !providers.includes(session.provider)
    )
      return;
    const facts = session.maintenance,
      last = Date.parse(facts.lastRequestAt),
      expires = last + facts.ttlMs;
    if (now.getTime() >= expires) {
      await tx
        .update(agentSessions)
        .set({ maintenance: null })
        .where(eq(agentSessions.id, session.id));
      return;
    }
    const { compaction } = await readProviderDefaults(tx);
    if (
      facts.tokens < compaction.thresholdTokens ||
      now.getTime() < last + facts.ttlMs * compaction.ratio
    )
      return;
    const [run] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.agentId, agent.id), eq(runs.status, "running")))
      .limit(1);
    if (run || (await hasRunningMaintenance(tx, agent.id))) return;
    if (!admitsProviderRun(await lockProviderSlot(tx, session.provider)))
      return;
    const lease = {
      id: randomUUID(),
      sessionId: session.id,
      organizationId: session.organizationId,
      agentId: agent.id,
      taskId: session.taskId,
      provider: session.provider,
      generation: agent.sessionGeneration,
      status: "running" as const,
    };
    await tx.insert(leases).values(lease);
    await tx
      .update(agentSessions)
      .set({ maintenance: null })
      .where(eq(agentSessions.id, session.id));
    return {
      ...lease,
      session: session.state,
      tools: session.maintenance.tools ?? [],
    };
  });
}
export async function finishCompaction(
  db: Database,
  id: string,
  result: { ok: boolean; nextSession: SessionState | null }
) {
  return db.transaction(async (tx) => {
    const [owner] = await tx.select().from(leases).where(eq(leases.id, id));
    if (!owner) return;
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, owner.organizationId))
      .for("share");
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, owner.agentId))
      .for("update");
    const [lease] = await tx
      .select()
      .from(leases)
      .where(and(eq(leases.id, id), eq(leases.status, "running")))
      .for("update");
    if (!lease) return;
    if (
      result.ok &&
      result.nextSession &&
      org &&
      org.stage !== "stopped" &&
      org.stage !== "completed" &&
      agent?.sessionGeneration === lease.generation
    )
      await tx
        .update(agentSessions)
        .set({ state: result.nextSession })
        .where(eq(agentSessions.id, lease.sessionId));
    await tx
      .update(leases)
      .set({ status: result.ok ? "completed" : "failed" })
      .where(eq(leases.id, id));
    return stored(null, {
      events: [],
      woken: [lease.agentId],
      providersFreed: [lease.provider],
    });
  });
}
export async function compactionLeaseActive(db: Database, id: string) {
  const [row] = await db
    .select({
      stage: organizations.stage,
      generation: agents.sessionGeneration,
      leaseGeneration: leases.generation,
    })
    .from(leases)
    .innerJoin(organizations, eq(organizations.id, leases.organizationId))
    .innerJoin(agents, eq(agents.id, leases.agentId))
    .where(and(eq(leases.id, id), eq(leases.status, "running")));
  return (
    !!row &&
    row.generation === row.leaseGeneration &&
    row.stage !== "stopped" &&
    row.stage !== "completed"
  );
}
/** A dispatched command may have completed before a crash. Never blindly repeat it. */
export async function recoverCompactions(db: Database) {
  await db
    .update(leases)
    .set({ status: "unknown" })
    .where(eq(leases.status, "running"));
}
