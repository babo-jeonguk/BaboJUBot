import { defineConfig, devices } from "@playwright/test";
import { sharedApiPort } from "./e2e/global-setup.ts";

const webPort = 5199;

export default defineConfig({
  testDir: "e2e",
  // 여러 화면을 거치는 시나리오에 느린 CI runner·부하가 큰 로컬 기기의 여유를 준다. 개별 expect 대기는 기본값을 유지한다.
  timeout: 120_000,
  // spec들이 E2E 서버와 DB 하나를 같이 쓰고, 전역 설정(프로바이더 기본값 등)을 바꾸는 spec도 있어 하나씩 실행한다.
  // 실행 순서로 DB 상태를 정하지 않는다. 빈 DB가 필요한 검사는 자기 서버(e2e/support/isolated-server.ts)를 띄운다.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // CI는 줄 보고와 함께 JSON 보고서를 남겨 통과·실패·건너뜀 수와 서버 수명 시험의 실행을 판정한다(scripts/check-e2e-report.mjs).
  reporter: process.env.CI
    ? [["line"], ["json", { outputFile: "test-results/e2e-report.json" }]]
    : "list",
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // 공용 API 서버는 globalSetup이 띄우고 정리까지 기다린다(e2e/global-setup.ts). webServer는 Windows에서 서버를 강제로 끝낸다.
  // globalSetup은 webServer 다음에 돌고 그 정리는 webServer를 끄기 전에 돈다.
  globalSetup: "./e2e/global-setup.ts",
  webServer: [
    {
      // 배포할 프로덕션 빌드로 검사하고 성능(MAP_PERF)도 같은 빌드로 잰다. 개발 서버는 테스트마다 새 context가
      // 압축하지 않은 모듈 약 12MB를 다시 받아 실행해, 부하가 큰 기기에서 첫 화면이 기대 시간을 넘긴다.
      command: `vite build && vite preview --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      env: {
        WEB_PORT: String(webPort),
        BABOJUBOT_API: `http://127.0.0.1:${sharedApiPort}`,
      },
      reuseExistingServer: false,
    },
  ],
});
