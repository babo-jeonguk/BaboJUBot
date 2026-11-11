import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentRecoveryBlockReason,
  isolateUsageNumbers,
  runResultSchema,
  runtimeActivitySchema,
  type RunCancel,
  type RunResult,
  type RuntimeAdapter,
  type SteerMessage,
  type SteerOutcome,
} from "@babojubot/contracts";
import type { RunCancellation } from "@babojubot/core";
import {
  appendRunActivity,
  blockRunRecovery,
  claimNextRun,
  findActiveRun,
  listIntentsToSettle,
  loadRunWakeReasons,
  resolveAgentRecovery,
  findRunCancelReason,
  finishRun,
  interruptRun,
  listAgentsWithPendingWakes,
  recoverInterruptedRuns,
  type AfterCommit,
  type ClaimedRun,
  type Database,
} from "@babojubot/db";
import { applyAfterCommit } from "./after-commit.ts";
import type { EventHub } from "./event-hub.ts";
import { IsolationError } from "./isolation.ts";
import type { RunRequestAssembler } from "./run-request.ts";
import { issueRunToken } from "./run-token.ts";
import type { IntentSettler } from "./tools.ts";
import { WorkspaceIdentityError } from "./workspace.ts";

const failed = (error: string): RunResult => ({
  stopReason: "failed",
  error,
  summary: null,
  usage: null,
  nextSession: null,
});
/** 에이전트의 연결이 이 서버에 등록되지 않았다(서버를 다른 연결 목록으로 다시 띄움). 다른 연결로 대신 돌리지 않는다. */
const missingProvider = failed(
  "이 실행 시도의 프로바이더 연결이 서버에 없습니다."
);
const shutdown: RunCancel = { type: "cancel", reason: "server_shutdown" };
/** 한 실행 시도 안에서 실행 의도 복구 정산의 일시적 오류를 다시 시도하는 횟수(첫 시도 포함). */
const recoveryAttempts = 3;
/** 실행 시도의 종료: 프로바이더 결과, 서버 종료로 돌아온 실행 시도, 복구 정산이 막힌 실행 시도. */
type Ending =
  RunResult | "server_restart" | { recoveryBlocked: AgentRecoveryBlockReason };
/** 복구 정산 중 사용자 제어가 실행 시도를 취소했다. 모델을 부르지 않고 취소로 끝난다. */
class RecoveryCancelled extends Error {}
const cancelled: RunResult = {
  ...failed(""),
  stopReason: "cancelled",
  error: null,
};

/**
 * 깨우기를 실행 시도로 만들어 프로바이더에 맡긴다. admission → 요청 조립(`createRunRequestAssembler`) → 프로바이더 호출·취소 → 종료 저장만 한다.
 * 에이전트당 실행 시도 하나와 프로바이더 연결별 동시 실행 상한은 DB admission(`claimNextRun`)이 보장하고, 이 객체는 같은 프로세스 안에서
 * 에이전트별로 한 줄씩 깨우기를 처리할 뿐이다. 실행 시도는 admission이 고정한 연결의 adapter가 맡는다.
 * 실행 시도가 끝나면 그 사이 쌓인 깨우기를 다음 실행 시도 하나로 묶어 이어서 실행한다. 종료 저장이 돌려준 commit 뒤 할 일
 * (Event 알리기·같은 연결의 자리를 기다리던 에이전트 촉진)은 다른 저장과 같은 `applyAfterCommit`이 한다.
 */
