// 오류를 버리는 의도마다 이름 붙은 함수. 제품 코드는 오류를 받지 않고 버리지 않는다(lint `product/no-ignored-error`).
// 오류를 받아 검사하거나 다시 던질 수 없고 버려야 하면 의도에 맞는 함수를 쓴다. 고르는 기준은 CODING_STANDARDS.md#제품-코드.
// 화면도 쓰므로 Node 기능에 기대지 않는다. 진단을 어디에 어떻게 남길지는 부르는 쪽이 넘긴다.

/** 오류의 `code`가 주어진 것 중 하나인가. Node 파일·프로세스 오류(`ENOENT`·`ESRCH` 등)를 `orIfMissing`의 "없음"으로 고를 때 쓴다. */
export function hasErrorCode(...codes: string[]): (error: unknown) => boolean {
  const wanted = new Set(codes);
  return (error) => {
    const code = errorCode(error);
    return code !== undefined && wanted.has(code);
  };
}

/** 오류가 문자열 `code`를 가지면 그것. 없거나 문자열이 아니면 `undefined`. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** `read`가 promise를 돌려주는지 값의 `then`으로 가른다. 화면도 쓰므로 다른 realm의 promise도 받는다. */
function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof (value as { then?: unknown } | null | undefined)?.then === "function"
  );
}

/**
 * 동기·비동기 읽기를 한 번만 감싸 실패를 `onFailure`에 맡긴다. `onFailure`가 던지면 그대로 드러난다.
 * `read`가 promise를 돌려주면 결과도 promise다.
 */
function recover<T, F>(
  read: () => T | Promise<T>,
  onFailure: (error: unknown) => F
): T | F | Promise<T | F> {
  let value: T | Promise<T>;
  try {
    value = read();
  } catch (error) {
    return onFailure(error);
  }
  if (isThenable(value)) {
    return Promise.resolve(value).then(undefined, (error: unknown) =>
      onFailure(error)
    );
  }
  return value;
}

/**
 * 없으면 기본값. `read`가 실패하고 그 오류가 `isMissing`이 고른 "없음"이면 `fallback`을 돌려주고, 그 밖의 오류(권한·디스크 등)는
 * 그대로 던진다. `read`가 promise를 돌려주면 결과도 promise다.
 */
export function orIfMissing<T, F>(
  read: () => Promise<T>,
  isMissing: (error: unknown) => boolean,
  fallback: F
): Promise<T | F>;
export function orIfMissing<T, F>(
  read: () => T,
  isMissing: (error: unknown) => boolean,
  fallback: F
): T | F;
export function orIfMissing<T, F>(
  read: () => T | Promise<T>,
  isMissing: (error: unknown) => boolean,
  fallback: F
): T | F | Promise<T | F> {
  return recover(read, (error) => {
    if (isMissing(error)) return fallback;
    throw error;
  });
}

/**
 * 실패해도 진행. `work`가 실패하면 `report(error)`로 무엇이 실패했는지 남기고 값 없이(`undefined`) 진행한다.
 * `report`가 던지면 그 오류는 숨기지 않는다. `work`가 promise를 돌려주면 결과도 promise다.
 */
export function continueAfterFailure<T>(
  work: () => Promise<T>,
  report: (error: unknown) => void
): Promise<T | undefined>;
export function continueAfterFailure<T>(
  work: () => T,
  report: (error: unknown) => void
): T | undefined;
export function continueAfterFailure<T>(
  work: () => T | Promise<T>,
  report: (error: unknown) => void
): T | undefined | Promise<T | undefined> {
  return recover(work, (error) => {
    report(error);
    return undefined;
  });
}

