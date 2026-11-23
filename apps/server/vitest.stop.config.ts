import { configDefaults, defineConfig } from "vitest/config";
import { suiteTest } from "../../vitest.reports.ts";
import server from "./vitest.config.ts";

// 서버 진입점의 멈춤 시험(src/stop-request.test.ts, test/main.test.ts). Windows E2E job이 그 시스템에서 돈다. 서버 시험과 같은 준비를
// 쓰고 파일 고르기와 보고서만 다르다(묶음 정의 scripts/test-suites.ts의 server-stop).
export default defineConfig({
  test: { ...server.test, ...suiteTest("server-stop", configDefaults) },
});
