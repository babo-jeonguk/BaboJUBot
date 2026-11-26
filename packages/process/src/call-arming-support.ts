// 시험이 부른 제품 호출 하나에 그 시험의 값(결함 무장, 실행 시도 귀속)을 묶는 공용 도움. 이 저장소에서 `AsyncLocalStorage`를 쓰는
// 곳은 여기 하나다. 결함은 그 시험만의 경로로 고를 수 없을 때(공유 임시 폴더에 무작위 이름으로 생기는 폴더, 시험끼리 같은 후보 폴더)
// 쓴다. 경로로 고를 수 있으면 경로로 고른다.
//
// Node의 `AsyncLocalStorage`는 그 호출이 일으킨 비동기 일(타이머, promise 이어짐, 입출력 콜백)에 같은 값을 이어 준다
// (https://nodejs.org/api/async_context.html#class-asynclocalstorage). 그래서 앞 시험이 시작한 늦은 일은 앞 시험의 값(또는 없음)을
// 보고, 이 시험의 값에 걸리지 않는다.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 결함 무장 한 종류의 길. 시험은 제품 호출을 `run(무장, () => 제품 호출, onTestFinished)`로 명시적으로 감싼다(러너나 fixture 안에서
 * 문맥이 이어지는 동작에 기대지 않는다). 대역은 불린 순간(첫 await 전) `current()`로 그 호출의 무장을 잡는다: 감싸지 않은 호출, 다른
 * 시험의 호출, 끝난 무장이면 무장이 없다. 무장의 끝은 그 시험의 정리가 정한다(`own`에 맡긴다). 문맥은 호출이 남긴 늦은 일에도
 * 이어지므로, 끝이 없으면 시험의 정리가 결함의 기록을 읽은 뒤에도 그 일이 결함에 걸려 기록 밖의 자원을 남긴다. 시험은 결함이 실제로
 * 걸렸다는 것을 단언해 문맥이 끊긴 채 통과하지 않게 한다.
 */
export function callArming<A extends object>() {
  const calls = new AsyncLocalStorage<{ arming: A; ended: boolean }>();
  return {
    /**
     * `call`과 그것이 일으킨 비동기 일을 `arming`의 문맥에서 돌린다. 무장을 끝내는 함수는 `own`(그 시험의 정리 등록)에 넘긴다. 끝난 뒤의
     * 늦은 일은 무장을 찾지 못한다.
     */
    run<T>(arming: A, call: () => T, own: (end: () => void) => void): T {
      const slot = { arming, ended: false };
      own(() => {
        slot.ended = true;
      });
      return calls.run(slot, call);
    },
    /** 지금 호출의 무장. 감싼 호출이 아니거나 무장이 끝났으면 없다. */
    current(): A | undefined {
      const slot = calls.getStore();
      return slot && !slot.ended ? slot.arming : undefined;
    },
  };
}

/**
 * 실행 시도 귀속 한 종류의 길(결함이 아님). `run(owner, work)` 안에서 띄운 것은 그 `owner`에 귀속한다. 귀속은 끝이 없다: 실행 시도가
 * 돌아온 뒤에 그 일이 띄운 것도 그 실행 시도의 늦은 띄우기로 센다(계약 시험이 그것을 실패로 본다).
 */
export function callAttribution<O extends object>() {
  const calls = new AsyncLocalStorage<O>();
  return {
    /** `work`와 그것이 일으킨 비동기 일을 `owner`의 문맥에서 돌린다. */
    run<T>(owner: O, work: () => T): T {
      return calls.run(owner, work);
    },
    /** 지금 일의 귀속. 감싼 일이 아니면 없다. */
    current(): O | undefined {
      return calls.getStore();
    },
  };
}