export class RunDispatcher {
  readonly #db: Database;
  readonly #hub: EventHub;
  readonly #providers: ReadonlyMap<string, RuntimeAdapter>;
  readonly #now: () => Date;
  readonly #assemble: RunRequestAssembler;
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #kickedAgain = new Set<string>();
  /** 진행 중인 실행 시도와 그 연결의 adapter. 끼워 넣기는 여기 있는 실행 시도에만 간다. */
  readonly #active = new Map<
    string,
    { controller: AbortController; adapter: RuntimeAdapter | undefined }
  >();
  readonly #onLoginRequired: (provider: string) => void;
  /**
   * 저장하지 못한 종료. `server_restart`는 서버 종료로 프로바이더가 취소되어 돌아온 실행 시도다(`interruptRun`).
   * `recoveryBlocked`는 모델을 부르기 전의 실행 의도 정산이 막힌 실행 시도다(`blockRunRecovery`).
   */
  readonly #pendingFinishes = new Map<
    string,
    { runId: string; result: Ending }
  >();
  readonly #settleIntent: IntentSettler | undefined;
  readonly #recovery = new AbortController();
  #closed = false;
  /** 서버 시작 복구(`start`)의 저장이 모두 끝났다. 그 전의 촉진은 버리고, 복구가 끝난 뒤 대기 깨우기를 모두 다시 읽어 촉진한다. */
  #recovered = false;

  constructor(options: {
    db: Database;
    hub: EventHub;
    /** 프로바이더 연결 ID → adapter. */
    providers: ReadonlyMap<string, RuntimeAdapter>;
    now: () => Date;
    /** 실행 시도 요청 조립(`createRunRequestAssembler`). */
    assemble: RunRequestAssembler;
    /** 실행 시도가 제품 로그인이 필요해 실패로 끝났다(`errorCode` `login_required`). 종료를 저장한 뒤 부른다. */
    onLoginRequired?: (provider: string) => void;
    /** 서버 재시작으로 남은 실행 의도 하나를 새 실행 시도로 정산한다(`orgToolsRouter`의 `settle`). 없으면 정산할 의도가 있을 때 막는다. */
    settleIntent?: IntentSettler;
  }) {
    this.#settleIntent = options.settleIntent;
    this.#db = options.db;
    this.#hub = options.hub;
    this.#providers = options.providers;
    this.#now = options.now;
    this.#assemble = options.assemble;
    this.#onLoginRequired = options.onLoginRequired ?? (() => {});
  }

