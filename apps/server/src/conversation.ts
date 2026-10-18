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
 * Lead가 실행 중이면 메시지는 다음 실행 시도에 반영된다.
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
): Promise<ConversationMessage> {
  const plan = planOwnerMessage(
    { organizationId: organization.id, agents: organization.agents },
    input,
    { newId: randomUUID, now }
  );
  const event = await insertOwnerMessage(db, plan);
  try {
    hub.publish(event);
  } catch (error) {
    console.error("[conversation] publish after commit failed", error);
  }
  dispatcher.kick(plan.wake.agentId);
  return plan.message;
}
