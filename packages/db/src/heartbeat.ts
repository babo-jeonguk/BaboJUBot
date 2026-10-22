import type { Event, UpdateHeartbeatInput } from "@babojubot/contracts";
import {
  planHeartbeat,
  planHeartbeatChange,
  runBlockingStages,
  type RecordSource,
} from "@babojubot/core";
import { and, asc, eq, lte, notInArray } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  hasPendingHeartbeat,
  insertEvent,
  isUuid,
  lockAgent,
  lockOrganization,
  toAgentHeartbeat,
} from "./rows.ts";
import { agents, organizations, wakes } from "./schema.ts";

export type HeartbeatChangeResult =
  | { kind: "changed"; event: Event }
  | { kind: "unchanged" }
  | { kind: "organization_closed" }
  | { kind: "not_found" };

/**
 * 사용자의 heartbeat 설정 변경. 조직 행 → 에이전트 행 잠금 아래에서 바꾸고 그 Event를 같은 transaction에 남긴다.
 * scheduler도 같은 에이전트 행을 잠근 뒤 설정을 다시 읽으므로, 끈 뒤에 옛 설정으로 heartbeat가 생기지 않는다.
 * 다른 조직의 에이전트와 없는 에이전트는 같은 `not_found`다.
 */
export async function updateHeartbeat(
  db: Database,
  organizationId: string,
  agentId: string,
  input: UpdateHeartbeatInput,
  { now }: Pick<RecordSource, "now">
): Promise<HeartbeatChangeResult> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return { kind: "not_found" };
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return { kind: "not_found" };
    const agent = await lockAgent(tx, organizationId, agentId);
    if (!agent) return { kind: "not_found" };
    const plan = planHeartbeatChange(
      { ...agent, heartbeat: toAgentHeartbeat(agent) },
      org.stage,
      input,
      now()
    );
    if (typeof plan === "string") return { kind: plan };
    await tx
      .update(agents)
      .set({
        heartbeatEnabled: plan.heartbeat.enabled,
        heartbeatIntervalMinutes: plan.heartbeat.intervalMinutes,
        heartbeatNextAt:
          plan.heartbeat.nextAt === null
            ? null
            : new Date(plan.heartbeat.nextAt),
      })
      .where(eq(agents.id, agentId));
    return { kind: "changed", event: await insertEvent(tx, plan.event) };
  });
}

/**
 * 예정이 지난 heartbeat를 처리한다. 에이전트마다 따로 저장하며, 깨우기·다음 예정·Event가 한 transaction이다.
 * 여러 호출이 겹쳐도 에이전트 행 잠금 아래에서 예정을 다시 읽으므로 같은 예정은 한 번만 처리된다.
 * 돌려주는 `woken`은 새 heartbeat 깨우기가 생긴 에이전트로, commit 뒤 실행 시도를 촉진한다.
 */
export async function runDueHeartbeats(
  db: Database,
  source: RecordSource
): Promise<{ events: Event[]; woken: string[] }> {
  const due = await db
    .select({ id: agents.id, organizationId: agents.organizationId })
    .from(agents)
    .innerJoin(organizations, eq(organizations.id, agents.organizationId))
    .where(
      and(
        eq(agents.heartbeatEnabled, true),
        lte(agents.heartbeatNextAt, source.now()),
        eq(agents.paused, false),
        notInArray(organizations.stage, [...runBlockingStages])
      )
    )
    .orderBy(asc(agents.heartbeatNextAt));
  const events: Event[] = [];
  const woken: string[] = [];
  for (const { id, organizationId } of due) {
    const done = await db.transaction(async (tx) => {
      // 잠금 순서는 조직 → 에이전트다. 조직 행 FOR SHARE로 단계 전이와 직렬화한다(admission과 같다).
      const [org] = await tx
        .select({ stage: organizations.stage })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for("share");
      const agent = await lockAgent(tx, organizationId, id);
      if (!org || !agent) return undefined;
      const plan = planHeartbeat(
        { ...agent, heartbeat: toAgentHeartbeat(agent) },
        {
          stage: org.stage,
          pendingHeartbeat: await hasPendingHeartbeat(tx, id),
        },
        source
      );
      if (!plan) return undefined;
      if (plan.wake)
        await tx
          .insert(wakes)
          .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
      await tx
        .update(agents)
        .set({ heartbeatNextAt: new Date(plan.nextAt) })
        .where(eq(agents.id, id));
      return { event: await insertEvent(tx, plan.event), woke: !!plan.wake };
    });
    if (!done) continue;
    events.push(done.event);
    if (done.woke) woken.push(id);
  }
  return { events, woken };
}
