import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const apiPort = 3199;
const webPort = 5199;
// E2E 서버의 정리 시한. 실행기는 그보다 길게 기다려, 서버가 스스로 끝나며 내장 Postgres를 멈출 기회를 준다.
// 실행기가 먼저 강제로 끝내면(SIGKILL) 따로 떨어진 프로세스 그룹의 Postgres가 남는다.
const serverShutdownMs = 10_000;

// E2E 서버의 제품 폴더(BABOJUBOT_HOME). 서버는 Windows에서 taskkill /F로, 다른 OS에서도 제한 시간을 넘기면 SIGKILL로
// 끝나 스스로 정리하지 못한다. 그래서 서버보다 오래 사는 이 실행기가 만들어 넘기고, 실행기가 끝날 때 지운다.
// 이 설정을 다시 읽는 worker는 환경 변수로 같은 폴더를 물려받고, 폴더를 만든 프로세스만 지운다.
const productHome = process.env.BABOJUBOT_E2E_HOME ?? createProductHome();

function createProductHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "babojubot-e2e-home-"));
  process.env.BABOJUBOT_E2E_HOME = home;
  process.on("exit", () =>
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  );
  return home;
}

export default defineConfig({
  testDir: "e2e",
  // 여러 화면을 거치는 시나리오에 느린 CI runner·부하가 큰 로컬 기기의 여유를 준다. 개별 expect 대기는 기본값을 유지한다.
  timeout: 120_000,
  // spec들이 E2E 서버와 DB 하나를 같이 쓴다. 빈 DB를 전제하는 조직 생성 spec이 먼저 돌도록 파일 순서대로 하나씩 실행한다.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : "list",
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // 임시 embedded Postgres와 실행기가 만든 제품 폴더를 쓰는 서버. SIGTERM을 받으면 Postgres를 멈추고 그 dataDir를 지운다.
      command: "node ../server/src/main.ts",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: {
        PORT: String(apiPort),
        BABOJUBOT_EPHEMERAL_DB: "1",
        BABOJUBOT_HOME: productHome,
        BABOJUBOT_SHUTDOWN_TIMEOUT_MS: String(serverShutdownMs),
        DATABASE_URL: "",
        // 같은 가짜 adapter의 연결 둘로 프로바이더·모델 고르기를 검사한다(providers.spec.ts).
        BABOJUBOT_FAKE_PROVIDERS: "2",
        // `fake-2`는 끼워 넣기를 못 하고 제품 로그인이 없어 준비안됨이다(provider-contract.spec.ts).
        BABOJUBOT_FAKE_PROVIDER_SETTINGS: JSON.stringify({
          "fake-2": {
            capabilities: { steer: false },
            readiness: { status: "not_ready", reason: "product_login_missing" },
          },
        }),
      },
      gracefulShutdown: {
        signal: "SIGTERM",
        timeout: serverShutdownMs + 5_000,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // 배포할 프로덕션 빌드로 검사하고 성능(MAP_PERF)도 같은 빌드로 잰다. 개발 서버는 테스트마다 새 context가
      // 압축하지 않은 모듈 약 12MB를 다시 받아 실행해, 부하가 큰 기기에서 첫 화면이 기대 시간을 넘긴다.
      command: `vite build && vite preview --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      env: {
        WEB_PORT: String(webPort),
        BABOJUBOT_API: `http://127.0.0.1:${apiPort}`,
      },
      reuseExistingServer: false,
    },
  ],
});
