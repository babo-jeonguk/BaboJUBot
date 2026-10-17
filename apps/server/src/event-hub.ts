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

  publish(event: Event): void {
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
