import { randomUUID } from "node:crypto";
import { runDueHeartbeats, type Database } from "@babojubot/db";
import { applyAfterCommit } from "./after-commit.ts";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * 주입한 시계로 지난 heartbeat를 찾아 깨우기를 남기는 scheduler. 깨우기는 다른 깨우기와 같은 대기열에 들어가고,
 * 실행 시도는 dispatcher의 일반 admission이 만든다. 예정은 DB에 있으므로 서버가 멈췄다 다시 시작해도 이어지며,
 * 그 사이 지난 heartbeat는 한 번으로 합친다. 확인은 `pollMs`마다 하고, 테스트는 시계를 옮긴 뒤 `tick`을 직접 부른다.
 * 한 번에 한 차례만 확인하며, 타이머가 도는 동안 온 신호는 차례마다 하나씩이 아니라 후속 확인 하나로 합친다.
 * 직접 부른 `tick`은 그 호출 뒤에 시작한 확인이 끝날 때까지 기다린다.
 */
export class HeartbeatScheduler {
  readonly #db: Database;
  readonly #hub: EventHub;
  readonly #dispatcher: RunDispatcher;
  readonly #now: () => Date;
  readonly #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;

  constructor(options: {
    db: Database;
    hub: EventHub;
    dispatcher: RunDispatcher;
    now: () => Date;
    pollMs: number;
  }) {
    this.#db = options.db;
    this.#hub = options.hub;
    this.#dispatcher = options.dispatcher;
    this.#now = options.now;
    this.#pollMs = options.pollMs;
  }

  /** 실행 중 실행 시도 복구가 끝난 뒤 부른다. */
  start(): void {
    this.#timer = setInterval(() => this.#kick(), this.#pollMs);
    this.#timer.unref();
  }

  /**
   * 지금 시각에 지난 heartbeat를 처리하고 깨운 에이전트의 실행 시도를 촉진한다.
   * 진행 중인 확인이 있으면 그 확인 뒤의 후속 확인 하나로 합쳐지고, 그 확인이 끝나기를 기다린다.
   * 실패는 기록만 하며 예정은 DB에 남아 있으므로 다음 확인이 다시 처리한다.
   */
  async tick(): Promise<void> {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      await this.#running; // 이 확인의 finally가 후속 확인을 이미 시작했다.
    } else this.#kick();
    await this.#running;
  }

  #kick(): void {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = this.#check().finally(() => {
      this.#running = undefined;
      if (!this.#again) return;
      this.#again = false;
      this.#kick();
    });
  }

  async #check(): Promise<void> {
    try {
      const after = await runDueHeartbeats(this.#db, {
        newId: randomUUID,
        now: this.#now,
      });
      await applyAfterCommit(
        { hub: this.#hub, dispatcher: this.#dispatcher },
        after
      );
    } catch (error) {
      console.error("[heartbeat] checking due heartbeats failed", error);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    while (this.#running) await this.#running;
  }
}
