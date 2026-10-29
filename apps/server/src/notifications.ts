import type { NotificationChannel } from "@babojubot/contracts";
import { notificationOf } from "@babojubot/core";
import {
  claimNotifications,
  settleNotification,
  type ClaimedNotification,
  type Database,
} from "@babojubot/db";
import type { EventHub } from "./event-hub.ts";

/**
 * 알림 outbox를 채널로 보낸다. 원본은 outbox이고 Event 알림은 빨리 보내라는 신호일 뿐이라, 서버 시작과 주기 확인이
 * 신호를 놓친 항목(commit 뒤 서버 종료, 전송 실패 뒤 재시도 예정)을 다시 찾는다.
 * 한 번에 한 차례만 돌며, 도는 동안 온 신호는 그 차례가 끝난 뒤 한 번 더 돌게 한다. 채널 전송은 DB transaction 밖이다.
 * 채널이 보낸 앱 메시지 번호를 돌려주면 전송 성공을 적을 때 그 알림에 잇는다(글 답장이 가리키는 알림).
 */
export class NotificationRelay {
  #db: Database;
  #hub: EventHub;
  #channel: NotificationChannel;
  #now: () => Date;
  #pollMs: number;
  #leaseMs: number;
  #running: Promise<void> | null = null;
  #again = false;
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: {
    db: Database;
    hub: EventHub;
    channel: NotificationChannel;
    now: () => Date;
    /** 신호 없이 outbox를 확인하는 간격(ms). 재시도 예정이 지난 항목도 이때 보낸다. */
    pollMs: number;
    /** claim 유지 시간(ms). 이 안에 정산하지 못한 전송은 만료 뒤 다시 보낸다. */
    leaseMs?: number;
  }) {
    this.#db = options.db;
    this.#hub = options.hub;
    this.#channel = options.channel;
    this.#now = options.now;
    this.#pollMs = options.pollMs;
    this.#leaseMs = options.leaseMs ?? 60_000;
  }

  start() {
    this.#unsubscribe = this.#hub.subscribe({ kind: "all" }, (event) => {
      if (notificationOf(event)) this.kick();
    });
    this.#timer = setInterval(() => this.kick(), this.#pollMs);
    this.#timer.unref();
    this.kick();
  }

  kick() {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = this.#pass().finally(() => {
      this.#running = null;
      if (!this.#again) return;
      this.#again = false;
      this.kick();
    });
  }

  /** 지금 보낼 차례인 알림을 모두 보내 볼 때까지 기다린다. 테스트 helper. */
  async flush() {
    this.kick();
    while (this.#running) await this.#running;
  }

  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#unsubscribe?.();
    while (this.#running) await this.#running;
  }

  async #pass() {
    try {
      for (;;) {
        const claimed = await claimNotifications(this.#db, {
          now: this.#now(),
          leaseMs: this.#leaseMs,
          limit: 20,
        });
        if (!claimed.length) return;
        for (const claim of claimed) await this.#deliver(claim);
      }
    } catch (error) {
      // 남은 항목은 outbox에 그대로 있고 다음 신호·주기 확인이 다시 보낸다.
      console.error("[notifications]", error);
    }
  }

  async #deliver(claim: ClaimedNotification) {
    let outcome: Parameters<typeof settleNotification>[2];
    try {
      const sent = await this.#channel.deliver(claim.notification);
      outcome = sent
        ? {
            kind: "sent",
            link: {
              channel: this.#channel.name,
              appMessageId: sent.appMessageId,
            },
          }
        : { kind: "sent" };
    } catch (error) {
      outcome = {
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await settleNotification(this.#db, claim, outcome, this.#now());
  }
}
