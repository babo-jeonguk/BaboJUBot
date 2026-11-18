/**
 * 시한·타이머가 쓰는 시계. 제품은 실제 시계(`realClock`)를 쓰고, 시험은 시간을 직접 넘기는 시계를 넣어 프로그램 시작처럼
 * 재려는 단계가 아닌 일이 시한을 먹지 않게 하거나, 타이머와 프로그램의 순서를 실제 시간 대신 상태로 정한다(#215, #225).
 */
export type Clock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};
