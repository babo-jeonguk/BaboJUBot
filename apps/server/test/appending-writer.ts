import { appendFile } from "node:fs/promises";

type Append = (file: string, text: string) => Promise<void>;

/**
 * 파일에 계속 덧붙이는 writer. 덧붙이기는 한 번에 하나이며, 앞 덧붙이기가 끝난 뒤에 다음을 시작한다.
 * stop은 새 덧붙이기를 막은 뒤 이미 시작한 덧붙이기가 끝날 때까지 기다린다. 쓰기 실패는 writer를 멈추고 stop이 알린다.
 * 폴더 정리는 stop 뒤에 한다.
 * 시한 초과로 stop이 실패하면 끝나지 않은 쓰기는 아직 진행 중이다. 그 쓰기는 취소할 수 없어(시한이 없어도
 * 테스트 시한이 끊으면 같다) 뒤의 정리와 겹칠 수 있으므로, 이 실패는 정리 완료가 아니라 시험 실패로 다룬다.
 * 늦게 끝난 쓰기의 결과도 값으로 받으므로 처리되지 않은 거부로 새지 않는다.
 */
export function keepAppending(
  file: string,
  text: string,
  {
    append = appendFile as Append,
    stopTimeoutMs = 10_000,
  }: { append?: Append; stopTimeoutMs?: number } = {}
) {
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  let finish!: (failure: { reason: unknown } | undefined) => void;
  // 덧붙이기가 모두 끝나면 풀린다. 실패는 거부가 아니라 값으로 담는다.
  const finished = new Promise<{ reason: unknown } | undefined>((resolve) => {
    finish = resolve;
  });
  let writing = false;
  const write = () => {
    writing = true;
    append(file, text).then(
      () => {
        writing = false;
        if (stopped) finish(undefined);
        else next = setTimeout(write, 1);
      },
      (reason: unknown) => {
        writing = false;
        stopped = true;
        finish({ reason });
      }
    );
  };
  next = setTimeout(write, 1);
  return {
    async stop() {
      stopped = true;
      // 아직 시작하지 않은 다음 덧붙이기는 취소한다. 진행 중인 것이 있으면 그것이 끝나면서 finished를 푼다.
      clearTimeout(next);
      if (!writing) finish(undefined);
      // 멈춘 쓰기가 정리를 테스트 전체 시한까지 붙잡지 않게 시한을 둔다.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const failure = await Promise.race([
          finished,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error(
                    `appends to ${file} did not finish in ${stopTimeoutMs}ms`
                  )
                ),
              stopTimeoutMs
            );
          }),
        ]);
        if (failure) throw failure.reason;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
