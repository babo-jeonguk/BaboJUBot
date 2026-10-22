import { randomUUID } from "node:crypto";
import type { DecideResultInput } from "@babojubot/contracts";
import {
  decideResult as storeDecision,
  type Database,
  type ResultDecisionResult,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * 사용자의 결과 검토 제어 명령(수정 요청·최종 완료). 결정·단계·Lead 깨우기·Event를 한 transaction으로 저장한 뒤에만
 * 알리고, 수정 요청이면 Lead를 깨운다. 알림이 실패해도 저장된 결정은 성공이며, 깨우기는 저장돼 있어 서버 시작 때도 다시 처리된다.
 * 최종 완료 뒤에는 남은 깨우기가 있어도 admission이 실행 시도를 시작하지 않는다. 일시정지 중의 결정은 조직을 재개한다.
 */
export async function decideResult(
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
  submissionId: string,
  input: DecideResultInput
): Promise<ResultDecisionResult> {
  const result = await storeDecision(db, organizationId, submissionId, input, {
    newId: randomUUID,
    now,
  });
  if (result.kind !== "decided") return result;
  try {
    for (const event of result.events) hub.publish(event);
  } catch (error) {
    console.error("[results] publish after commit failed", error);
  }
  if (result.resumed) await dispatcher.kickOrganization(organizationId);
  if (result.wake) dispatcher.kick(result.wake.agentId);
  return result;
}
