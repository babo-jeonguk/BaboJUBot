import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// Playwright의 webServer는 Windows에서 서버를 taskkill /F로 끝내 정리할 기회를 주지 않는다. 그래서 공용 API 서버는
// globalSetup(e2e/global-setup.ts)이 띄우고 정리까지 기다리며, webServer에는 화면 preview만 둔다. 서버 정리 자체는
// E2E의 수명 시험(e2e/support/shared-server.spec.ts)이 확인한다.
// Playwright를 읽는 Node 프로세스를 새로 띄우므로 다른 패키지 검사와 함께 돌 때를 생각해 시간 제한을 넉넉히 둔다.
it("leaves the API server to the global setup and only the web preview to webServer", async () => {
  const config = fileURLToPath(
    new URL("../playwright.config.ts", import.meta.url)
  );
  const script = `
    const { default: config } = await import(${JSON.stringify(pathToFileURL(config).href)});
    console.log(JSON.stringify({
      globalSetup: config.globalSetup,
      commands: [config.webServer].flat().map((server) => server.command),
    }));
  `;
  const runner = spawn(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: path.dirname(config), stdio: ["ignore", "pipe", "inherit"] }
  );
  let output = "";
  runner.stdout!.on("data", (chunk) => (output += chunk));
  const [code] = await once(runner, "exit");
  expect(code).toBe(0);

  const { globalSetup, commands } = JSON.parse(output) as {
    globalSetup: string;
    commands: string[];
  };
  expect(globalSetup).toBe("./e2e/global-setup.ts");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatch(/^vite build && vite preview /);
}, 60_000);
