import { appendFile } from "node:fs/promises";

type Append = (file: string, text: string) => Promise<void>;

/**
 * 파일에 계속 덧붙이는 writer. timer를 멈춰도 이미 시작한 덧붙이기는 계속되므로, stop은 새 쓰기를 막은 뒤
 * 시작한 쓰기가 모두 끝날 때까지 기다린다. 쓰기 실패는 stop이 알린다. 폴더 정리는 stop 뒤에 한다.
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
  const writes: Promise<PromiseSettledResult<void>>[] = [];
  const writer = setInterval(() => {
    if (stopped) return;
    // 결과를 값으로 바꿔 모아 둔다. stop이 실패를 다시 던지므로 처리되지 않은 거부로 남지 않는다.
    writes.push(
      append(file, text).then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const
      )
    );
  }, 1);
  return {
    async stop() {
      stopped = true;
      clearInterval(writer);
      // 멈춘 쓰기가 정리를 테스트 전체 시한까지 붙잡지 않게 시한을 둔다.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          Promise.all(writes),
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
        const failed = results.find((write) => write.status === "rejected");
        if (failed) throw failed.reason;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
