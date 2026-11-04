// scripts/check-test-exit-code.mjs가 부르는 일부러 실패하는 시험. 각 패키지의 `pnpm test`는 이 폴더를 찾지 않는다.
/* global it */
it("always fails", () => {
  throw new Error("intended failure");
});
