import { configDefaults, defineConfig } from "vitest/config";
import { suiteTest } from "../../vitest.reports.ts";

// 시스템마다 다른 파일 식별을 실제로 돌려 보는 검사다. DB를 쓰지 않으므로 시험용 DB를 띄우지 않는다.
export default defineConfig({
  test: {
    ...suiteTest("server-files", configDefaults),
    // 세 OS 모두 감독 실행기 없이 프로그램을 띄우지 않는다(#268). 파일 읽기 프로세스도 같다. 시험 파일마다의 임시 제품 폴더
    // (test/product-home.ts)는 서버 시험과 같게 준비한다: 공용 시험 도움(test/support.ts)이 그 폴더의 정리를 가져다 쓴다.
    setupFiles: ["./test/product-home.ts", "@babojubot/process/launcher-setup"],
    testTimeout: 240_000,
    // 바꿔치기 시험은 시도마다 만든 임시 폴더 수백 개를 끝에 지운다. 느린 Windows runner에서도 끝나게 둔다.
    hookTimeout: 120_000,
    // 실패한 사례의 실제 응답을 결과표에서 그대로 보이게 줄이지 않는다.
    chaiConfig: { truncateThreshold: 0 },
  },
});
