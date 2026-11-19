/**
 * 한 번에 한 회차만 도는 확인. 도는 동안 온 요청은 하나로 모아, 그 회차가 끝난 뒤 한 번 더 돈다.
 * 주기 확인(heartbeat·압축·알림)과 에이전트별 깨우기 처리가 이 모양을 쓴다. 새 주기 확인도 이 클래스를 쓴다.
 * 회차의 실패(거절·동기 throw)는 `onError`에 넘기고 다음 요청을 계속 받는다. 기다리는 쪽에는 실패를 던지지 않는다.
 */
export class RerunLoop {
  readonly #check: () => Promise<void>;
  readonly #onError: (error: unknown) => void;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;

  constructor(check: () => Promise<void>, onError: (error: unknown) => void) {
    this.#check = check;
    this.#onError = onError;
  }

  /** 도는 회차가 있는가. */
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
