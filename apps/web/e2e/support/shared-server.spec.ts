import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { runPlaywright, runToEndStopMs } from "./playwright-run.ts";
import { alive, type ServerProcess } from "./server-process.ts";
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";

// 공용 E2E 서버의 수명은 globalSetup이 가진다(e2e/global-setup.ts). 테스트가 성공해도, 본문이 실패해도, setup이 서버를 띄운 뒤
// 실패해도 Playwright가 끝나기 전에 서버가 정상 정리(종료 코드 0, 내장 Postgres 정지와 그 dataDir 삭제)를 마치고 폴더가 남지
// 않아야 한다. 실패는 원래 실패 그대로 남는다. 같은 globalSetup을 빈 port로 쓰는 Playwright 실행(shared-server-run/)을 따로
// 띄워 확인한다. Windows에서도 같은 길이다.

/** 안쪽 실행의 setup이 적는 공용 서버(shared-server-run/setup.ts). */
type SharedState = Pick<ServerProcess, "pid" | "postgresPid" | "folder">;
/**
 * 안쪽 실행 하나의 시한. 시작(내장 DB 초기화)·안쪽 테스트·정리(서버 정리 시한 + 여유)를 담는 공용 준비의 상한이다(#215).
 * 바깥 테스트 시한은 이 시한에 여유를 더해 따로 정하므로, 느린 기기에서도 안쪽 실행이 바깥 시한에 먼저 걸리지 않는다.
 */
const runTimeoutMs = 180_000;
// 바깥 시한은 안쪽 실행의 최악의 길(시한 + 끈 뒤 종료·출력 닫힘 확인 둘, 각 `runToEndStopMs`)에 바깥 정리의 여유(20초)를 더한다. 그 길에서도
// runPlaywright가 모은 원인이 바깥 시한보다 먼저 보고된다.
test.describe.configure({
  timeout: runTimeoutMs + 2 * runToEndStopMs + 20_000,
});

const config = fileURLToPath(
  new URL("./shared-server-run/playwright.config.ts", import.meta.url)
);

/** `failure`: 안쪽 실행에서 실패할 곳. */
async function runShared(failure: "none" | "body" | "setup") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "babojubot-shared-run-"));
  const stateFile = path.join(dir, "state.json");
  return withCleanup(async (defer) => {
    defer(() => removeFolder(dir));
    // 시한을 넘기면 안쪽 실행을 끝내고 실패로 알린다. 그때 남은 공용 서버는 채널이 끊겨 스스로 정리한다.
    const { code, output } = await runPlaywright({
      config,
      timeoutMs: runTimeoutMs,
      prefix: "SHARED_SERVER_RUN_",
      env: {
        SHARED_SERVER_RUN_STATE: stateFile,
        SHARED_SERVER_RUN_OUTPUT: path.join(dir, "results"),
        ...(failure === "body" && { SHARED_SERVER_RUN_FAIL_BODY: "1" }),
        ...(failure === "setup" && { SHARED_SERVER_RUN_FAIL_SETUP: "1" }),
      },
    });
    const state = existsSync(stateFile)
      ? (JSON.parse(readFileSync(stateFile, "utf8")) as SharedState)
      : undefined;
    return { code, output, state };
  });
}

/** 안쪽 실행이 끝났을 때 공용 서버가 남긴 것이 없다. 다음 서버를 띄우기 전에 본다. */
function expectNothingLeft(state: SharedState | undefined, output: string) {
  expect(state, output).toBeDefined();
  expect(alive(state!.pid), output).toBe(false);
  expect(alive(state!.postgresPid), output).toBe(false);
  expect(existsSync(state!.folder), output).toBe(false);
}

test("the shared server finishes its cleanup when the run passes", async () => {
  const { code, output, state } = await runShared("none");
  expect(code, output).toBe(0);
  expect(output).toContain("1 passed");
  expectNothingLeft(state, output);
});

test("the shared server finishes its cleanup and the run keeps the failure when a test fails", async () => {
  const { code, output, state } = await runShared("body");
  expect(code, output).toBe(1);
  expect(output).toContain("body failed on purpose");
  expect(output).toContain("1 failed");
  expectNothingLeft(state, output);
});

test("the shared server finishes its cleanup and the run keeps the failure when setup fails after starting it", async () => {
  const { code, output, state } = await runShared("setup");
  expect(code, output).toBe(1);
  expect(output).toContain("setup failed on purpose");
  expectNothingLeft(state, output);
});
