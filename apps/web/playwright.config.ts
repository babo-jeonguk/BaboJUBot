import { defineConfig, devices } from "@playwright/test";

const apiPort = 3199;
const webPort = 5199;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : "list",
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // 임시 embedded Postgres를 쓰는 서버. SIGTERM을 받으면 Postgres를 멈추고 dataDir를 지운다.
      command: "node ../server/src/main.ts",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: { PORT: String(apiPort), BABOJUBOT_EPHEMERAL_DB: "1", DATABASE_URL: "" },
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "vite",
      url: `http://127.0.0.1:${webPort}`,
      env: { WEB_PORT: String(webPort), BABOJUBOT_API: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: false,
    },
  ],
});
