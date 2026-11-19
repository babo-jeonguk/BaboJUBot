/**
 * 한 번에 한 회차만 도는 확인. 도는 동안 온 요청은 하나로 모아, 그 회차가 끝난 뒤 한 번 더 돈다.
 * 주기 확인(heartbeat·압축·알림)과 에이전트별 깨우기 처리가 이 모양을 쓴다. 새 주기 확인도 이 클래스를 쓴다.
 * 회차의 실패(거절·동기 throw)는 `onError`에 넘기고 다음 요청을 계속 받는다. 기다리는 쪽에는 실패를 던지지 않는다.
 */
export class RerunLoop {
  constructor(check: () => Promise<void>, onError: (error: unknown) => void) {
    void check;
    void onError;
    throw new Error("RerunLoop is not implemented yet");
  }

  /** 도는 회차가 있는가. */
  get busy(): boolean {
    throw new Error("RerunLoop is not implemented yet");
  }

  /** 확인을 요청한다. 도는 중이면 끝난 뒤 한 번 더 돌게 한다. 닫힌 뒤에는 아무것도 하지 않는다. */
  request(): void {
    throw new Error("RerunLoop is not implemented yet");
  }

  /**
   * 지금 확인하고, 이 호출 뒤에 시작한 회차가 끝날 때까지 기다린다. 도는 회차가 있으면 그 뒤의 재실행을 기다린다.
   * 그 재실행 뒤에 또 요청된 회차는 기다리지 않는다. 닫힌 뒤에는 바로 끝난다.
   */
  async runNow(): Promise<void> {
    throw new Error("RerunLoop is not implemented yet");
  }

  /** 지금 도는 회차와 그 뒤로 이어지는 재실행이 모두 끝날 때까지 기다린다. 도는 회차가 없으면 바로 끝난다. */
  async settled(): Promise<void> {
    throw new Error("RerunLoop is not implemented yet");
  }

  /** 새 요청을 받지 않고, 도는 회차가 끝날 때까지 기다린다. 아직 시작하지 않은 재실행은 돌지 않는다. */
  async close(): Promise<void> {
    throw new Error("RerunLoop is not implemented yet");
  }
}
