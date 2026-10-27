import type {
  AgentCommand,
  Event,
  Organization,
  OrganizationCommand,
} from "@babojubot/contracts";
import {
  planAgentControl,
  planOrganizationControl,
  type RunCancellation,
} from "@babojubot/core";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  isUuid,
  lockCancellableRuns,
  lockOrganization,
  requestCancellation,
  toOrganization,
} from "./rows.ts";
import { agents, organizations, runs } from "./schema.ts";

// 사용자 제어 명령의 저장. 모든 명령은 조직 행 → 에이전트 행 → 실행 시도 행 순서로 잠근다(admission·도구 쓰기와 같은 순서).
// 단계·일시정지 상태·취소 요청·Event를 한 transaction에 남기고, 실행기에 취소를 보내는 일은 commit 뒤 호출자가 한다.
// 취소 요청은 실행 시도 행에 남으므로 그 순간부터 토큰이 닫히고, 실행기가 정리를 끝낼 때까지 그 에이전트의 실행 슬롯은 비지 않는다.

export type ControlResult<T> =
  | {
      kind: "changed";
      value: T;
      event: Event;
      cancellation: RunCancellation | null;
    }
  | { kind: "unchanged"; value: T }
  | { kind: "organization_closed" }
  | { kind: "not_found" };

/** 조직 일시정지·재개·중단. 다른 조직과 없는 조직은 같은 `not_found`다. */
export async function controlOrganization(
  db: Database,
  organizationId: string,
  command: OrganizationCommand
): Promise<ControlResult<Organization>> {
  if (!isUuid(organizationId)) return { kind: "not_found" };
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return { kind: "not_found" };
    const running =
      command === "resume"
        ? []
        : await lockCancellableRuns(
            tx,
            eq(runs.organizationId, organizationId)
          );
    const plan = planOrganizationControl(org, command, running);
    if (plan === "organization_closed") return { kind: plan };
    if (plan === "unchanged") return { kind: plan, value: toOrganization(org) };
    const [updated] = await tx
      .update(organizations)
      .set({ stage: plan.stage, pausedFrom: plan.pausedFrom })
      .where(eq(organizations.id, organizationId))
      .returning();
    await requestCancellation(tx, plan.cancellation);
    return {
      kind: "changed",
      value: toOrganization(updated!),
      event: await insertEvent(tx, plan.event),
      cancellation: plan.cancellation,
    };
  });
}

/**
 * 에이전트 일시정지·재개·실행 중단. 다른 조직의 에이전트와 없는 에이전트는 같은 `not_found`다. 값은 바뀐 뒤의 일시정지 여부다.
 * 실행 중단은 아직 취소를 요청받지 않은 진행 중 실행 시도가 있을 때만 취소 요청·Event를 남긴다.
 */
export async function controlAgent(
  db: Database,
  organizationId: string,
  agentId: string,
  command: AgentCommand
): Promise<ControlResult<{ paused: boolean }>> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return { kind: "not_found" };
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return { kind: "not_found" };
    // FOR UPDATE가 아닌 NO KEY UPDATE: 실행 시도 행을 잠근 채 Event FK로 에이전트 행(KEY SHARE)을 기다리는 쓰기와 교착하지 않는다.
    const [agent] = await tx
      .select({
        id: agents.id,
        organizationId: agents.organizationId,
        paused: agents.paused,
      })
      .from(agents)
      .where(
        and(eq(agents.organizationId, organizationId), eq(agents.id, agentId))
      )
      .for("no key update");
    if (!agent) return { kind: "not_found" };
    const [running] =
      command === "resume"
        ? []
        : await lockCancellableRuns(tx, eq(runs.agentId, agentId));
    const plan = planAgentControl(agent, org.stage, command, running ?? null);
    if (plan === "organization_closed") return { kind: plan };
    if (plan === "unchanged")
      return { kind: plan, value: { paused: agent.paused } };
    if (plan.paused !== agent.paused)
      await tx
        .update(agents)
        .set({ paused: plan.paused })
        .where(eq(agents.id, agentId));
    await requestCancellation(tx, plan.cancellation);
    return {
      kind: "changed",
      value: { paused: plan.paused },
      event: await insertEvent(tx, plan.event),
      cancellation: plan.cancellation,
    };
  });
}
