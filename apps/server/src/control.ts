import type {
  AgentCommand,
  AgentDetail,
  Organization,
  OrganizationCommand,
} from "@babojubot/contracts";
import {
  controlAgent as storeAgentControl,
  controlOrganization as storeOrganizationControl,
  findAgentDetail,
  type ControlResult,
  type Database,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

type Deps = { db: Database; hub: EventHub; dispatcher: RunDispatcher };

/**
 * 사용자의 조직 일시정지·재개·중단 제어 명령. 단계·취소 요청·Event를 한 transaction으로 저장한 뒤에만 알리고,
 * 진행 중 실행기에 취소를 보낸다. 재개하면 그 조직의 대기 깨우기를 다시 처리한다. 조직 도구에는 이 명령이 없다.
 */
export async function controlOrganization(
  { db, hub, dispatcher }: Deps,
  organizationId: string,
  command: OrganizationCommand
): Promise<ControlResult<Organization>> {
  const result = await storeOrganizationControl(db, organizationId, command);
  if (result.kind !== "changed") return result;
  hub.publish(result.event);
  dispatcher.cancel(result.cancellation);
  if (command === "resume") await dispatcher.kickOrganization(organizationId);
  return result;
}

/**
 * 사용자의 에이전트 일시정지·재개·실행 중단 제어 명령. 돌려주는 값은 명령 뒤의 에이전트 상세다.
 * 실행 중단은 일시정지가 아니므로 그 뒤의 깨우기는 평소처럼 실행 시도를 시작한다(취소 정리가 끝난 뒤).
 */
export async function controlAgent(
  { db, hub, dispatcher }: Deps,
  organizationId: string,
  agentId: string,
  command: AgentCommand
): Promise<ControlResult<AgentDetail>> {
  const result = await storeAgentControl(db, organizationId, agentId, command);
  if (result.kind === "not_found" || result.kind === "organization_closed")
    return result;
  if (result.kind === "changed") {
    hub.publish(result.event);
    dispatcher.cancel(result.cancellation);
    if (command === "resume") dispatcher.kick(agentId);
  }
  const detail = await findAgentDetail(db, organizationId, agentId);
  if (!detail) return { kind: "not_found" };
  return { ...result, value: detail };
}
