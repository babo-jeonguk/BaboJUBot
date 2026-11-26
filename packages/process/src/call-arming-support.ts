// 시험이 부른 제품 호출 하나에 그 시험의 값(결함 무장, 실행 시도 귀속)을 묶는 공용 도움. 이 저장소에서 `AsyncLocalStorage`를 쓰는
// 곳은 여기 하나다. 결함은 그 시험만의 경로로 고를 수 없을 때(공유 임시 폴더에 무작위 이름으로 생기는 폴더, 시험끼리 같은 후보 폴더)
// 쓴다. 경로로 고를 수 있으면 경로로 고른다.
//
// Node의 `AsyncLocalStorage`는 그 호출이 일으킨 비동기 일(타이머, promise 이어짐, 입출력 콜백)에 같은 값을 이어 준다
// (https://nodejs.org/api/async_context.html#class-asynclocalstorage). 그래서 앞 시험이 시작한 늦은 일은 앞 시험의 값(또는 없음)을
// 보고, 이 시험의 값에 걸리지 않는다.
import { AsyncLocalStorage } from "node:async_hooks";
import { within } from "./test-support.ts";

/** 무장의 끝이 진행 중인 획득을 기다리는 상한. 넘기면 획득한 자원을 남기고 정리가 실패한다. */
const acquisitionsEndWithinMs = 10_000;

/**
 * 결함 무장 한 종류의 길. 시험은 제품 호출을 `run(무장, () => 제품 호출, onTestFinished)`로 명시적으로 감싼다(러너나 fixture 안에서
 * 문맥이 이어지는 동작에 기대지 않는다). 대역은 불린 순간(첫 await 전) `current()`로 그 호출의 무장을 잡는다: 감싸지 않은 호출, 다른
 * 시험의 호출, 끝난 무장이면 무장이 없다. 문맥은 호출이 남긴 늦은 일에도 이어지므로 무장의 끝은 그 시험의 정리가 정한다(`own`에
 * 맡긴다). 시험은 결함이 실제로 걸렸다는 것을 단언해 문맥이 끊긴 채 통과하지 않게 한다.
 *
 * 무장의 문맥에서 얻는 자원(대역이 만든 폴더 등)은 시험 자원의 공용 소유 계약을 따른다: 획득은 시작 순간(첫 await 전) `acquire`로
 * 무장에 등록하고, 무장을 끝내는 것이 정리의 첫 동기 단계이며 끝난 무장의 문맥에서 시작하는 획득은 거절한다(대역이 던져 추적되지
 * 않는 자원을 만들지 않는다). 끝은 진행 중인 획득이 끝나기를 상한 안에서 기다리고, 끝을 확인하지 못하면 자원을 남기고 실패한다.
 */
export function callArming<A extends object>() {
  type Slot = { arming: A; ended: boolean; acquiring: Promise<unknown>[] };
  const calls = new AsyncLocalStorage<Slot>();
  return {
    /**
     * `call`과 그것이 일으킨 비동기 일을 `arming`의 문맥에서 돌린다. 무장을 끝내는 함수는 `own`(그 시험의 정리 등록)에 넘긴다. 그
     * 함수는 무장을 끝낸 뒤(동기) 진행 중인 획득이 끝나기를 기다린다. 끝난 뒤의 늦은 일은 무장을 찾지 못한다.
     */
    run<T>(
      arming: A,
      call: () => T,
      own: (end: () => Promise<void>) => void
    ): T {
      const slot: Slot = { arming, ended: false, acquiring: [] };
      own(async () => {
        slot.ended = true;
        await within(
          Promise.allSettled(slot.acquiring),
          acquisitionsEndWithinMs,
          "the acquisitions started in the call arming did not end"
        );
      });
      return calls.run(slot, call);
    },
    /** 지금 호출의 무장. 감싼 호출이 아니거나 무장이 끝났으면 없다. */
    current(): A | undefined {
      const slot = calls.getStore();
      return slot && !slot.ended ? slot.arming : undefined;
    },
    /**
     * 지금 호출의 무장에서 자원을 얻는다: `start(무장)`을 그 자리에서 부르고 그 진행을 무장에 등록해 돌려준다. 감싼 호출이 아니면
     * 무장이 없어 얻지 않는다(undefined: 대역은 진짜 함수를 부른다). 무장이 끝났으면 던진다.
     */
    acquire<R>(start: (arming: A) => Promise<R>): Promise<R> | undefined {
      const slot = calls.getStore();
      if (!slot) return undefined;
      if (slot.ended)
        throw new Error(
          "an acquisition started in a call arming that already ended"
        );
      const acquiring = start(slot.arming);
      slot.acquiring.push(acquiring);
      return acquiring;
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