/**
 * 읽을 수 없으면 아님. 해석(JSON·URL·인코딩)이나 확인, 연결 시도처럼 실패가 흔하고 그 결과(아님·없음·거부·502)로 드러나는 한 단계가 실패하면 정해진 부정 결과를 돌려준다.
 * 실패는 그 결과로 드러나므로 진단을 남기지 않는다. 해석이나 확인 한 단계만 감싼다. "없음"과 권한·디스크 오류를 나눠야 하는
 * 읽기는 감싸지 않고 `orIfMissing`을 쓴다. 프로세스 상태 조회처럼 "알 수 없음"이 곧 정해진 결과인 확인은 감싸도 된다.
 * `read`가 promise를 돌려주면 결과도 promise다.
 */
export function orIfUnreadable<T, F>(
  read: () => Promise<T>,
  fallback: F
): Promise<T | F>;
export function orIfUnreadable<T, F>(read: () => T, fallback: F): T | F;
export function orIfUnreadable<T, F>(
  read: () => T | Promise<T>,
  fallback: F
): T | F | Promise<T | F> {
  return recover(read, () => fallback);
}

/**
 * 순서만 지킴. `promise`가 끝나면(성공·실패 모두) 값 없이 풀린다. 결과와 실패는 원래 promise를 가진 쪽이 받는다
 * (대기 고리의 다음 일, 화면 저장 요청의 상태, 중단 요청 뒤에 연결을 닫는 단계 등).
 * `settled(p.then(next))`처럼 다음 일을 이으면 `next`의 실패도 버리므로, 다음 일은 실패할 수 없는 화면 갱신 같은 것만 잇는다.
 */
export function settled(promise: PromiseLike<unknown>): Promise<void> {
  return Promise.allSettled([promise]).then(() => undefined);
}

/** 기록에 남길 짧은 오류 이름. `code`가 문자열이면 그것(`EACCES`), 아니면 오류 종류(`TypeError`), 그것도 없으면 `unknown`. 오류 문구는 담지 않는다. */
export function failureCode(error: unknown): string {
  const code = errorCode(error);
  if (code !== undefined) return code;
  if (error instanceof Error) return error.name;
  return "unknown";
}

/**
 * 서로 독립인 일(끄기·닫기·지우기 같은 정리)을 차례로 모두 시도하고 실패를 돌려준다. 앞 일이 실패해도 뒤 일을 한다. 동기로 던지든
 * 거절하든 실패로 모은다. 실패를 원래 실패와 함께 묶어야 하는 쪽(`withCleanup`)이 쓰는 바탕이며, 보통은 `attemptAll`을 쓴다.
 * 실패를 모으는 일을 따로 짜지 않는다(lint `product/no-failure-collecting`).
 */
export async function attemptEach(
  steps: Iterable<() => unknown>
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps)
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  return failures;
}

/**
 * 모은 실패를 하나로 만든다. 하나면 그 오류를 그대로, 여럿이면 `message` 뒤에 각 문구를 이어 적은 AggregateError다. 목록을 펼치지 않는
 * 출력(node:test의 TAP, 서버 운영 기록)에서도 모든 실패가 보이도록 문구에 함께 적는다.
 */
export function combinedFailure(
  failures: readonly unknown[],
  message: string,
  options?: ErrorOptions
): unknown {
  if (failures.length === 1) return failures[0];
  return new AggregateError(
    failures,
    `${message}: ${failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join(" — 그리고 ")}`,
    options
  );
}

/**
 * 서로 독립인 일(끄기·닫기·지우기 같은 정리)을 차례로 모두 하고, 실패가 있으면 모아 던진다(`combinedFailure`). 앞 일이 끝나야 안전한
 * 뒤 일은 여기 넣지 않고 그 순서를 드러낸 한 단계로 묶거나 이것이 끝난 뒤에 부른다(이것이 던지면 이어지지 않는다).
 * 차례로 기다린 정리가 앞의 실패에 뒤를 건너뛰었다(#263 외부 리뷰 S1·S2).
 */
export async function attemptAll(
  steps: Iterable<() => unknown>,
  message = "정리가 실패했다"
): Promise<void> {
  const failures = await attemptEach(steps);
  if (failures.length) throw combinedFailure(failures, message);
}
