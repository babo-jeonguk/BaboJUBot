import { configDefaults, defineConfig } from "vitest/config";
import { suiteTest } from "../../vitest.reports.ts";

// 브라우저 E2E(e2e의 spec)는 Playwright가 실행한다. vitest는 화면 없이 도는 src 단위 검사와 test/의 설정 검사만 맡는다
// (묶음 정의 scripts/test-suites.ts의 web).
export default defineConfig({
  test: {
    ...suiteTest("web", configDefaults),
  },
});
