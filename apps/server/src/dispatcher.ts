import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  runResultSchema,
  runtimeActivitySchema,
  type RunCancel,
  type RunResult,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import type { RunCancellation } from "@babojubot/core";
import {
  appendRunActivity,
  claimNextRun,
  findRunCancelReason,
  finishRun,
  interruptRun,
  listAgentsWithPendingWakes,
  recoverInterruptedRuns,
  type ClaimedRun,
  type Database,
} from "@babojubot/db";
import type { EventHub } from "./event-hub.ts";
import { assembleRunRequest } from "./run-request.ts";
import { issueRunToken } from "./run-token.ts";

const failed = (error: string): RunResult => ({
  stopReason: "failed",
  error,
  summary: null,
  usage: null,
  nextSession: null,
});
const shutdown: RunCancel = { type: "cancel", reason: "server_shutdown" };
const cancelled: RunResult = {
  ...failed(""),
  stopReason: "cancelled",
  error: null,
};

/**
 * 깨우기를 실행 시도로 만들어 실행기에 맡긴다. admission → 요청 조립(`assembleRunRequest`) → 실행기 호출·취소 → 종료 저장만 한다.
 * 에이전트당 실행 시도 하나는 DB admission(`claimNextRun`)이 보장하고, 이 객체는 같은 프로세스 안에서 에이전트별로 한 줄씩 깨우기를 처리할 뿐이다.
 * 실행 시도가 끝나면 그 사이 쌓인 깨우기를 다음 실행 시도 하나로 묶어 이어서 실행한다.
 */
export class RunDispatcher {
  readonly #db: Database;
  readonly #hub: EventHub;
  readonly #runtime: RuntimeAdapter;
  readonly #now: () => Date;
  readonly #toolsBaseUrl: () => string;
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #kickedAgain = new Set<string>();
  readonly #active = new Map<string, AbortController>();
  /** 저장하지 못한 종료. `server_restart`는 서버 종료로 실행기가 취소되어 돌아온 실행 시도다(`interruptRun`). */
  readonly #pendingFinishes = new Map<
    string,
    { runId: string; result: RunResult | "server_restart" }
  >();
  readonly #recovery = new AbortController();
  #closed = false;

  constructor(options: {
    db: Database;
    hub: EventHub;
    runtime: RuntimeAdapter;
    now: () => Date;
    toolsBaseUrl: () => string;
  }) {
    this.#db = options.db;
    this.#hub = options.hub;
    this.#runtime = options.runtime;
    this.#now = options.now;
    this.#toolsBaseUrl = options.toolsBaseUrl;
  }

