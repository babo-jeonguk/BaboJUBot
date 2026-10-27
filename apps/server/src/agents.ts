import type {
  AgentDetail,
  UpdateAgentProfileInput,
} from "@babojubot/contracts";
import {
  findAgentDetail,
  updateAgentProfile as storeAgentProfile,
  type Database,
} from "@babojubot/db";
import type { EventHub } from "./event-hub.ts";

/** 사용자의 에이전트 이름·얼굴 변경. 저장한 뒤에만 알리고, 돌려주는 값은 변경 뒤의 에이전트 상세다. */
export async function updateAgentProfile(
  { db, hub }: { db: Database; hub: EventHub },
  organizationId: string,
  agentId: string,
  input: UpdateAgentProfileInput
): Promise<
  | { kind: "ok"; agent: AgentDetail }
  | { kind: "not_found" }
  | { kind: "name_taken" }
> {
  const result = await storeAgentProfile(db, organizationId, agentId, input);
  if (result.kind === "not_found" || result.kind === "name_taken")
    return result;
  if (result.kind === "changed") hub.publish(result.event);
  const agent = await findAgentDetail(db, organizationId, agentId);
  return agent ? { kind: "ok", agent } : { kind: "not_found" };
}
