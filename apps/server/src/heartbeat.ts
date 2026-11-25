import { randomUUID } from "node:crypto";
import { failureCode } from "@babojubot/contracts";
import { runDueHeartbeats, type Database } from "@babojubot/db";
import { applyAfterCommit, type AfterCommitDeps } from "./after-commit.ts";
import { RerunLoop } from "./rerun-loop.ts";

/**
 * 주입한 시계로 지난 heartbeat를 찾아 깨우기를 남기는 scheduler. 깨우기는 다른 깨우기와 같은 대기열에 들어가고,
 * 실행 시도는 dispatcher의 일반 admission이 만든다. 예정은 DB에 있으므로 서버가 멈췄다 다시 시작해도 이어지며,
 * 그 사이 지난 heartbeat는 한 번으로 합친다. 확인은 `pollMs`마다 하고, 테스트는 시계를 옮긴 뒤 `tick`을 직접 부른다.
 * 한 번에 한 차례만 확인하며, 타이머가 도는 동안 온 신호는 차례마다 하나씩이 아니라 후속 확인 하나로 합친다(RerunLoop가 맡는다).
 * 직접 부른 `tick`은 그 호출 뒤에 시작한 확인이 끝날 때까지 기다린다.
 */
export class HeartbeatScheduler {
  readonly #db: Database;
  readonly #hub: AfterCommitDeps["hub"];
  readonly #dispatcher: AfterCommitDeps["dispatcher"];
  readonly #now: () => Date;
  readonly #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  readonly #loop = new RerunLoop(
    () => this.#check(),
    (error) =>
      console.error(
        `[heartbeat] checking due heartbeats failed (${failureCode(error)})`
      )
  );

  constructor(options: {
    db: Database;
    /** 저장 뒤 할 일(`applyAfterCommit`)에만 넘긴다. */
    hub: AfterCommitDeps["hub"];
    dispatcher: AfterCommitDeps["dispatcher"];
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
    this.#timer = setInterval(() => this.#loop.request(), this.#pollMs);
    this.#timer.unref();
  }

  /**
   * 지금 시각에 지난 heartbeat를 처리하고 깨운 에이전트의 실행 시도를 촉진한다.
   * 진행 중인 확인이 있으면 그 확인 뒤의 후속 확인 하나로 합쳐지고, 그 확인이 끝나기를 기다린다.
   * 실패는 기록만 하며 예정은 DB에 남아 있으므로 다음 확인이 다시 처리한다.
   */
  async tick(): Promise<void> {
    await this.#loop.runNow();
  }

  async #check(): Promise<void> {
    const after = await runDueHeartbeats(this.#db, {
      newId: randomUUID,
      now: this.#now,
    });
    await applyAfterCommit(
      { hub: this.#hub, dispatcher: this.#dispatcher },
      after
    );
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.#loop.close();
  }
}