  /**
   * 이전 프로세스가 실행 중으로 남긴 실행 시도를 `server_restart`로 끝내 그 깨우기를 다시 대기시키고,
   * 대기 중인 깨우기가 있는 에이전트를 깨운다. 실행기를 부르기 전에 복구를 끝낸다.
   */
  async start(): Promise<void> {
    for (const event of await recoverInterruptedRuns(this.#db, {
      now: this.#now,
    }))
      this.#hub.publish(event);
    for (const agentId of await listAgentsWithPendingWakes(this.#db))
      this.kick(agentId);
  }

  /** 에이전트에게 새 깨우기가 생겼다. 이미 처리 중이면 그 처리가 끝난 뒤 다시 확인한다. */
  kick(agentId: string): void {
    if (this.#closed) return;
    if (this.#pumps.has(agentId)) {
      this.#kickedAgain.add(agentId);
      return;
    }
    const pump = this.#dispatch(agentId).finally(() => {
      this.#pumps.delete(agentId);
      if (this.#kickedAgain.delete(agentId)) this.kick(agentId);
    });
    this.#pumps.set(agentId, pump);
  }

  /**
   * commit된 사용자 제어 취소를 진행 중인 실행기에 보낸다. 실행기가 정리를 끝내 종료가 저장될 때까지 그 에이전트의 다음 실행 시도는 없다.
   * admission과 실행기 등록 사이의 실행 시도는 등록 직후 DB의 취소 요청을 다시 읽어 받는다(`#execute`).
   */
  cancel(cancellation: RunCancellation | null): void {
    for (const runId of cancellation?.runIds ?? [])
      this.#active.get(runId)?.abort({
        type: "cancel",
        reason: cancellation!.reason,
      } satisfies RunCancel);
  }

  /**
   * 조직 재개 뒤, 그 조직에서 대기 중인 깨우기가 있는 에이전트를 모두 깨운다.
   * 호출자는 응답 전에 첫 조회를 기다린다. 그래야 응답 뒤의 관찰(`drain` 등)이 이미 시작한 처리를 본다.
   * 첫 조회가 실패하면 응답은 기다리지 않고, admission과 같은 backoff로 뒤에서 다시 조회한다.
   * 깨우기는 DB에 남아 있으므로 다시 조회해도 실행기를 중복해 부르지 않는다.
   */
  async kickOrganization(organizationId: string): Promise<void> {
    const kickWaiting = async () => {
      for (const agentId of await listAgentsWithPendingWakes(this.#db, {
        organizationId,
      }))
        this.kick(agentId);
    };
    try {
      await kickWaiting();
    } catch (error) {
      console.error("[runs] kicking a resumed organization failed", error);
      void this.#retrying("kicking a resumed organization", kickWaiting);
    }
  }

  /**
   * 깨우기 대기열이 비고 실행 중인 실행 시도가 모두 끝날 때까지 기다린다. 테스트 helper.
   * 다른 프로세스가 실행 중이라 처리할 수 없는 깨우기가 남으면 오래 기다리지 않고 실패한다.
   */
  async drain(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      while (this.#pumps.size) await Promise.all(this.#pumps.values());
      const agents = await listAgentsWithPendingWakes(this.#db);
      if (!agents.length || this.#closed) return;
      for (const agentId of agents) this.kick(agentId);
      if (round) await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("wake queue did not drain");
  }

  /**
   * 새 실행 시도를 받지 않고, 진행 중인 실행 시도를 취소해 실행기가 정리를 끝낼 때까지 기다린다.
   * 취소로 돌아온 실행 시도는 `server_restart`로 끝나고 그 깨우기는 다시 대기해 다음 서버 시작 때 처리된다.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#recovery.abort();
    for (const controller of this.#active.values()) controller.abort(shutdown);
    while (this.#pumps.size) await Promise.all(this.#pumps.values());
  }

  /** DB 오류 후 같은 admission·종료 저장을 다시 시도한다. 실행기를 재실행하지 않는다. */
  #dispatch(agentId: string) {
    return this.#retrying("dispatch", () => this.#pump(agentId));
  }

  /** DB 오류 후 같은 일을 최대 5초 간격으로 성공할 때까지 다시 한다. 서버 종료는 재시도 대기도 즉시 끝낸다. */
  async #retrying(what: string, task: () => Promise<void>) {
    let backoffMs = 100;
    while (!this.#closed) {
      try {
        await task();
        return;
      } catch (error) {
        console.error(`[runs] ${what} failed, retrying`, error);
        if (this.#closed) return;
        try {
          await delay(backoffMs, undefined, { signal: this.#recovery.signal });
        } catch {
          return;
        }
        backoffMs = Math.min(backoffMs * 2, 5_000);
      }
    }
  }

  async #settle(agentId: string) {
    const pending = this.#pendingFinishes.get(agentId);
    if (!pending) return;
    const event = await this.#finish(pending.runId, pending.result);
    this.#pendingFinishes.delete(agentId);
    if (event) this.#hub.publish(event);
  }

  async #pump(agentId: string) {
    while (!this.#closed) {
      // 종료 저장을 끝내기 전에는 새 실행 시도를 claim하거나 실행기를 다시 부르지 않는다.
      await this.#settle(agentId);
      if (this.#closed) return;
      const { token, digest } = issueRunToken();
      const claimed = await claimNextRun(this.#db, agentId, {
        tokenDigest: digest,
        source: { newId: randomUUID, now: this.#now },
      });
      if (!claimed) return;
      this.#hub.publish(claimed.event);
      await this.#execute(claimed, token);
    }
  }

  /** 실행 시도 하나: 요청 조립(`assembleRunRequest`) → 실행기 호출·취소 → 종료 저장. */
  async #execute(claimed: ClaimedRun, token: string) {
    const { run } = claimed;
    const controller = new AbortController();
    this.#active.set(run.id, controller);
    // 닫는 중에 admission이 끝난 실행 시도도 바로 취소를 받는다.
    if (this.#closed) controller.abort(shutdown);
    let result: RunResult;
    try {
      // 등록 전에 commit된 사용자 제어 취소는 `cancel`이 이 controller를 찾지 못했으므로 여기서 받는다.
      const cancelReason = await findRunCancelReason(this.#db, run.id);
      if (cancelReason && !controller.signal.aborted)
        controller.abort({
          type: "cancel",
          reason: cancelReason,
        } satisfies RunCancel);
      const request = await assembleRunRequest(this.#db, claimed, {
        toolsBaseUrl: this.#toolsBaseUrl(),
        token,
      });
      const raw = await this.#runtime.execute(request, {
        signal: controller.signal,
        emit: (activity) => this.#emit(run.id, activity),
      });
      const parsed = runResultSchema.safeParse(raw);
      if (parsed.success) result = parsed.data;
      else {
        console.error(
          "[runs] runtime returned an invalid result",
          parsed.error
        );
        result = failed("실행기가 계약 밖의 종료 결과를 돌려주었습니다.");
      }
    } catch (error) {
      // 실행기 오류 내용은 공개 기록에 그대로 옮기지 않는다.
      console.error(`[runs] run ${run.id} runtime error`, error);
      result = controller.signal.aborted
        ? cancelled
        : failed("실행기가 오류로 끝났습니다.");
    } finally {
      this.#active.delete(run.id);
    }
    const shutDown =
      controller.signal.aborted &&
      (controller.signal.reason as RunCancel | undefined)?.reason ===
        "server_shutdown";
    this.#pendingFinishes.set(run.agentId, {
      runId: run.id,
      // 서버 종료로 끝까지 하지 못한 실행 시도는 받은 깨우기를 다음 실행 시도에 다시 넘긴다. 실행기가 끝을 냈으면 그 결과다.
      result:
        shutDown && result.stopReason === "cancelled"
          ? "server_restart"
          : result,
    });
    await this.#settle(run.agentId);
  }

  /**
   * 종료 결과를 저장한다. 저장이 계속 실패하면 실행 시도가 실행 중으로 남아 에이전트가 막히므로 몇 번 다시 시도한다.
   * 그래도 실패하면 dispatcher가 같은 결과 저장을 backoff 뒤 다시 시도한다.
   * DB 장애가 서버 종료까지 이어지면 다음 시작 때 `recoverInterruptedRuns`가 끝낸다.
   */
  async #finish(runId: string, result: RunResult | "server_restart") {
    const source = { now: this.#now };
    for (let attempt = 1; ; attempt++) {
      try {
        return result === "server_restart"
          ? await interruptRun(this.#db, runId, source)
          : await finishRun(this.#db, runId, result, source);
      } catch (error) {
        if (attempt >= 3) throw error;
        console.error(`[runs] run ${runId} finish failed, retrying`, error);
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
  }

  /** 허용한 공개 활동만 남긴다. 비공개·알 수 없는 값과 종료 뒤의 활동은 버린다. */
  async #emit(runId: string, raw: unknown) {
    const activity = runtimeActivitySchema.safeParse(raw);
    if (!activity.success) {
      console.warn(`[runs] run ${runId} dropped a non-public activity`);
      return;
    }
    const event = await appendRunActivity(this.#db, runId, {
      source: "runtime",
      activity: activity.data,
    });
    if (event) this.#hub.publish(event);
  }
}
