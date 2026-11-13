import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { alive } from "./server-process.ts";

// 공용 E2E 서버의 수명은 globalSetup이 가진다(e2e/global-setup.ts). 테스트가 성공해도, 본문이 실패해도, setup이 서버를 띄운 뒤
// 실패해도 Playwright가 끝나기 전에 서버가 정상 정리(종료 코드 0, 내장 Postgres 정지와 그 dataDir 삭제)를 마치고 폴더가 남지
// 않아야 한다. 실패는 원래 실패 그대로 남는다. 같은 globalSetup을 빈 port로 쓰는 Playwright 실행(shared-server-run/)을 따로
// 띄워 확인한다. Windows에서도 같은 길이다.

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
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
    const [code] = (await once(child, "exit")) as [number | null];
    const state = existsSync(stateFile)
      ? (JSON.parse(readFileSync(stateFile, "utf8")) as {
          pid: number;
          postgresPid: number;
          folder: string;
        })
      : undefined;
    return { code, output, state };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 안쪽 실행이 끝났을 때 공용 서버가 남긴 것이 없다. 다음 서버를 띄우기 전에 본다. */
function expectNothingLeft(
  state: { pid: number; postgresPid: number; folder: string } | undefined,
  output: string
) {
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
