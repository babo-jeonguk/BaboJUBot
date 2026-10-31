import {
  providerReadinessCheckSchema,
  type ProviderConnection,
  type ProviderReadinessCheck,
} from "@babojubot/contracts";
import type { EventHub } from "./event-hub.ts";

/**
 * 프로바이더 연결의 준비 확인(#96). 모델을 부르지 않는 연결의 확인(`checkReadiness`)을 돌려 결과와 시각을 저장하고,
 * 확인을 시작할 때와 끝낼 때 전역 설정 변경 신호를 보내 화면이 확인 중 표시와 결과를 다시 불러오게 한다.
 * 확인하는 때는 서버 시작·전역 설정 화면 열기·`다시 확인`·로그인 오류로 끝난 실행 시도 뒤이며, 실행 시도의 admission은 확인을
 * 기다리지 않고 결과도 보지 않는다. 준비안됨이어도 다른 연결로 대신 돌리지 않는다.
 * 같은 연결의 확인이 겹치면 마지막에 시작한 확인의 결과만 저장한다. 저장 차례도 이 monitor가 정하며, 연결별 저장은 하나씩
 * 하므로 새 확인의 저장이 옛 확인의 늦은 저장보다 먼저 끝나지 않는다(늦게 끝난 옛 확인이 새 결과를 덮지 않음).
 */
export class ReadinessMonitor {
  readonly #save: (
    provider: string,
    check: ProviderReadinessCheck,
    checkedAt: Date
  ) => Promise<unknown>;
  readonly #connections: ReadonlyMap<string, ProviderConnection>;
  readonly #hub: Pick<EventHub, "publishSettingsChanged">;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  /** 연결별 마지막으로 시작한 확인의 번호. */
  readonly #latest = new Map<string, number>();
  /** 연결별 마지막으로 시작한 확인 가운데 끝난 것의 번호. 마지막에 시작한 확인이 끝나면 확인 중이 아니다. */
  readonly #settled = new Map<string, number>();
  readonly #pending = new Set<Promise<void>>();
  /**
   * 연결별 저장 차례. 저장은 하나씩 하므로 새 확인의 저장이 옛 확인의 늦은 저장보다 먼저 끝나지 않는다.
   * 거절은 삼킨 version을 둬서 한 번의 저장 실패가 뒤 확인의 차례를 막지 않는다.
   */
  readonly #saving = new Map<string, Promise<void>>();
  readonly #stop = new AbortController();
  #seq = 0;

  constructor(options: {
    /** 확인 결과 하나를 저장한다. 저장 순서는 이 monitor가 정한다. */
    save: (
      provider: string,
      check: ProviderReadinessCheck,
      checkedAt: Date
    ) => Promise<unknown>;
    connections: readonly ProviderConnection[];
    /** 전역 설정 변경 신호(`settings_changed`)를 보낸다. 확인 중 표시는 저장과 상관없이 바뀌므로 commit 뒤 할 일을 거치지 않는다. */
    hub: Pick<EventHub, "publishSettingsChanged">;
    now: () => Date;
    /** 확인 하나를 기다리는 시간. 넘으면 `unknown`·`check_timeout`이다. */
    timeoutMs?: number;
  }) {
    this.#save = options.save;
    this.#connections = new Map(options.connections.map((c) => [c.id, c]));
    this.#hub = options.hub;
    this.#now = options.now;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** 지금 확인 중인가: 마지막에 시작한 확인이 아직 끝나지 않았다. 그보다 먼저 시작한 확인이 남아 있어도 보지 않는다(그 결과는 저장하지 않는다). */
  checking(provider: string): boolean {
    const latest = this.#latest.get(provider);
    return latest !== undefined && this.#settled.get(provider) !== latest;
  }

  /** 등록된 연결을 모두 확인한다. 기다리지 않으며 실패는 남기기만 한다. */
  checkAll(): void {
    for (const id of this.#connections.keys()) void this.check(id);
  }

  /**
   * 연결 하나를 확인해 저장한다. 끝나면(저장하지 않은 옛 확인이어도) 돌아온다. 던지지 않는다.
   * 연결별 저장은 하나씩 하며, 각 저장은 자기 차례에 다시 "아직 마지막에 시작한 확인인가"를 확인한다. 그래서 마지막에
   * 시작한 확인이 마지막에 저장되고, 순서는 시각이 아니라 이 monitor의 확인 번호가 정한다.
   */
  check(provider: string): Promise<void> {
    const connection = this.#connections.get(provider);
    if (!connection || this.#stop.signal.aborted) return Promise.resolve();
    const seq = ++this.#seq;
    this.#latest.set(provider, seq);
    this.#hub.publishSettingsChanged();
    const startedAt = this.#now();
    const task = (async () => {
      try {
        const result = await this.#run(connection);
        const previous = this.#saving.get(provider) ?? Promise.resolve();
        const saving = previous.then(async () => {
          if (this.#latest.get(provider) !== seq || this.#stop.signal.aborted)
            return;
          await this.#save(provider, result, startedAt);
        });
        this.#saving.set(
          provider,
          saving.catch(() => {})
        );
        await saving;
      } catch (error) {
        console.error(`[providers] ${provider} readiness not saved`, error);
      } finally {
        // 저장한(또는 저장하지 못한) 마지막 확인만 확인 중을 끝낸다. 옛 확인이 끝난 것은 화면에 바뀔 것이 없다.
        if (this.#latest.get(provider) === seq) {
          this.#settled.set(provider, seq);
          if (!this.#stop.signal.aborted) this.#hub.publishSettingsChanged();
        }
      }
    })();
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
    return task;
  }

  /** 새 확인을 받지 않고 진행 중인 확인을 멈춘 뒤 끝날 때까지 기다린다. */
  async close(): Promise<void> {
    this.#stop.abort();
    await Promise.all(this.#pending);
  }

  /** 연결의 확인 하나. 시간 초과는 `check_timeout`, 오류·계약 밖의 결과는 `check_failed`다. 오류 원문은 남기지 않는다. */
  async #run(connection: ProviderConnection): Promise<ProviderReadinessCheck> {
    const controller = new AbortController();
    const stop = () => controller.abort();
    this.#stop.signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        connection.adapter.checkReadiness(controller.signal),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            resolve("timeout");
            controller.abort();
          }, this.#timeoutMs);
        }),
      ]);
      if (raw === "timeout")
        return { status: "unknown", reason: "check_timeout" };
      const parsed = providerReadinessCheckSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      console.error(
        `[providers] ${connection.id} returned an invalid readiness`,
        parsed.error
      );
      return { status: "unknown", reason: "check_failed" };
    } catch (error) {
      console.error(
        `[providers] ${connection.id} readiness check failed`,
        error
      );
      return { status: "unknown", reason: "check_failed" };
    } finally {
      clearTimeout(timer);
      this.#stop.signal.removeEventListener("abort", stop);
    }
  }
}
