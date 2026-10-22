import type { Event, StreamScope } from "@babojubot/contracts";

type Listener = (event: Event) => void;

/**
 * 저장이 끝난 Event를 프로세스 안의 구독자에게 알린다. 원본은 Event log이고 이것은 알림일 뿐이라,
 * 구독 전이나 끊긴 사이의 Event는 화면이 다시 조회해 맞춘다.
 */
export class EventHub {
  #subscribers = new Set<{ scope: StreamScope; listener: Listener }>();

  subscribe(scope: StreamScope, listener: Listener): () => void {
    const entry = { scope, listener };
    this.#subscribers.add(entry);
    return () => this.#subscribers.delete(entry);
  }

  /**
   * commit 뒤 받은 순서대로 알린다. 구독자 오류는 여기서 잡아 남기고 던지지 않으므로,
   * 호출자는 감싸지 않고 부르며 알림 실패가 이미 저장된 명령·도구 호출의 결과를 바꾸지 않는다.
   */
  publish(...events: Event[]): void {
    for (const event of events)
      for (const { scope, listener } of this.#subscribers) {
        if (
          scope.kind === "organization" &&
          scope.organizationId !== event.organizationId
        )
          continue;
        try {
          listener(event);
        } catch (error) {
          console.error("[event-hub] subscriber failed", error);
        }
      }
  }
}
