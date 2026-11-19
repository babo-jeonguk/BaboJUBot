/**
 * 한 번에 한 회차만 도는 확인. 도는 동안 온 요청은 하나로 모아, 그 회차가 끝난 뒤 한 번 더 돈다.
 * 주기 확인(heartbeat·압축·알림)이 이 모양을 쓰고, 키마다 따로 도는 확인(에이전트별 깨우기 처리)은 `RerunLoops`를 쓴다.
 * 새 확인도 이 두 클래스를 쓴다.
 * 회차의 실패(거절·동기 throw)는 `onError`에 넘기고 다음 요청을 계속 받는다. 기다리는 쪽에는 실패를 던지지 않는다.
 * 마지막 회차가 끝나 쉬게 되면(재실행 없이 끝나거나 닫혀서 재실행을 버리면) `onIdle`을 부른다. 회차와 그 재실행 사이에는 부르지 않는다.
 */
export class RerunLoop {
  readonly #check: () => Promise<void>;
  readonly #onError: (error: unknown) => void;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;

  constructor(
    check: () => Promise<void>,
    onError: (error: unknown) => void,
    onIdle: () => void = () => {}
  ) {
    this.#check = check;
    this.#onError = onError;
    void onIdle;
  }

  /** 도는 회차가 있는가. dispatcher가 `RerunLoops`로 옮기면 지운다. */
  get busy(): boolean {
    return this.#running !== undefined;
  }

  /** 확인을 요청한다. 도는 중이면 끝난 뒤 한 번 더 돌게 한다. 닫힌 뒤에는 아무것도 하지 않는다. */
  request(): void {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      try {
        await this.#check();
      } catch (error) {
        this.#onError(error);
      }
    })().finally(() => {
      this.#running = undefined;
      if (!this.#again) return;
      this.#again = false;
      this.request();
    });
  }

  /**
   * 지금 확인하고, 이 호출 뒤에 시작한 회차가 끝날 때까지 기다린다. 도는 회차가 있으면 그 뒤의 재실행을 기다린다.
   * 그 재실행 뒤에 또 요청된 회차는 기다리지 않는다. 닫힌 뒤에는 바로 끝난다.
   */
  async runNow(): Promise<void> {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      await this.#running; // 이 회차의 finally가 재실행을 이미 시작했다.
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
 */
export class RerunLoops {
  constructor(
    check: (key: string) => Promise<void>,
    onError: (key: string, error: unknown) => void
  ) {
    void check;
    void onError;
    throw new Error("RerunLoops is not implemented yet");
  }

  /** 그 키의 확인을 요청한다. 그 키가 도는 중이면 끝난 뒤 한 번 더 돌게 한다. 닫힌 뒤에는 아무것도 하지 않는다. */
  request(key: string): void {
    void key;
    throw new Error("RerunLoops is not implemented yet");
  }

  /** 그 키가 도는 중인가(재실행을 기다리는 중 포함). */
  busy(key: string): boolean {
    void key;
    throw new Error("RerunLoops is not implemented yet");
  }

  /** 그 키가 쉴 때까지 기다린다. 기다리는 사이 그 키를 다시 요청해 새로 시작했으면 그것도 기다린다. */
  async settled(key: string): Promise<void> {
    void key;
    throw new Error("RerunLoops is not implemented yet");
  }

  /** 모든 키가 쉴 때까지 기다린다. 기다리는 사이 시작한 키(다른 키의 회차가 요청한 것 포함)도 기다린다. */
  async settledAll(): Promise<void> {
    throw new Error("RerunLoops is not implemented yet");
  }

  /** 새 요청을 받지 않고, 도는 키가 모두 끝날 때까지 기다린다. 아직 시작하지 않은 재실행은 돌지 않는다. */
  async close(): Promise<void> {
    throw new Error("RerunLoops is not implemented yet");
  }
}
