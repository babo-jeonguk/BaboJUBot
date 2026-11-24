import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runToEnd, runToEndStopMs } from "../e2e/support/playwright-run.ts";

// Playwright의 webServer는 Windows에서 서버를 taskkill /F로 끝내 정리할 기회를 주지 않는다. 그래서 공용 API 서버는
// globalSetup(e2e/global-setup.ts)이 띄우고 정리까지 기다리며, webServer에는 화면 preview만 둔다. 서버 정리 자체는
// E2E의 수명 시험(e2e/support/shared-server.spec.ts)이 확인한다.
// Playwright를 읽는 Node 프로세스를 새로 띄우므로 다른 패키지 검사와 함께 돌 때를 생각해 읽기 시한(`readMs`)을 넉넉히 둔다. 시험
// 시한은 runToEnd의 최악의 길(읽기 시한 + 끈 뒤 종료·출력 닫힘 확인 둘, 각 `runToEndStopMs`)에 시험 정리의 여유(20초)를 더해, 그 길에서도 runToEnd가
// 모은 원인이 시험 시한보다 먼저 보고되게 한다(#287 parent 점검).
const readMs = 50_000;
it(
  "leaves the API server to the global setup and only the web preview to webServer",
  async () => {
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
    // 띄운 직후 끝까지 돌리는 도움에 넘긴다. 도움은 종료와 출력의 끝을 함께 보고, 끝나지 않으면 자식을 끄고 그 끝을 확인한 뒤 실패한다.
    // 돌려받은 뒤에는 자식이 끝났으므로 정리가 그 번호로 신호하지 않는다(#287 리뷰 STD-3·STD-4).
    const { code, stdout, output } = await runToEnd(
      spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: path.dirname(config),
        stdio: ["ignore", "pipe", "pipe"],
      }),
      { timeoutMs: readMs, what: "the config reader" }
    );
    expect(code, output).toBe(0);

    const { globalSetup, commands } = JSON.parse(stdout) as {
      globalSetup: string;
      commands: string[];
    };
    expect(globalSetup).toBe("./e2e/global-setup.ts");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^vite build && vite preview /);
  },
  readMs + 2 * runToEndStopMs + 20_000
);
