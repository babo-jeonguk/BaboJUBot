import type {
  AgentCommand,
  AgentDetail,
  Organization,
  OrganizationCommand,
} from "@babojubot/contracts";
import { planAgentControl, planOrganizationControl } from "@babojubot/core";
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
import { findAgentDetail } from "./run-views.ts";
import { agents, organizations, runs } from "./schema.ts";
import { refused, stored, type Stored } from "./stored.ts";

// 사용자 제어 명령의 저장. 모든 명령은 조직 행 → 에이전트 행 → 실행 시도 행 순서로 잠근다(admission·도구 쓰기와 같은 순서).
// 단계·일시정지 상태·취소 요청·Event를 한 transaction에 남기고, 실행기에 취소를 보내는 일은 commit 뒤 호출자가 한다.
// 취소 요청은 실행 시도 행에 남으므로 그 순간부터 토큰이 닫히고, 실행기가 정리를 끝낼 때까지 그 에이전트의 실행 슬롯은 비지 않는다.
// 이미 그 상태면 아무것도 남기지 않는 빈 성공이다.

export type ControlRefusal = "organization_closed" | "not_found";

/**
 * 조직 일시정지·재개·중단. 값은 명령 뒤의 조직이다. 다른 조직과 없는 조직은 같은 `not_found`다.
 * 재개하면 commit 뒤 그 조직의 대기 깨우기를 다시 처리한다.
 */
export async function controlOrganization(
  db: Database,
  organizationId: string,
  command: OrganizationCommand
): Promise<Stored<Organization, ControlRefusal>> {
  if (!isUuid(organizationId)) return refused("not_found");
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return refused("not_found");
    const running =
      command === "resume"
        ? []
        : await lockCancellableRuns(
            tx,
            eq(runs.organizationId, organizationId)
          );
    const plan = planOrganizationControl(org, command, running);
    if (plan === "organization_closed") return refused(plan);
    if (plan === "unchanged") return stored(toOrganization(org));
    const [updated] = await tx
      .update(organizations)
      .set({ stage: plan.stage, pausedFrom: plan.pausedFrom })
      .where(eq(organizations.id, organizationId))
      .returning();
    await requestCancellation(tx, plan.cancellation);
    return stored(toOrganization(updated!), {
      events: [await insertEvent(tx, plan.event)],
      cancellation: plan.cancellation,
      ...(command === "resume"
        ? { resumedOrganizationId: organizationId }
        : {}),
    });
  });
}

/**
 * 에이전트 일시정지·재개·실행 중단. 다른 조직의 에이전트와 없는 에이전트는 같은 `not_found`다. 값은 명령 뒤의 에이전트 상세다.
 * 실행 중단은 아직 취소를 요청받지 않은 진행 중 실행 시도가 있을 때만 취소 요청·Event를 남긴다. 실행 중단은 일시정지가 아니므로
 * 그 뒤의 깨우기는 취소 정리가 끝난 뒤 평소처럼 실행 시도를 시작한다. 재개하면 commit 뒤 그 에이전트를 깨운다.
 */
export async function controlAgent(
  db: Database,
  organizationId: string,
  agentId: string,
  command: AgentCommand
): Promise<Stored<AgentDetail, ControlRefusal>> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return refused("not_found");
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return refused("not_found");
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
    if (!agent) return refused("not_found");
    const [running] =
      command === "resume"
        ? []
        : await lockCancellableRuns(tx, eq(runs.agentId, agentId));
    const plan = planAgentControl(agent, org.stage, command, running ?? null);
    const detail = async () =>
      (await findAgentDetail(tx, organizationId, agentId))!;
    if (plan === "organization_closed") return refused(plan);
    if (plan === "unchanged") return stored(await detail());
    if (plan.paused !== agent.paused)
      await tx
        .update(agents)
        .set({ paused: plan.paused })
        .where(eq(agents.id, agentId));
    await requestCancellation(tx, plan.cancellation);
    const event = await insertEvent(tx, plan.event);
    return stored(await detail(), {
      events: [event],
      cancellation: plan.cancellation,
      ...(command === "resume" ? { woken: [agentId] } : {}),
    });
  });
}
