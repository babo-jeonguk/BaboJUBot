import { randomUUID } from "node:crypto";
import type {
  ConversationMessage,
  OrganizationDetail,
  SendOwnerMessageInput,
} from "@babojubot/contracts";
import { planOwnerMessage } from "@babojubot/core";
import { insertOwnerMessage, type Database } from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * Lead 대화에 사용자 메시지를 남긴다. 메시지·깨우기·Event를 한 transaction으로 저장한 뒤 알리고 Lead를 깨운다.
 * Lead가 실행 중이면 메시지는 다음 실행 시도에 반영된다. `중단하고 반영`이면 같은 transaction에 남긴 중단 제어 명령대로
 * commit 뒤 진행 중 실행 시도에 취소를 보내고, 그 실행 시도가 정리를 끝내면 다음 실행 시도가 메시지를 받는다.
 * 최종 완료·중단 조직의 `중단하고 반영`은 제어 명령이라 받지 않는다.
 */
export async function sendOwnerMessage(
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
  organization: OrganizationDetail,
  input: Required<SendOwnerMessageInput>
): Promise<
  | { kind: "sent"; message: ConversationMessage }
  | { kind: "organization_closed" }
> {
  const plan = planOwnerMessage(
    { organizationId: organization.id, agents: organization.agents },
    input,
    { newId: randomUUID, now }
  );
  const stored = await insertOwnerMessage(db, plan);
  if (stored.kind === "organization_closed") return stored;
  const { events, cancellation } = stored;
  hub.publish(...events);
  dispatcher.cancel(cancellation);
  dispatcher.kick(plan.wake.agentId);
  return { kind: "sent", message: plan.message };
}
