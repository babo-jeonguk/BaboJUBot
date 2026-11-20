import { configDefaults, defineConfig } from "vitest/config";
import { testReport } from "../../vitest.reports.ts";

// 브라우저 E2E(e2e/*.spec.ts)는 Playwright가 실행한다. vitest는 화면 없이 도는 src 단위 검사와 test/의 설정 검사만 맡는다.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    reporters: [...configDefaults.reporters, ...testReport("web")],
  },
});
