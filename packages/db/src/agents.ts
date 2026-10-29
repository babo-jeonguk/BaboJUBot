import type {
  AgentDetail,
  UpdateAgentProfileInput,
} from "@babojubot/contracts";
import { planAgentProfileChange } from "@babojubot/core";
import { and, eq, ne } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  isUuid,
  lockAgent,
  lockOrganization,
  toAgent,
  violatesUnique,
} from "./rows.ts";
import { findAgentDetail } from "./runs.ts";
import { agents } from "./schema.ts";
import { refused, stored, type Stored } from "./stored.ts";

export type AgentProfileChangeResult = Stored<
  AgentDetail,
  "name_taken" | "not_found"
>;

/**
 * 사용자의 에이전트 이름·얼굴 변경. 조직 행 → 에이전트 행 잠금 아래에서 같은 조직의 다른 이름을 읽고 바꾸며 그 Event를 같은
 * transaction에 남긴다. 작업자 추가·승인 결정도 조직 행을 잠근 뒤 이름을 읽으므로, 새 작업자와 바꾼 이름이 겹치지 않는다.
 * 그 잠금을 거치지 않은 쓰기와 겹쳐 DB의 이름 unique index에 걸려도 같은 `name_taken`이다.
 * 다른 조직의 에이전트와 없는 에이전트는 같은 `not_found`다. 값은 변경 뒤의 에이전트 상세다.
 */
export async function updateAgentProfile(
  db: Database,
  organizationId: string,
  agentId: string,
  input: UpdateAgentProfileInput
): Promise<AgentProfileChangeResult> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return refused("not_found");
  try {
    return await changeAgentProfile(db, organizationId, agentId, input);
  } catch (error) {
    if (violatesUnique(error, "agents_organization_name_unique"))
      return refused("name_taken");
    throw error;
  }
}

function changeAgentProfile(
  db: Database,
  organizationId: string,
  agentId: string,
  input: UpdateAgentProfileInput
): Promise<AgentProfileChangeResult> {
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId)))
      return refused("not_found");
    const row = await lockAgent(tx, organizationId, agentId);
    if (!row) return refused("not_found");
    const others = await tx
      .select({ name: agents.name })
      .from(agents)
      .where(
        and(eq(agents.organizationId, organizationId), ne(agents.id, agentId))
      );
    const plan = planAgentProfileChange(
      toAgent(row),
      input,
      others.map((o) => o.name)
    );
    const detail = async () =>
      (await findAgentDetail(tx, organizationId, agentId))!;
    if (plan === "name_taken") return refused(plan);
    if (plan === "unchanged") return stored(await detail());
    await tx.update(agents).set(plan.update).where(eq(agents.id, agentId));
    const event = await insertEvent(tx, plan.event);
    return stored(await detail(), { events: [event] });
  });
}
