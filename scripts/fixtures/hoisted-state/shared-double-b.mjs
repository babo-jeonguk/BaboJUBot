// tests/hoisted-state-at-call 규칙 시험의 공용 대역 고정물(scripts/lint-rules.test.mjs). 두 공용 대역(a·b)이 같은 공용 도움을 쓸 때
// 판정이 lint한 시험 파일의 차례와 무관한지 본다. 대역이 await 뒤에 칸을 읽는 도움을 부른다(걸림).
import { currentFailure } from "./shared-double.mjs";

export function makerB(real) {
  return {
    ...real,
    open: async (file) => {
      const handle = await real.open(file);
      const failure = currentFailure();
      if (failure) throw failure;
      return handle;
    },
  };
}
