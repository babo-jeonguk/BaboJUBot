// 시험의 대기마다 상한과 실패 원인을 두는 공용 도움(`within`). node 기본 모듈을 값으로 불러오지 않는다: `node:os`·`node:net` 같은
// 경계를 대역하는 `vi.mock` factory가 불러오는 지원 파일(runtime `os-failure-support.ts` 등)도 이것을 쓰고, 그 대역이 만들어지기 전에
// 자기 자신을 기다리면 시험이 불러오는 단계에서 멈춘다. `@babojubot/process/test-support`가 다시 내보낸다.

// 모듈을 불러올 때의 진짜 타이머. 시험이 가짜 시계를 켜도(`vi.useFakeTimers`) `within`의 상한은 실제 시간으로 잰다.
// 쓰는 모양(콜백·시간)의 함수 타입으로만 받는다. Node의 `setTimeout`에 붙은 이름공간 값(`__promisify__`)은 바꿀 수 있는 속성이다.
const realSetTimeout: (
  callback: () => void,
  ms: number
) => ReturnType<typeof setTimeout> = setTimeout;
const realClearTimeout = clearTimeout;

/**
 * `promise`를 `ms` 안에 기다린다. 넘기면 무엇을 기다리다 실패했는지(`what`, 예: "the server did not start")와 상한을 밝혀
 * 던진다. 시험의 대기마다 상한과 실패 원인을 두는 공용 도움이다(CODING_STANDARDS 「시간」). vi를 불러오지 않아 vitest·node:test·
 * Playwright 모두에서 쓴다. 상한은 시험이 가짜 시계를 켜도 실제 시간으로 잰다. 상한이 지나도 `promise`가 쥔 자원은 그대로이므로
 * 정리는 부른 쪽이 맡는다(`withCleanup` 등).
 * 제품 코드는 시험 도움을 부르지 않아 같은 모양을 따로 둔다(supervised.ts `within`).
 */
export async function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realSetTimeout(
          () => reject(new Error(`${what} within ${ms} ms`)),
          ms
        );
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

/**
 * 시작한 획득들(`acquiring`)이 모두 끝나기를 `ms` 안에 기다리고 각각의 결과를 돌려준다. 시험 자원의 공용 소유 계약에서 정리가
 * 진행 중인 획득의 끝을 확인하는 한 모양이다(호출 무장의 끝, `testFolders`의 만들기, `releaseAcquired`). 넘기면 던지고, 획득한 자원은
 * 그대로 남는다(정리는 그것을 놓지 않고 실패한다).
 */
export function settledWithin<T extends readonly unknown[] | []>(
  acquiring: T,
  ms: number,
  what: string
): Promise<{ -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }> {
  return within(Promise.allSettled(acquiring), ms, what);
}
