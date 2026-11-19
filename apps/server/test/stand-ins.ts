// 타입이 요구하지만 시험이 실제 값을 넣지 않는 자리의 대역(CODING_STANDARDS.md#시험-데이터).

/**
 * 이 시험 경로가 쓰지 않는 의존성(`name`). 넘기거나 담아 두는 것은 되지만, 속성을 읽거나 부르면 그 이름과 함께 바로 실패한다.
 * 쓰지 않는다던 의존성을 제품 경로가 쓰기 시작하면 엉뚱한 null 오류 대신 이 실패가 그 자리를 알린다.
 * Promise로 돌려줘도 되도록 `then`만 없는 것으로 답한다.
 */
export function unused<T extends object>(name: string): T {
  const refuse = (what: string): never => {
    throw new Error(`이 시험은 ${name}을(를) 쓰지 않는다: ${what}`);
  };
  const target: object = Object.create(null);
  const standIn = new Proxy(target, {
    get: (_target, key) =>
      key === "then" ? undefined : refuse(`${String(key)} 읽기`),
    set: (_target, key) => refuse(`${String(key)} 쓰기`),
    has: (_target, key) => refuse(`${String(key)} 확인`),
  });
  return standIn as T;
}

/**
 * 타입이 막는 값을 일부러 넣는 자리. 계약을 어긴 프로바이더 결과처럼, 그 값을 제품이 거부하는지가 시험의 요점일 때만 쓴다.
 * 넣는 값과 어긴 타입을 한 곳에서 보이게 하려고 필드 하나에만 쓴다.
 */
export const outsideContract = <T>(value: unknown): T => value as T;
