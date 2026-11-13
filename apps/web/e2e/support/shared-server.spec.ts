import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { alive, type ServerProcess } from "./server-process.ts";

// 공용 E2E 서버의 수명은 globalSetup이 가진다(e2e/global-setup.ts). 테스트가 성공해도, 본문이 실패해도, setup이 서버를 띄운 뒤
// 실패해도 Playwright가 끝나기 전에 서버가 정상 정리(종료 코드 0, 내장 Postgres 정지와 그 dataDir 삭제)를 마치고 폴더가 남지
// 않아야 한다. 실패는 원래 실패 그대로 남는다. 같은 globalSetup을 빈 port로 쓰는 Playwright 실행(shared-server-run/)을 따로
// 띄워 확인한다. Windows에서도 같은 길이다.

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
/** 안쪽 실행의 setup이 적는 공용 서버(shared-server-run/setup.ts). */
type SharedState = Pick<ServerProcess, "pid" | "postgresPid" | "folder">;
/** 안쪽 실행 하나의 시한. 시작(내장 DB)·정리(서버 정리 시한 + 여유)를 넉넉히 담고 바깥 테스트 시한(120초)보다 짧다. */
const runTimeoutMs = 90_000;

const config = fileURLToPath(
  new URL("./shared-server-run/playwright.config.ts", import.meta.url)
);

/** 바깥 Playwright의 실행 설정이 안쪽 실행에 새지 않게 지운다. */
function runEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (upper.startsWith("TEST_") || upper.startsWith("PW_")) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** `failure`: 안쪽 실행에서 실패할 곳. */
async function runShared(failure: "none" | "body" | "setup") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "babojubot-shared-run-"));
  const stateFile = path.join(dir, "state.json");
  try {
    const child = spawn(process.execPath, [cli, "test", "--config", config], {
      cwd: path.dirname(config),
      env: runEnv({
        SHARED_SERVER_RUN_STATE: stateFile,
        SHARED_SERVER_RUN_OUTPUT: path.join(dir, "results"),
        ...(failure === "body" && { SHARED_SERVER_RUN_FAIL_BODY: "1" }),
        ...(failure === "setup" && { SHARED_SERVER_RUN_FAIL_SETUP: "1" }),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    // 시한을 넘기면 안쪽 실행을 끝내고 실패로 알린다. 그때 남은 공용 서버는 채널이 끊겨 스스로 정리한다.
    const exit = once(child, "exit") as Promise<[number | null]>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), runTimeoutMs);
    });
    const finished = await Promise.race([exit, timedOut]).finally(() =>
      clearTimeout(timer)
    );
    if (!finished) {
      child.kill("SIGKILL");
      await exit;
      throw new Error(
        `안쪽 Playwright 실행이 ${runTimeoutMs}ms 안에 끝나지 않았다: ${output}`
      );
    }
    const [code] = finished;
    const state = existsSync(stateFile)
      ? (JSON.parse(readFileSync(stateFile, "utf8")) as SharedState)
      : undefined;
    return { code, output, state };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
