import { defineConfig, devices } from "@playwright/test";
import { codeFormats } from "../../../../../scripts/test-files.mjs";

// 전역 설정 정리 시험(../shared-settings.spec.ts)이 따로 띄우는 Playwright 실행의 설정. 바깥 E2E가 띄운 화면·API 서버
// (SHARED_SETTINGS_RUN_URL)에 붙어 `sharedSettings` fixture를 쓰는 시험 하나를 돌린다. 바깥 E2E가 이 폴더의 `*.check.*`를
// 테스트로 읽지 않는다. 결과는 JSON 보고서(SHARED_SETTINGS_RUN_REPORT)로 바깥 시험에 넘긴다.
export default defineConfig({
  testDir: ".",
  testMatch: `*.check.${codeFormats}`,
  timeout: 60_000,
  workers: 1,
  reporter: [
    ["line"],
    ["json", { outputFile: process.env.SHARED_SETTINGS_RUN_REPORT }],
  ],
  outputDir: process.env.SHARED_SETTINGS_RUN_OUTPUT,
  use: { baseURL: process.env.SHARED_SETTINGS_RUN_URL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
