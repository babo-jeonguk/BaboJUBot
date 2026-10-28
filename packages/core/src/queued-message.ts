import {
  isClosedStage,
  type ConversationMessage,
  type LifecycleStage,
  type NewEvent,
} from "@babojubot/contracts";
import { planInterrupt, type RunCancellation } from "./control.ts";

// 줄 세운 메시지: 아직 실행 시도가 받지 않은 Lead 대화의 사용자 메시지. 조직·에이전트가 일시정지라 기다리는 메시지도 같다.
// 사용자는 그 메시지를 거두거나(`취소`, 글을 입력창으로 되돌리는 `고치기`) `지금 보내기`로 `중단하고 보내기`로 바꾼다.
// 저장 쪽은 조직 → 에이전트 → 실행 시도 순으로 잠근 뒤 메시지와 그 깨우기를 읽어 여기에 넘긴다. 에이전트 행 잠금이
// admission(`claimNextRun`)과 직렬화하므로, 실행 시도가 먼저 깨우기를 받았으면 여기서 `message_delivered`로 본다.

/** 저장 쪽이 잠금 아래에서 읽은 메시지와 그 깨우기 상태. */
export type QueuedMessageState = Pick<
  ConversationMessage,
  "id" | "organizationId" | "agentId" | "conversationId" | "author" | "delivery"
> & {
  withdrawn: boolean;
  /** 메시지의 깨우기를 받은 실행 시도. 없으면 아직 줄 서 있다. */
  deliveredToRunId: string | null;
};

/**
 * - `not_found`: 같은 조직에 그런 사용자 메시지가 없거나 이미 거두었다(거둔 메시지는 대화에서 빠진다).
 * - `message_delivered`: 실행 시도가 이미 받았다. 받은 메시지는 거두거나 바꿀 수 없다.
 * - `organization_closed`: 최종 완료·중단 조직이다(`지금 보내기`는 중단 제어 명령이라 받지 않는다).
 * - `paused`: 조직이나 받는 에이전트가 일시정지 중이라 지금 보낼 수 없다. 재개하면 줄 선 순서대로 전달된다.
 */
export type QueuedMessageRefusal =
  "not_found" | "message_delivered" | "organization_closed" | "paused";

const queuedRefusal = (
  message: QueuedMessageState | undefined
): "not_found" | "message_delivered" | null => {
  if (!message || message.author !== "owner" || message.withdrawn)
    return "not_found";
  if (message.deliveredToRunId) return "message_delivered";
  return null;
};

/**
 * 줄 세운 메시지 거두기. 메시지는 지우지 않고 거둔 시각을 남기며, 그 깨우기는 지워 더는 실행 시도를 시작하지 않는다.
 * 일시정지 중에도, 끝난 조직에서도 거둘 수 있다(끝난 조직에서도 줄 세우기는 받으므로).
 */
export function planWithdrawal(
  message: QueuedMessageState | undefined
):
  | { event: NewEvent; message: QueuedMessageState }
  | "not_found"
  | "message_delivered" {
  const refused = queuedRefusal(message);
  if (refused) return refused;
  const m = message!;
  return {
    message: m,
    event: {
      organizationId: m.organizationId,
      type: "message.withdrawn",
      payload: {
        by: "owner",
        messageId: m.id,
        agentId: m.agentId,
        conversationId: m.conversationId,
      },
    },
  };
}

/**
 * 줄 세운 메시지 `지금 보내기`. 그 메시지의 전달 방식을 `중단하고 보내기`로 바꾸고 받는 에이전트의 진행 중 실행 시도를 취소한다.
 * 다음 실행 시도는 그 메시지(와 다른 `중단하고 보내기` 메시지)만 받고, 나머지 줄 세운 메시지는 그 뒤에 받는다(`bundleWakes`).
 * 실행 중이 아니면 취소할 것 없이 전달 방식만 바뀌어 다음 실행 시도에서 먼저 받는다.
 */
export function planSendNow(
  message: QueuedMessageState | undefined,
  state: {
    stage: LifecycleStage;
    agentPaused: boolean;
    runningRunId: string | null;
  }
):
  | { cancellation: RunCancellation | null; events: NewEvent[] }
  | QueuedMessageRefusal {
  if (queuedRefusal(message) === "not_found") return "not_found";
  if (isClosedStage(state.stage)) return "organization_closed";
  if (message!.deliveredToRunId) return "message_delivered";
  if (state.stage === "paused" || state.agentPaused) return "paused";
  const m = message!;
  const interrupt = planInterrupt(m, state.stage, state.runningRunId);
  if (interrupt === "organization_closed") return interrupt;
  return {
    cancellation: interrupt.cancellation,
    events: [
      {
        organizationId: m.organizationId,
        type: "message.sent_now",
        payload: {
          by: "owner",
          messageId: m.id,
          agentId: m.agentId,
          conversationId: m.conversationId,
        },
      },
      interrupt.event,
    ],
  };
}
