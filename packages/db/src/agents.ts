import type { Event, UpdateAgentProfileInput } from "@babojubot/contracts";
import { planAgentProfileChange } from "@babojubot/core";
import { and, eq, ne } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  isUuid,
  lockAgent,
  lockOrganization,
  toAgent,
} from "./rows.ts";
import { agents } from "./schema.ts";

export type AgentProfileChangeResult =
  | { kind: "changed"; event: Event }
  | { kind: "unchanged" }
  | { kind: "name_taken" }
  | { kind: "not_found" };

/**
 * 사용자의 에이전트 이름·얼굴 변경. 조직 행 → 에이전트 행 잠금 아래에서 같은 조직의 다른 이름을 읽고 바꾸며 그 Event를 같은
 * transaction에 남긴다. 작업자 추가도 조직 행을 잠근 뒤 이름을 읽으므로, 새 작업자와 바꾼 이름이 겹치지 않는다.
 * 다른 조직의 에이전트와 없는 에이전트는 같은 `not_found`다.
 */
export async function updateAgentProfile(
  db: Database,
  organizationId: string,
  agentId: string,
  input: UpdateAgentProfileInput
): Promise<AgentProfileChangeResult> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return { kind: "not_found" };
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId)))
      return { kind: "not_found" };
    const row = await lockAgent(tx, organizationId, agentId);
    if (!row) return { kind: "not_found" };
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
    if (typeof plan === "string") return { kind: plan };
    await tx.update(agents).set(plan.update).where(eq(agents.id, agentId));
    return { kind: "changed", event: await insertEvent(tx, plan.event) };
  });
}
