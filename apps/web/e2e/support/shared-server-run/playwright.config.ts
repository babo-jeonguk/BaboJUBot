import { defineConfig } from "@playwright/test";

// 공용 서버 수명 시험(../shared-server.spec.ts)이 따로 띄우는 Playwright 실행의 설정. 브라우저 없이 공용 서버의 globalSetup
// (e2e/global-setup.ts의 startSharedServer)만 빈 port로 돌린다. 바깥 E2E가 이 폴더의 `*.check.ts`를 테스트로 읽지 않는다.
export default defineConfig({
  testDir: ".",
  testMatch: "*.check.ts",
  globalSetup: "./setup.ts",
  workers: 1,
  reporter: "line",
  outputDir: process.env.SHARED_SERVER_RUN_OUTPUT,
});
