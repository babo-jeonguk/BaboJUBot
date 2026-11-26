// 시험이 부른 제품 호출 하나에 그 시험의 무장(결함·기록 묶음)을 묶는 공용 도움. 이 저장소에서 `AsyncLocalStorage`를 쓰는 곳은 여기
// 하나다. 대역이 결함을 그 시험만의 경로로 고를 수 없을 때(공유 임시 폴더에 무작위 이름으로 생기는 폴더, 시험끼리 같은 후보 폴더) 쓴다.
// 경로로 고를 수 있으면 경로로 고른다.
//
// Node의 `AsyncLocalStorage`는 그 호출이 일으킨 비동기 일(타이머, promise 이어짐, 입출력 콜백)에 같은 값을 이어 준다
// (https://nodejs.org/api/async_context.html#class-asynclocalstorage). 그래서 앞 시험이 시작한 늦은 일은 앞 시험의 무장(또는 없음)을
// 보고, 이 시험의 무장에 걸리지 않는다.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 무장 한 종류의 길. 시험은 제품 호출을 `run(무장, () => 제품 호출)`로 명시적으로 감싼다(러너나 fixture 안에서 문맥이 이어지는 동작에
 * 기대지 않는다). 대역은 불린 순간(첫 await 전) `current()`로 그 호출의 무장을 잡는다: 감싸지 않은 호출이나 다른 시험의 호출이면 이
 * 시험의 무장이 아니다. 시험은 결함이 실제로 걸렸다는 것을 단언해 문맥이 끊긴 채 통과하지 않게 한다.
 */
export function callArming<A extends object>() {
  const calls = new AsyncLocalStorage<A>();
  return {
    /** `call`과 그것이 일으킨 비동기 일을 `arming`의 문맥에서 돌린다. */
    run<T>(arming: A, call: () => T): T {
      return calls.run(arming, call);
    },
    /** 지금 호출의 무장. 감싼 호출이 아니면 없다. */
    current(): A | undefined {
      return calls.getStore();
    },
  };
}
