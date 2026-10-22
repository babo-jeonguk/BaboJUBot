import { randomUUID } from "node:crypto";
import type { AgentDetail, UpdateHeartbeatInput } from "@babojubot/contracts";
import {
  findAgentDetail,
  runDueHeartbeats,
  updateHeartbeat as storeHeartbeat,
  type Database,
} from "@babojubot/db";
import type { RunDispatcher } from "./dispatcher.ts";
import type { EventHub } from "./event-hub.ts";

/**
 * 주입한 시계로 지난 heartbeat를 찾아 깨우기를 남기는 scheduler. 깨우기는 다른 깨우기와 같은 대기열에 들어가고,
 * 실행 시도는 dispatcher의 일반 admission이 만든다. 예정은 DB에 있으므로 서버가 멈췄다 다시 시작해도 이어지며,
 * 그 사이 지난 heartbeat는 한 번으로 합친다. 확인은 `pollMs`마다 하고, 테스트는 시계를 옮긴 뒤 `tick`을 직접 부른다.
 */
export class HeartbeatScheduler {
  readonly #db: Database;
  readonly #hub: EventHub;
  readonly #dispatcher: RunDispatcher;
  readonly #now: () => Date;
  readonly #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
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
    this.#timer = setInterval(() => void this.tick(), this.#pollMs);
    this.#timer.unref();
  }

  /**
   * 지금 시각에 지난 heartbeat를 처리하고 깨운 에이전트의 실행 시도를 촉진한다. 겹쳐 부르면 진행 중인 확인이 끝난 뒤 한 번 더 한다.
   * 실패는 기록만 하며 예정은 DB에 남아 있으므로 다음 확인이 다시 처리한다.
   */
  async tick(): Promise<void> {
    while (this.#running) await this.#running;
    if (this.#closed) return;
    this.#running = (async () => {
      try {
        const { events, woken } = await runDueHeartbeats(this.#db, {
          newId: randomUUID,
          now: this.#now,
        });
        this.#hub.publish(...events);
        for (const agentId of woken) this.#dispatcher.kick(agentId);
      } catch (error) {
        console.error("[heartbeat] checking due heartbeats failed", error);
      }
    })();
    try {
      await this.#running;
    } finally {
      this.#running = undefined;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    while (this.#running) await this.#running;
  }
}

type Deps = { db: Database; hub: EventHub; now: () => Date };

/** 사용자의 heartbeat 설정 변경. 저장한 뒤에만 알리고, 돌려주는 값은 변경 뒤의 에이전트 상세다. */
export async function updateHeartbeat(
  { db, hub, now }: Deps,
  organizationId: string,
  agentId: string,
  input: UpdateHeartbeatInput
): Promise<
  | { kind: "ok"; agent: AgentDetail }
  | { kind: "not_found" }
  | { kind: "organization_closed" }
> {
  const result = await storeHeartbeat(db, organizationId, agentId, input, {
    now,
  });
  if (result.kind === "not_found" || result.kind === "organization_closed")
    return result;
  if (result.kind === "changed") hub.publish(result.event);
  const agent = await findAgentDetail(db, organizationId, agentId);
  return agent ? { kind: "ok", agent } : { kind: "not_found" };
}
