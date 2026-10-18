/**
 * 가짜 실행기 시나리오를 멈춰 두는 문. `wait`는 시나리오의 `hold` 단계에 넘기고,
 * 테스트는 `reached`로 실행 시도가 그 단계에 닿았음을 확인한 뒤 `open`으로 보낸다. 취소되면 `wait`가 reject한다.
 */
export type Gate = {
  wait: (signal: AbortSignal) => Promise<void>;
  reached: Promise<void>;
  open: () => void;
};

export function createGate(): Gate {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (markReached = r));
  const opened = new Promise<void>((r) => (release = r));
  return {
    reached,
    open: () => release(),
    wait(signal) {
      markReached();
      return new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        void opened.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    },
  };
}
