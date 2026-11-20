import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type {
  JSONReport,
  JSONReportSuite,
  JSONReportTestResult,
} from "@playwright/test/reporter";
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { runPlaywright } from "./playwright-run.ts";
import type { Entry } from "./shared-settings-run/fixture.ts";
import { readSettings } from "./shared-settings.ts";

// `sharedSettings` fixture(shared-settings.ts)는 테스트가 전역 설정을 바꾸고 화면의 저장을 붙잡은 채 끝나거나 실패해도,
// 보낸 저장이 끝나기를 기다린 뒤 시작 전 값으로 되돌린다. fixture 정리는 테스트가 끝난 뒤에 돌므로, 그 fixture를 쓰는 테스트 하나를
// 안쪽 Playwright 실행(shared-settings-run/)으로 띄우고 바깥 테스트가 그 실행의 결과·기록과 정리 뒤 설정을 본다. 안쪽 실행은 이
// E2E의 화면·API 서버를 같이 쓴다. 바깥 E2E는 한 번에 테스트 하나만 돌므로(playwright.config.ts `workers`) 그동안 다른 테스트가
// 전역 설정을 바꾸지 않는다.

/** 안쪽 실행 하나의 시한. 브라우저 시작과 안쪽 테스트(시한 60초)·fixture 정리를 담는다. 바깥 테스트 시한은 여유를 더한다. */
const runTimeoutMs = 120_000;
test.describe.configure({ timeout: runTimeoutMs + 30_000 });

const config = fileURLToPath(
  new URL("./shared-settings-run/playwright.config.ts", import.meta.url)
);

/** 안쪽 실행의 테스트 결과(JSON 보고서)를 모두 편다. */
function resultsOf(suites: JSONReportSuite[] | undefined): {
  title: string;
  results: JSONReportTestResult[];
}[] {
  return (suites ?? []).flatMap((suite) => [
    ...suite.specs.flatMap((spec) =>
      spec.tests.map((t) => ({ title: spec.title, results: t.results }))
    ),
    ...resultsOf(suite.suites),
  ]);
}

/** `file`(shared-settings-run/의 `*.check.ts`)의 테스트 하나를 안쪽 실행으로 돌린다. */
async function runCheck(file: string, baseURL: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "babojubot-settings-run-"));
  const reportFile = path.join(dir, "report.json");
  const logFile = path.join(dir, "log.jsonl");
  return withCleanup(async (defer) => {
    defer(() => removeFolder(dir));
    const { code, output } = await runPlaywright({
      config,
      timeoutMs: runTimeoutMs,
      prefix: "SHARED_SETTINGS_RUN_",
      args: [file],
      env: {
        SHARED_SETTINGS_RUN_URL: baseURL,
        SHARED_SETTINGS_RUN_REPORT: reportFile,
        SHARED_SETTINGS_RUN_LOG: logFile,
        SHARED_SETTINGS_RUN_OUTPUT: path.join(dir, "results"),
      },
    });
    expect(existsSync(reportFile), output).toBe(true);
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as JSONReport;
    expect(report.errors, output).toEqual([]);
    const tests = resultsOf(report.suites);
    // 안쪽 실행은 다시 시도하지 않으므로 테스트 하나에 결과 하나다.
    expect(
      tests.map((t) => t.results.length),
      output
    ).toEqual([1]);
    const log = existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Entry)
      : [];
    return { code, output, result: tests[0]!.results[0]!, log };
  });
}

/** 안쪽 실행이 끝난 뒤 서버의 전역 설정이 안쪽 실행 전 값과 같다. */
async function expectSettingsAsBefore(
  request: APIRequestContext,
  before: Awaited<ReturnType<typeof readSettings>>,
  output: string
) {
  expect(await readSettings(request), output).toEqual(before);
}

test("a test that ends while a settings save is held cleans up and hands back the settings it started with", async ({
  request,
  baseURL,
}) => {
  const before = await readSettings(request);
  const { code, output, result } = await runCheck(
    "ends-mid-save.check.ts",
    baseURL!
  );
  // fixture 정리가 실패하면 그 실패가 이 테스트의 오류로 남는다.
  expect(result.errors, output).toEqual([]);
  expect(result.status, output).toBe("passed");
  expect(code, output).toBe(0);
  await expectSettingsAsBefore(request, before, output);
});

test("a test that fails while a settings save is held keeps only its own failure and hands back the settings it started with", async ({
  request,
  baseURL,
}) => {
  const before = await readSettings(request);
  const { code, output, result } = await runCheck(
    "fails-mid-save.check.ts",
    baseURL!
  );
  // 실패는 본문 끝의 의도된 오류 하나다. 설정 변경이 앞서 실패했거나 fixture 정리가 실패하면 다른 오류가 남는다.
  expect(
    result.errors.map((e) => e.message?.split("\n")[0]),
    output
  ).toEqual(["Error: mid-save body failed on purpose"]);
  expect(result.status, output).toBe("failed");
  expect(code, output).toBe(1);
  await expectSettingsAsBefore(request, before, output);
});

test("a test that ends while a released settings save is still on its way restores after that save", async ({
  request,
  baseURL,
}) => {
  const before = await readSettings(request);
  // 늦은 저장은 압축 기준을 600000으로 바꾼다. 시작 값이 이미 그 값이면 늦은 저장이 되돌린 값을 덮어도 알 수 없다.
  expect(before.compaction).toBeDefined();
  expect(before.compaction!.thresholdTokens).not.toBe(600000);
  const { code, output, result, log } = await runCheck(
    "late-save.check.ts",
    baseURL!
  );
  expect(result.errors, output).toEqual([]);
  expect(result.status, output).toBe("passed");
  expect(code, output).toBe(0);
  // 늦은 저장이 서버에 받아들여진 뒤에 fixture가 되돌리기 시작했다. 거절된 저장은 아무것도 바꾸지 않아 되돌린 값과 비교해도 드러나지 않는다.
  expect(log.slice(0, 2), output).toEqual([
    { step: "late write answered", status: 200, thresholdTokens: 600000 },
    { step: "api put", path: "/api/providers/defaults" },
  ]);
  await expectSettingsAsBefore(request, before, output);
});

test("a test whose sent settings save never gets a reply fails its cleanup in time and still hands back the settings", async ({
  request,
  baseURL,
}) => {
  const before = await readSettings(request);
  const { code, output, result, log } = await runCheck(
    "stuck-save.check.ts",
    baseURL!
  );
  // 정리는 응답을 시한(10초) 안에서만 기다리고 그 사실 하나로 실패한다. 응답을 다시 기다려 멈추면 안쪽 시한(60초)에 걸려 다른 오류가 된다.
  expect(
    result.errors.map((e) => e.message?.split("\n")[0]),
    output
  ).toEqual([
    "Error: 10000ms 안에 이 테스트가 보낸 전역 설정 변경이 끝나지 않았다",
  ]);
  expect(result.status, output).toBe("failed");
  expect(code, output).toBe(1);
  // 실패한 뒤에도 되돌리기를 했다.
  expect(log, output).toContainEqual({
    step: "api put",
    path: "/api/providers/defaults",
  });
  await expectSettingsAsBefore(request, before, output);
});
