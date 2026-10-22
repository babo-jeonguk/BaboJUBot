import { randomUUID } from "node:crypto";
import type { DecideApprovalInput } from "@babojubot/contracts";
import {
  decideApproval as storeDecision,
  type Database,
  type DecisionResult,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * 사용자의 승인 결정 제어 명령. 결정·단계·팀·사본·템플릿·Lead 깨우기·Event를 한 transaction으로 저장한 뒤에만
 * 알리고 Lead를 깨운다. 알림이 실패해도 저장된 결정은 성공이며, 깨우기는 저장돼 있어 서버 시작 때도 다시 처리된다.
 * 일시정지 중의 초기 연구 승인 결정은 조직을 재개하므로 그 조직의 대기 깨우기를 모두 다시 처리한다.
 */
export async function decideApproval(
  {
    db,
    hub,
    dispatcher,
    now,
  }: {
    db: Database;
    hub: EventHub;
    dispatcher: RunDispatcher;
    now: () => Date;
  },
  organizationId: string,
  approvalId: string,
  input: DecideApprovalInput
): Promise<DecisionResult> {
  const result = await storeDecision(db, organizationId, approvalId, input, {
    newId: randomUUID,
    now,
  });
  if (result.kind !== "decided") return result;
  try {
    for (const event of result.events) hub.publish(event);
  } catch (error) {
    console.error("[approvals] publish after commit failed", error);
  }
  if (result.resumed) void dispatcher.kickOrganization(organizationId);
  dispatcher.kick(result.wake.agentId);
  return result;
}
