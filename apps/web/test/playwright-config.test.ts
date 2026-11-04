import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// E2E 서버는 Windows에서 taskkill /F로, 다른 OS에서도 제한 시간을 넘기면 SIGKILL로 끝나 스스로 정리하지 못한다.
// 그래서 서버의 제품 폴더는 서버보다 오래 사는 Playwright 실행기가 만들어 넘기고, 실행기가 끝날 때 지운다.
it("gives the E2E server a temporary product folder that the runner removes when it ends", async () => {
  const config = fileURLToPath(
    new URL("../playwright.config.ts", import.meta.url)
  );
  const script = `
    import { existsSync } from "node:fs";
    const { default: config } = await import(${JSON.stringify(pathToFileURL(config).href)});
    const home = config.webServer[0].env.BABOJUBOT_HOME;
    console.log(JSON.stringify({ home, exists: Boolean(home) && existsSync(home) }));
  `;
  const env = { ...process.env };
  delete env.BABOJUBOT_E2E_HOME;
  const runner = spawn(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: path.dirname(config),
      env,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  let output = "";
  runner.stdout!.on("data", (chunk) => (output += chunk));
  const [code] = await once(runner, "exit");
  expect(code).toBe(0);

  const { home, exists } = JSON.parse(output) as {
    home?: string;
    exists: boolean;
  };
  expect(home).toBeDefined();
  expect(exists).toBe(true);
  const fromTmp = path.relative(
    realpathSync(tmpdir()),
    realpathSync.native(path.dirname(home!))
  );
  expect(fromTmp.startsWith("..") || path.isAbsolute(fromTmp)).toBe(false);
  expect(existsSync(home!)).toBe(false);
});