  /**
   * 이전 프로세스가 실행 중으로 남긴 실행 시도를 `server_restart`로 끝내 그 깨우기를 다시 대기시키고,
   * 대기 중인 깨우기가 있는 에이전트를 깨운다. 모든 복구 저장이 성공한 뒤에야 모은 commit 뒤 할 일(Event 알리기·촉진)을 하므로,
   * 복구가 끝나기 전에는 이 경로든 사용자 요청 같은 다른 경로든 실행 시도를 시작하지 않는다. 복구 저장이 실패하면 던지고 촉진하지 않는다.
   */
  async start(): Promise<void> {
    const recovered = await recoverInterruptedRuns(this.#db, {
      now: this.#now,
    });
    this.#recovered = true;
    await this.#afterCommit(recovered);
    for (const agentId of await listAgentsWithPendingWakes(this.#db))
      this.kick(agentId);
  }

  /**
   * 에이전트에게 새 깨우기가 생겼다. 이미 처리 중이면 그 처리가 끝난 뒤 다시 확인한다.
   * 서버 시작 복구가 끝나기 전이면 아무것도 하지 않는다. 깨우기는 DB에 있고 복구가 끝나면 `start`가 모두 다시 읽는다.
   */
  kick(agentId: string): void {
    if (this.#closed || !this.#recovered) return;
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
   * commit된 사용자 제어 취소를 진행 중인 프로바이더에 보낸다. 프로바이더가 정리를 끝내 종료가 저장될 때까지 그 에이전트의 다음 실행 시도는 없다.
   * admission과 프로바이더 등록 사이의 실행 시도는 등록 직후 DB의 취소 요청을 다시 읽어 받는다(`#execute`).
   */
  cancel(cancellation: RunCancellation | null): void {
    for (const runId of cancellation?.runIds ?? [])
      this.#active.get(runId)?.controller.abort({
        type: "cancel",
        reason: cancellation!.reason,
      } satisfies RunCancel);
  }

  /**
   * 진행 중인 실행 시도에 사용자 메시지를 끼워 넣는다. 그 실행 시도를 맡은 adapter가 받았다고 확인해야 `accepted`이고,
   * 이 프로세스에서 진행 중이 아니거나(아직 등록 전·이미 끝남·취소됨) adapter가 거절하면 `rejected`다.
   * 통신 오류는 거절로 처리한다. 실제로 전달됐으나 응답을 잃은 경우는 감수한다(#98).
   */
  async steer(message: SteerMessage): Promise<SteerOutcome> {
    const active = this.#active.get(message.runId);
    if (!active?.adapter?.steer || active.controller.signal.aborted)
      return "rejected";
    try {
      return (await active.adapter.steer(message)) === "accepted"
        ? "accepted"
        : "rejected";
    } catch (error) {
      console.error(`[runs] run ${message.runId} steer failed`, error);
      return "rejected";
    }
  }

  /**
   * 조직 재개 뒤, 그 조직에서 대기 중인 깨우기가 있는 에이전트를 모두 깨운다.
   * 호출자는 응답 전에 첫 조회를 기다린다. 그래야 응답 뒤의 관찰(`drain` 등)이 이미 시작한 처리를 본다.
   * 첫 조회가 실패하면 응답은 기다리지 않고, admission과 같은 backoff로 뒤에서 다시 조회한다.
   * 깨우기는 DB에 남아 있으므로 다시 조회해도 프로바이더를 중복해 부르지 않는다.
   */
  kickOrganization(organizationId: string): Promise<void> {
    return this.#kickWaiting("a resumed organization", { organizationId });
  }

  /**
   * 프로바이더 연결에 자리가 났다(실행 시도 종료, 상한 변경). 그 연결의 대기 깨우기가 있는 에이전트를 가장 오래 기다린 쪽부터 깨운다.
   * 자리를 누가 얻을지는 admission의 연결 잠금이 정하며, 기다린 순서를 보장하지 않는다. 실패하면 `kickOrganization`처럼 뒤에서 다시 조회한다.
   */
  kickProvider(provider: string): Promise<void> {
    return this.#kickWaiting("agents waiting for a provider", { provider });
  }

  async #kickWaiting(
    what: string,
    filter: { organizationId?: string; provider?: string }
  ) {
    const kickWaiting = async () => {
      for (const agentId of await listAgentsWithPendingWakes(this.#db, filter))
        this.kick(agentId);
    };
    try {
      await kickWaiting();
    } catch (error) {
      console.error(`[runs] kicking ${what} failed`, error);
      void this.#retrying(`kicking ${what}`, kickWaiting);
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
   * 새 실행 시도를 받지 않고, 진행 중인 실행 시도를 취소해 프로바이더가 정리를 끝낼 때까지 기다린다.
   * 취소로 돌아온 실행 시도는 `server_restart`로 끝나고 그 깨우기는 다시 대기해 다음 서버 시작 때 처리된다.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#recovery.abort();
    for (const { controller } of this.#active.values())
      controller.abort(shutdown);
    while (this.#pumps.size) await Promise.all(this.#pumps.values());
  }

  /** DB 오류 후 같은 admission·종료 저장을 다시 시도한다. 프로바이더를 재실행하지 않는다. */
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

  /**
   * 저장하지 못한 종료를 저장하고 commit 뒤 할 일을 한다. 저장이 실패하면 같은 결과로 다시 저장하며(`#retrying`) 프로바이더를 다시 부르지 않는다.
   * commit됐지만 응답을 잃었으면 다시 저장할 때 이미 끝난 실행 시도라 기록은 그대로이고, 자리 촉진만 다시 받는다.
   * commit 뒤 할 일의 실패는 저장 실패가 아니다(`applyAfterCommit`가 남기고 계속한다). 촉진은 첫 조회까지만 기다리므로
   * 이 에이전트 자신을 다시 촉진해도 그 처리가 끝나기를 기다리지 않는다.
   */
  async #settle(agentId: string) {
    const pending = this.#pendingFinishes.get(agentId);
    if (!pending) return;
    const ended = await this.#finish(pending.runId, pending.result);
    this.#pendingFinishes.delete(agentId);
    if (ended.kind === "ok") await this.#afterCommit(ended.after);
  }

  /** 종료·복구 저장의 commit 뒤 할 일. 다른 저장과 같은 순서·실패 처리를 쓴다. */
  #afterCommit(after: AfterCommit) {
    return applyAfterCommit({ hub: this.#hub, dispatcher: this }, after);
  }

  async #pump(agentId: string) {
    while (!this.#closed) {
      // 종료 저장을 끝내기 전에는 새 실행 시도를 claim하거나 프로바이더를 다시 부르지 않는다.
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

  /** 실행 시도 하나: 요청 조립(`createRunRequestAssembler`) → 프로바이더 호출·취소 → 종료 저장. */
  async #execute(claimed: ClaimedRun, token: string) {
    const { run } = claimed;
    const controller = new AbortController();
    const adapter = this.#providers.get(run.provider);
    this.#active.set(run.id, { controller, adapter });
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
      // 서버 재시작으로 남은 실행 의도를 모델보다 먼저 정산하고, 그 결과를 실은 깨우기 사유로 요청을 만든다.
      const recovered = await this.#recoverIntents(claimed, controller.signal);
      if (recovered.kind === "blocked") {
        this.#active.delete(run.id);
        this.#pendingFinishes.set(run.agentId, {
          runId: run.id,
          result: { recoveryBlocked: recovered.reason },
        });
        await this.#settle(run.agentId);
        return;
      }
      if (recovered.kind === "run_finished") throw new RecoveryCancelled();
      const request = await this.#assemble(
        { ...claimed, wakeReasons: recovered.wakeReasons },
        token
      );
      const raw = adapter
        ? await adapter.execute(request, {
            signal: controller.signal,
            emit: (activity) => this.#emit(run.id, activity),
          })
        : missingProvider;
      const parsed = runResultSchema.safeParse(isolateRunUsage(run.id, raw));
      if (parsed.success) result = parsed.data;
      else {
        console.error(
          "[runs] runtime returned an invalid result",
          parsed.error
        );
        result = failed("프로바이더가 계약 밖의 종료 결과를 돌려주었습니다.");
      }
    } catch (error) {
      // 프로바이더 오류 내용은 공개 기록에 그대로 옮기지 않는다. 조직 폴더 확인 실패는 제품이 쓴 안내라 그대로 보인다.
      console.error(`[runs] run ${run.id} runtime error`, error);
      result =
        controller.signal.aborted || error instanceof RecoveryCancelled
          ? cancelled
          : error instanceof WorkspaceIdentityError ||
              error instanceof IsolationError
            ? failed(error.message)
            : failed("프로바이더가 오류로 끝났습니다.");
    } finally {
      this.#active.delete(run.id);
    }
    const shutDown =
      controller.signal.aborted &&
      (controller.signal.reason as RunCancel | undefined)?.reason ===
        "server_shutdown";
    this.#pendingFinishes.set(run.agentId, {
      runId: run.id,
      // 서버 종료로 끝까지 하지 못한 실행 시도는 받은 깨우기를 다음 실행 시도에 다시 넘긴다. 프로바이더가 끝을 냈으면 그 결과다.
      result:
        shutDown && result.stopReason === "cancelled"
          ? "server_restart"
          : result,
    });
    await this.#settle(run.agentId);
    if (result.stopReason === "failed" && result.errorCode === "login_required")
      this.#onLoginRequired(run.provider);
  }

  /**
   * 실행 시도가 받은 실행 의도 복구 깨우기의 남은 의도를 모델을 부르기 전에 정산한다(`settleIntent`). 정산한 결과는 깨우기 사유에 실려
   * 모델이 받는 맥락이 된다. 같은 실행 시도 안에서 일시적 오류는 {@link recoveryAttempts}번까지 다시 시도하고, 그래도 실패하거나
   * 원본 자료가 없거나 기록이 맞지 않으면 `blocked`다. 사용자 제어가 그사이 취소했으면 `run_finished`다.
   * 정산에 성공하고 에이전트가 사용자가 고른 복구 재시도 중이면 막힘을 푼다.
   */
  async #recoverIntents(
    claimed: ClaimedRun,
    signal: AbortSignal
  ): Promise<
    | { kind: "ok"; wakeReasons: ClaimedRun["wakeReasons"] }
    | { kind: "run_finished" }
    | { kind: "blocked"; reason: AgentRecoveryBlockReason }
  > {
    const { run } = claimed;
    if (!claimed.wakeReasons.some((r) => r.kind === "intent_recovery"))
      return { kind: "ok", wakeReasons: claimed.wakeReasons };
    for (let attempt = 1; ; attempt++) {
      try {
        const listed = await listIntentsToSettle(this.#db, run);
        if (listed.kind === "blocked") return listed;
        if (listed.intents.length) {
          if (!this.#settleIntent)
            return { kind: "blocked", reason: "inconsistent_record" };
          void this.#emit(run.id, {
            type: "progress",
            text: `서버 재시작으로 남은 실행 의도 ${listed.intents.length}개를 모델보다 먼저 정산합니다.`,
          });
        }
        for (const intent of listed.intents) {
          const active =
            !signal.aborted && (await findActiveRun(this.#db, run.id));
          if (!active) return { kind: "run_finished" };
          const settled = await this.#settleIntent!(intent, active);
          if (settled.kind !== "settled") return settled;
        }
        break;
      } catch (error) {
        console.error(
          `[runs] run ${run.id} intent recovery failed (attempt ${attempt})`,
          error
        );
        if (attempt >= recoveryAttempts)
          return { kind: "blocked", reason: "retry_exhausted" };
        try {
          await delay(100 * 2 ** attempt, undefined, { signal });
        } catch {
          return { kind: "run_finished" };
        }
      }
    }
    await this.#afterCommit(await resolveAgentRecovery(this.#db, run));
    const current = new Map(
      (await loadRunWakeReasons(this.#db, run.id)).map((r) => [r.wakeId, r])
    );
    return {
      kind: "ok",
      wakeReasons: claimed.wakeReasons.map((r) => current.get(r.wakeId) ?? r),
    };
  }

  /**
   * 종료 결과를 저장한다. 저장이 계속 실패하면 실행 시도가 실행 중으로 남아 에이전트가 막히므로 몇 번 다시 시도한다.
   * 그래도 실패하면 dispatcher가 같은 결과 저장을 backoff 뒤 다시 시도한다.
   * DB 장애가 서버 종료까지 이어지면 다음 시작 때 `recoverInterruptedRuns`가 끝낸다.
   */
  async #finish(runId: string, result: Ending) {
    const source = { now: this.#now };
    for (let attempt = 1; ; attempt++) {
      try {
        return result === "server_restart"
          ? await interruptRun(this.#db, runId, source)
          : "recoveryBlocked" in result
            ? await blockRunRecovery(
                this.#db,
                runId,
                result.recoveryBlocked,
                source
              )
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
    // 활동 기록이 실패해도 실행 시도는 계속한다.
    try {
      const event = await appendRunActivity(this.#db, runId, {
        source: "runtime",
        activity: activity.data,
      });
      if (event) this.#hub.publish(event);
    } catch (error) {
      console.error(`[runs] run ${runId} could not record an activity`, error);
    }
  }
}

/**
 * 사용량 숫자의 이상은 그 항목만 비우고 진단으로 남겨 실행 시도의 종료 사유·요약·다음 세션을 지킨다(#140).
 * 나머지 종료 결과는 그대로 넘기므로 다른 계약 위반은 schema 검사가 거부한다.
 */
function isolateRunUsage(runId: string, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !("usage" in raw)) return raw;
  const { value, anomalies } = isolateUsageNumbers(raw.usage);
  for (const { field, reason } of anomalies)
    console.warn(
      `[runs] run ${runId} usage ${field} left unreported: ${reason}`
    );
  return anomalies.length ? { ...raw, usage: value } : raw;
}
