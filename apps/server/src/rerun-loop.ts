import {
  continueAfterFailure,
  failureCode,
  isThenable,
  type Synchronous,
} from "@babojubot/contracts";

/** `RerunLoop`·`RerunLoops`의 콜백이 promise를 돌려줬다. 회차는 콜백의 작업을 기다리지 않으므로, 비동기 일은 콜백 안에서 따로 시작하고 그 실패를 스스로 다룬다. */
export class AsyncCallbackError extends TypeError {
  override name = "AsyncCallbackError";
  constructor(callback: "onError" | "onIdle") {
    super(
      `the rerun loop's ${callback} returned a promise; pass a synchronous function and start asynchronous work inside it with its own failure handling`
    );
  }
}

/**
 * 한 번에 한 회차만 도는 확인. 도는 동안 온 요청은 하나로 모아, 그 회차가 끝난 뒤 한 번 더 돈다.
 * 주기 확인(heartbeat·압축·알림)이 이 모양을 쓰고, 키마다 따로 도는 확인(에이전트별 깨우기 처리)은 `RerunLoops`를 쓴다.
 * 새 확인도 이 두 클래스를 쓴다.
 * 회차의 실패(거절·동기 throw)는 `onError`에 넘기고 다음 요청을 계속 받는다. 기다리는 쪽에는 실패를 던지지 않는다.
 * `onError`·`onIdle`은 동기 함수다. promise를 돌려주는 콜백은 타입 검사가 거부하고, 실행 중 받으면 `AsyncCallbackError`로 알린다(`onIdle`은 `onError`로, `onError`는 서버 로그로). 돌려받은 promise는 기다리지 않고, 그 거절만 같은 보고(`onIdle`은 `onError`, `onError`는 서버 로그)로 넘긴다. 던져도 회차는 끝나고(기다리는 쪽이 풀리고) 다음 요청을 받는다. `onIdle`이 던진 오류는 `onError`로, `onError`가 던진 오류는 넘겨받던 실패와 함께 서버 로그(console.error)로 보낸다.
 * 마지막 회차가 끝나 쉬게 되면(재실행 없이 끝나거나 닫혀서 재실행을 버리면) `onIdle`을 부른다. 회차와 그 재실행 사이에는 부르지 않는다.
 */
export class RerunLoop<E = void, I = void> {
  readonly #check: () => Promise<void>;
  readonly #onError: (error: unknown) => unknown;
  readonly #onIdle: () => unknown;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;

  constructor(
    check: () => Promise<void>,
    onError: (error: unknown) => Synchronous<E>,
    onIdle?: () => Synchronous<I>
  ) {
    this.#check = check;
    this.#onError = onError;
    this.#onIdle = onIdle ?? (() => {});
  }

