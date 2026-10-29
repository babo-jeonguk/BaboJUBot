import { maxQueuedMessages } from "./message.ts";
import { isClosedStage, type LifecycleStage } from "./organization.ts";

// Lead 대화의 사용자 행동 판정. 서버(core 거부 규칙)와 웹 입력창이 같은 판정을 쓴다.
// 서버는 받는가(받지 않으면 그 이유)를, 화면은 거기에 더해 지금 상태에서 그 버튼을 보이는가를 본다.
// 메시지 하나의 상태(없음·이미 전달됨)는 여기서 보지 않는다. 그건 core가 잠금 아래 읽은 메시지로 정한다.

/**
 * 입력창의 `보내기`(`send`)·`줄 세우기`(`queue`)·`중단하고 보내기`(`interrupt_send`)·`실행 중단`(`stop_run`)과
 * 줄 세운 메시지의 `고치기`(`edit`)·`취소`(`withdraw`)·`지금 보내기`(`send_now`).
 */
export type OwnerAction =
  | "send"
  | "queue"
  | "interrupt_send"
  | "stop_run"
  | "edit"
  | "withdraw"
  | "send_now";

export type NewMessageAction = "send" | "queue" | "interrupt_send";
export type QueuedMessageAction = "edit" | "withdraw" | "send_now";

/**
 * - `organization_closed`: 최종 완료·중단 조직이다. 줄 세운 메시지는 거두기만 된다.
 * - `queue_full`: Lead에게 이미 상한(`maxQueuedMessages`, 모든 대화)만큼 줄 서 있다. 새 메시지만 받지 않는다.
 */
export type OwnerActionRefusal = "organization_closed" | "queue_full";

/**
 * 새 사용자 메시지를 받지 않는 이유. 전달 방식(`보내기`·`줄 세우기`는 `next_run`, `중단하고 보내기`는 `interrupt`)과
 * 상관없이 같다. 일시정지 중에도 받아 두고 재개 뒤 전달한다. 서버의 `queuedCount`는 조직 → 에이전트 잠금 아래에서 센 수다.
 */
export function newMessageRefusal(state: {
  stage: LifecycleStage;
  queuedCount: number;
}): "organization_closed" | "queue_full" | null {
  if (isClosedStage(state.stage)) return "organization_closed";
  if (state.queuedCount >= maxQueuedMessages) return "queue_full";
  return null;
}

/**
 * 줄 세운 메시지 명령을 받지 않는 이유. 끝난 조직에서는 거두기만 된다(끝나기 전에 줄 세운 메시지가 남아 있을 수 있으므로).
 * 일시정지 중에도 고치기·거두기·지금 보내기 모두 된다. 일시정지 중 `지금 보내기`는 취소할 실행 시도 없이 전달 방식만
 * `중단하고 보내기`로 바꿔 재개 뒤 먼저 전달된다(새 메시지의 `중단하고 보내기`와 같은 결과).
 */
export function queuedMessageRefusal(
  action: QueuedMessageAction,
  state: { stage: LifecycleStage }
): "organization_closed" | null {
  if (action !== "withdraw" && isClosedStage(state.stage))
    return "organization_closed";
  return null;
}

/**
 * Lead의 실행 상태. `cancelling`은 진행 중이지만 이미 취소를 요청받아 정리 중인 실행 시도다.
 * 화면은 취소 정리 중을 실행 중으로 치지 않는다(`보내기` 하나).
 */
export type LeadRunState = "idle" | "running" | "cancelling";

export type OwnerActionState = {
  stage: LifecycleStage;
  leadPaused: boolean;
  run: LeadRunState;
  queuedCount: number;
};

/** 행동 하나의 판정. `refusal`이 있으면 서버가 받지 않는다. 보이지만 받지 않는 버튼은 화면이 비활성으로 둔다. */
export type OwnerActionVerdict = {
  visible: boolean;
  refusal: OwnerActionRefusal | null;
};

export type OwnerActionsDecision = {
  /** 메시지가 지금 Lead를 깨우지 못하는 이유. 메시지는 남아 재개 뒤 전달된다. */
  heldBy: "organization_paused" | "lead_paused" | null;
  /** `stop_run`의 서버 거부는 제어 명령 규칙(core `planAgentControl`)이 정하므로 보이는가만 낸다. */
  actions: Record<Exclude<OwnerAction, "stop_run">, OwnerActionVerdict> & {
    stop_run: { visible: boolean };
  };
};

/**
 * 지금 상태에서 사용자 행동마다 서버가 받는가와 화면에 보이는가. 끝난 조직은 입력창이 없고 줄 세운 메시지의 `취소`만 보인다.
 * 실행 중이 아니면 `보내기` 하나, 실행 중이면 `실행 중단`(입력이 빌 때) 또는 `중단하고 보내기`·`줄 세우기`(입력이 있을 때)다.
 * 입력이 비었는가는 화면이 고른다. `지금 보내기`는 Lead가 실행 중이거나 조직·Lead가 일시정지 중일 때 보인다(일시정지 중이면
 * 재개 뒤 먼저 전달된다). 일시정지 중 입력창은 `보내기` 하나다.
 * 보이는 버튼을 서버가 받지 않는 것은 줄이 가득 찬 새 메시지뿐이며, 화면은 그 버튼을 비활성으로 둔다.
 */
export function ownerActions(state: OwnerActionState): OwnerActionsDecision {
  const closed = isClosedStage(state.stage);
  const heldBy =
    state.stage === "paused"
      ? "organization_paused"
      : state.leadPaused
        ? "lead_paused"
        : null;
  const running = !closed && state.run === "running";
  const newMessage = newMessageRefusal(state);
  const queued = (action: QueuedMessageAction) =>
    queuedMessageRefusal(action, state);
  return {
    heldBy,
    actions: {
      send: { visible: !closed && !running, refusal: newMessage },
      queue: { visible: running, refusal: newMessage },
      interrupt_send: { visible: running, refusal: newMessage },
      stop_run: { visible: running },
      edit: { visible: !closed, refusal: queued("edit") },
      withdraw: { visible: true, refusal: queued("withdraw") },
      send_now: {
        visible: !closed && (running || heldBy !== null),
        refusal: queued("send_now"),
      },
    },
  };
}
