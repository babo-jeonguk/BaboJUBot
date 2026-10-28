import { randomUUID } from "node:crypto";
import type {
  Conversation,
  ConversationMessage,
  OrganizationDetail,
  SendOwnerMessageInput,
} from "@babojubot/contracts";
import { planOwnerMessage } from "@babojubot/core";
import {
  insertOwnerMessage,
  sendQueuedMessageNow,
  withdrawQueuedMessage,
  type Database,
  type QueuedMessageResult,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * Lead 대화에 사용자 메시지를 남긴다. 메시지·깨우기·Event를 한 transaction으로 저장한 뒤 알리고 Lead를 깨운다.
 * `conversation`은 같은 조직의 대화(호출한 쪽이 조직 안에서 찾은 것)이고, `new`면 이 메시지로 새 대화를 시작한다.
 * 새 대화는 메시지와 같은 transaction에 남으므로 메시지를 받지 않으면 대화도 남지 않는다.
 * Lead가 실행 중이면 메시지는 다음 실행 시도에 반영된다. `중단하고 보내기`면 같은 transaction에 남긴 중단 제어 명령대로
 * commit 뒤 진행 중 실행 시도에 취소를 보내고, 그 실행 시도가 정리를 끝내면 다음 실행 시도가 메시지를 받는다.
 * 최종 완료·중단 조직의 `중단하고 보내기`는 제어 명령이라 받지 않는다.
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
  conversation: Pick<Conversation, "id"> | "new",
  input: Required<SendOwnerMessageInput>
): Promise<
  | {
      kind: "sent";
      conversation: Conversation | null;
      message: ConversationMessage;
    }
  | { kind: "organization_closed" }
> {
  const plan = planOwnerMessage(
    { organizationId: organization.id, agents: organization.agents },
    conversation,
    input,
    { newId: randomUUID, now }
  );
  const stored = await insertOwnerMessage(db, plan);
  if (stored.kind === "organization_closed") return stored;
  const { events, cancellation } = stored;
  hub.publish(...events);
  dispatcher.cancel(cancellation);
  dispatcher.kick(plan.wake.agentId);
  return {
    kind: "sent",
    conversation: plan.conversation,
    message: plan.message,
  };
}

/**
 * 줄 세운 메시지에 대한 사용자 명령. `withdraw`는 메시지를 거두고(`취소`·`고치기`), `send_now`는 `지금 보내기`로
 * 전달 방식을 `중단하고 보내기`로 바꿔 진행 중 실행 시도를 끊는다. 저장한 뒤에만 알리고, 지금 보내기는 commit 뒤
 * 실행기에 취소를 보내고 Lead를 깨운다. 실행 시도가 이미 받은 메시지는 `message_delivered`다.
 */
export async function commandQueuedMessage(
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
  messageId: string,
  command: "withdraw" | "send_now"
): Promise<QueuedMessageResult> {
  const result =
    command === "withdraw"
      ? await withdrawQueuedMessage(db, organizationId, messageId, { now })
      : await sendQueuedMessageNow(db, organizationId, messageId);
  if (result.kind !== "changed") return result;
  hub.publish(...result.events);
  if (command === "send_now") {
    dispatcher.cancel(result.cancellation);
    dispatcher.kick(result.message.agentId);
  }
  return result;
}