  /** 확인을 요청한다. 도는 중이면 끝난 뒤 한 번 더 돌게 한다. 닫힌 뒤에는 아무것도 하지 않는다. */
  request(): void {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    // 확인을 부르기 전에 도는 중으로 표시한다. 확인이 첫 await 전에 같은 루프를 다시 요청해도 재실행으로 모인다.
    const pass = Promise.withResolvers<void>();
    this.#running = pass.promise;
    void this.#pass().then(() => {
      this.#running = undefined;
      if (this.#again) {
        this.#again = false;
        this.request();
      }
      if (!this.#running)
        continueAfterFailure(
          () => {
            const returned = this.#onIdle();
            if (isThenable(returned)) {
              this.#fail(new AsyncCallbackError("onIdle"));
              // 회차는 그 작업을 기다리지 않는다. 그 실패만 같은 보고로 넘겨 처리되지 않은 거절로 두지 않는다.
              void Promise.resolve(returned).then(undefined, (error: unknown) =>
                this.#fail(error)
              );
            }
          },
          (error) => this.#fail(error)
        );
      pass.resolve();
    });
  }

  async #pass(): Promise<void> {
    try {
      await this.#check();
    } catch (error) {
      this.#fail(error);
    }
  }

  /** 실패를 `onError`에 넘긴다. `onError`가 던지면 넘기던 실패와 함께 서버 로그에 남기고, 회차는 그대로 끝낸다. */
  #fail(error: unknown): void {
    continueAfterFailure(
      () => {
        const returned = this.#onError(error);
        if (isThenable(returned)) {
          console.error(
            `[rerun-loop] onError returned a promise (${failureCode(new AsyncCallbackError("onError"))}); the failure it was given was ${failureCode(error)}`
          );
          // 그 작업의 실패도 서버 로그에 남긴다. 회차는 기다리지 않는다.
          void Promise.resolve(returned).then(undefined, (thrown: unknown) =>
            console.error(
              `[rerun-loop] the promise onError returned failed (${failureCode(thrown)})`
            )
          );
        }
      },
      (thrown) =>
        console.error(
          `[rerun-loop] onError threw while handling a failure; the failure was ${failureCode(error)} and onError threw ${failureCode(thrown)}`
        )
    );
  }

  /**
   * 지금 확인하고, 이 호출 뒤에 시작한 회차가 끝날 때까지 기다린다. 도는 회차가 있으면 그 뒤의 재실행을 기다린다.
   * 그 재실행 뒤에 또 요청된 회차는 기다리지 않는다. 닫힌 뒤에는 바로 끝난다.
   */
  async runNow(): Promise<void> {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      await this.#running; // 이 회차가 끝나며 재실행을 이미 시작했다.
    } else this.request();
    await this.#running;
  }

  /** 지금 도는 회차와 그 뒤로 이어지는 재실행이 모두 끝날 때까지 기다린다. 도는 회차가 없으면 바로 끝난다. */
  async settled(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /** 새 요청을 받지 않고, 도는 회차가 끝날 때까지 기다린다. 아직 시작하지 않은 재실행은 돌지 않는다. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.settled();
  }
}

/**
 * 키마다 따로 도는 `RerunLoop`들. 같은 키는 한 번에 한 회차만 돌고, 다른 키는 서로 기다리지 않는다.
 * 쉬게 된 키는 잊는다. 그 뒤 같은 키를 요청하면 새로 시작한다. 그래서 들고 있는 것은 지금 도는 키뿐이다.
 * `onIdle`은 키를 잊은 뒤 그 키로 부른다.
 * 콜백이 던질 때도 `RerunLoop`과 같다: 키를 잊고, `onIdle`이 던진 오류는 그 키로 `onError`에 넘긴다.
 */
export class RerunLoops<E = void, I = void> {
  readonly #loops = new Map<string, RerunLoop>();
  readonly #check: (key: string) => Promise<void>;
  readonly #onError: (key: string, error: unknown) => unknown;
  readonly #onIdle: (key: string) => unknown;
  #closed = false;

  constructor(
    check: (key: string) => Promise<void>,
    onError: (key: string, error: unknown) => Synchronous<E>,
    onIdle?: (key: string) => Synchronous<I>
  ) {
    this.#check = check;
    this.#onError = onError;
    this.#onIdle = onIdle ?? (() => {});
  }

  /** 그 키의 확인을 요청한다. 그 키가 도는 중이면 끝난 뒤 한 번 더 돌게 한다. 닫힌 뒤에는 아무것도 하지 않는다. */
  request(key: string): void {
    if (this.#closed) return;
    let loop = this.#loops.get(key);
    if (!loop) {
      loop = new RerunLoop(
        () => this.#check(key),
        (error) => this.#onError(key, error),
        () => {
          this.#loops.delete(key);
          return this.#onIdle(key);
        }
      );
      this.#loops.set(key, loop);
    }
    loop.request();
  }

  /** 그 키가 도는 중인가(재실행을 기다리는 중 포함). */
  busy(key: string): boolean {
    return this.#loops.has(key);
  }

  /** 그 키가 쉴 때까지 기다린다. 기다리는 사이 그 키를 다시 요청해 새로 시작했으면 그것도 기다린다. */
  async settled(key: string): Promise<void> {
    // 기다린 루프가 아직 있으면 그것은 쉬고 있으므로 다시 기다리지 않는다. 그사이 새로 시작한 루프만 이어서 기다린다.
    let waited: RerunLoop | undefined;
    for (let loop; (loop = this.#loops.get(key)) && loop !== waited;) {
      await loop.settled();
      waited = loop;
    }
  }

  /** 모든 키가 쉴 때까지 기다린다. 기다리는 사이 시작한 키(다른 키의 회차가 요청한 것 포함)도 기다린다. */
  async settledAll(): Promise<void> {
    // settled와 같이, 기다린 루프는 다시 기다리지 않고 그사이 시작한 루프만 이어서 기다린다.
    const waited = new Set<RerunLoop>();
    for (;;) {
      const loops = [...this.#loops.values()].filter(
        (loop) => !waited.has(loop)
      );
      if (!loops.length) return;
      await Promise.all(loops.map((loop) => loop.settled()));
      for (const loop of loops) waited.add(loop);
    }
  }

  /** 새 요청을 받지 않고, 도는 키가 모두 끝날 때까지 기다린다. 아직 시작하지 않은 재실행은 돌지 않는다. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#loops.values()].map((loop) => loop.close()));
  }
}
