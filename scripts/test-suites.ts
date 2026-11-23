// 시험 묶음 정의. CI의 시험 실행과 그 결과 판정이 이 한 곳을 읽는다(#286 항목 19·20):
// - Vitest 설정은 묶음의 include·exclude와 보고기를 vitest.reports.ts의 suiteTest(<묶음>)로 받는다.
// - node:test 묶음은 scripts/run-node-tests.mjs <묶음>이 여기 적은 파일을 돈다.
// - scripts/check-test-reports.mjs는 묶음마다 기대하는 시험 파일을 실행과 따로, 저장소의 파일 목록(Git)과 이 정의로 정해 보고서와
//   대조한다. 설정 필터나 명령에서 시험 파일 하나가 통째로 빠지면 그 파일이 돌지 않았다고 실패한다.
// - 저장소의 시험 파일은 모두 어느 묶음에 들어야 한다(scripts/check-test-reports.test.mjs).
// CI는 workflow env BABOJUBOT_REQUIRE_TEST_REPORTS=1로 보고서를 필수로 한다. 그때 보고 폴더(BABOJUBOT_TEST_REPORTS) 없이, 또는 그 job의
// 판정이 끝난 뒤에 도는 묶음은 시작하지 않고 실패한다(reportFolder). 명령 모양으로 묶음을 찾지 않으므로 래퍼 스크립트로 옮겨도 빠지지 않는다.
import { statSync } from "node:fs";
import path from "node:path";
import { codeFormats } from "./test-files.mjs";

/** Vitest 묶음: 패키지 폴더의 설정 하나. include·exclude는 그 폴더 기준 glob이다. */
export type VitestSuite = {
  name: string;
  runner: "vitest";
  folder: string;
  config: string;
  include: string[];
  exclude?: string[];
};
/** node:test 묶음: 저장소 기준 시험 파일 목록. */
export type NodeSuite = { name: string; runner: "node"; files: string[] };
/** Playwright 묶음: 판정은 scripts/check-e2e-report.mjs가 E2E 폴더의 spec 목록으로 따로 한다. */
export type PlaywrightSuite = {
  name: string;
  runner: "playwright";
  folder: string;
  include: string[];
};
export type TestSuite = VitestSuite | NodeSuite | PlaywrightSuite;

/** Vitest 기본 include(`**\/*.{test,spec}.?(c|m)[jt]s?(x)`)와 같은 형식의 시험 파일. */
const allTests = `**/*.{test,spec}.${codeFormats}`;
/** 다른 시험과 겹치면 안 되어 나머지가 끝난 뒤 하나씩 도는 시험(vitest.alone.config.ts). */
const aloneTests = `src/**/*.alone.test.${codeFormats}`;

export const testSuites: TestSuite[] = [
  ...["contracts", "core", "db", "files"].map((name): VitestSuite => ({
    name,
    runner: "vitest",
    folder: `packages/${name}`,
    config: "vitest.config.ts",
    include: [allTests],
  })),
  ...["process", "runtime"].flatMap((name): VitestSuite[] => [
    {
      name,
      runner: "vitest",
      folder: `packages/${name}`,
      config: "vitest.config.ts",
      include: [allTests],
      exclude: [aloneTests],
    },
    {
      name: `${name}-alone`,
      runner: "vitest",
      folder: `packages/${name}`,
      config: "vitest.alone.config.ts",
      include: [aloneTests],
    },
  ]),
  {
    name: "server",
    runner: "vitest",
    folder: "apps/server",
    config: "vitest.config.ts",
    include: [allTests],
    // 실제 OpenCode CLI가 있어야 하는 시험은 그 CLI를 설치하는 CI job이 따로 돈다(server-opencode).
    exclude: ["test/opencode-real-cli.test.ts"],
  },
  {
    name: "server-opencode",
    runner: "vitest",
    folder: "apps/server",
    config: "vitest.opencode.config.ts",
    include: ["test/opencode-real-cli.test.ts"],
  },
  // 시스템마다 다른 파일 식별을 실제 볼륨에서 돌린다(macOS·Windows job, 파일 경계 job).
  {
    name: "server-files",
    runner: "vitest",
    folder: "apps/server",
    config: "vitest.files.config.ts",
    include: [
      "test/workspace.test.ts",
      "test/workspace-race.test.ts",
      "test/workspace-cases.test.ts",
    ],
  },
  // Windows E2E job이 서버 진입점의 멈춤을 그 시스템에서 본다.
  {
    name: "server-stop",
    runner: "vitest",
    folder: "apps/server",
    config: "vitest.stop.config.ts",
    include: ["src/stop-request.test.ts", "test/main.test.ts"],
  },
  {
    name: "web",
    runner: "vitest",
    folder: "apps/web",
    config: "vitest.config.ts",
    include: [
      `src/**/*.{test,spec}.${codeFormats}`,
      `test/**/*.{test,spec}.${codeFormats}`,
    ],
  },
  {
    name: "e2e",
    runner: "playwright",
    folder: "apps/web",
    // playwright.config.ts의 testDir `e2e`와 Playwright 기본 testMatch.
    include: [`e2e/**/*.{spec,test}.${codeFormats}`],
  },
  {
    name: "check-rules",
    runner: "node",
    files: [
      "scripts/eslint-imports.test.mjs",
      "scripts/lint-access-shapes.test.mjs",
      "scripts/lint-rules.test.mjs",
      "scripts/lint-scope.test.mjs",
      "scripts/product-lint-rules.test.mjs",
      "scripts/script-lint-rules.test.mjs",
    ],
  },
  {
    name: "check-agents",
    runner: "node",
    files: [
      ".agents/scripts/check-worker-change.test.ts",
      ".agents/scripts/json-field.test.ts",
      ".agents/scripts/run-worker.test.ts",
      ".agents/scripts/worker-permissions.test.ts",
      ".agents/scripts/worker-run.test.ts",
      ".agents/scripts/worker-summary.test.ts",
      ".agents/skills/reference-first/scripts/mock-llm.test.ts",
    ],
  },
  {
    name: "check-scripts",
    runner: "node",
    files: [
      "scripts/check-project.test.mjs",
      "scripts/check-code-map.test.mjs",
      "scripts/markdown.test.ts",
      "scripts/boot-check-overview.test.ts",
      "scripts/exit-after-output.test.ts",
      "scripts/gh-post.test.mjs",
      "scripts/ci-test-gate.test.mjs",
      "scripts/check-test-reports.test.mjs",
      "scripts/ci-job-failures.test.mjs",
      "scripts/ci-downloads.test.mjs",
      "scripts/ci-changes.test.mjs",
      "scripts/file-boundary-report.test.mjs",
      "scripts/typecheck-js.test.mjs",
      "scripts/javascript-files.test.ts",
      "scripts/check-e2e-report.test.mjs",
      "scripts/verify-changed.test.mjs",
      "scripts/live/check-server.test.mjs",
      "scripts/live/processes.test.mjs",
      "scripts/live/chaos-budget.test.mjs",
      "scripts/live/chaos-run.test.mjs",
      "scripts/live/chaos-server.test.mjs",
      "scripts/live/provider-scenes.test.mjs",
      "scripts/live/provider-arguments.test.mjs",
      "scripts/live/record-cli.test.mjs",
    ],
  },
  // 실제 서버·내장 DB를 띄우는 부팅 확인(pnpm test:root, CI db·macOS·Windows job).
  {
    name: "boot-check",
    runner: "node",
    files: ["scripts/boot-check-flow.test.mjs", "scripts/boot-check.test.mjs"],
  },
  // CI 집계 판정이 macOS·Windows에서도 도는지(Linux는 check-scripts가 같은 파일을 돈다).
  {
    name: "ci-gate",
    runner: "node",
    files: ["scripts/ci-test-gate.test.mjs"],
  },
  // 작업자 실행기를 macOS·Windows에서 돈다(Linux는 check-agents가 같은 파일을 돈다).
  {
    name: "worker-runner",
    runner: "node",
    files: [
      ".agents/scripts/run-worker.test.ts",
      ".agents/scripts/worker-run.test.ts",
    ],
  },
];

/**
 * 시험 이름을 가졌지만 묶음이 아닌 파일: 시험이 일부러 돌려 결과를 보는 입력이다(실패·건너뜀 보고서를 만드는 node:test 파일,
 * 실패 종료 코드를 확인하는 vitest 파일). 묶음으로 돌리면 일부러 실패한다.
 */
export const testInputs = ["scripts/fixtures/**"];

const byName = new Map(testSuites.map((suite) => [suite.name, suite]));

/** 이름의 묶음. 모르는 이름이면 던진다. */
export function suiteNamed(name: string): TestSuite {
  const suite = byName.get(name);
  if (!suite)
    throw new Error(
      `unknown test suite "${name}" (scripts/test-suites.ts: ${[...byName.keys()].join(", ")})`
    );
  return suite;
}

const posix = (file: string) => file.replaceAll("\\", "/");

/** 묶음이 고르는 시험 파일(저장소 기준 경로, 정렬). `files`는 저장소의 파일 목록(Git)이다. */
export function suiteFiles(suite: TestSuite, files: string[]): string[] {
  // node:test 묶음은 적은 파일 그대로다. 적은 파일이 저장소에 없으면 실행기가 실패하고, 시험(scripts/check-test-reports.test.mjs)도 짚는다.
  if (suite.runner === "node") return [...suite.files].sort();
  const prefix = `${suite.folder}/`;
  const exclude = suite.runner === "vitest" ? (suite.exclude ?? []) : [];
  return files
    .map(posix)
    .filter((file) => file.startsWith(prefix))
    .filter((file) => {
      const inner = file.slice(prefix.length);
      return (
        suite.include.some((pattern) =>
          path.posix.matchesGlob(inner, pattern)
        ) && !exclude.some((pattern) => path.posix.matchesGlob(inner, pattern))
      );
    })
    .sort();
}

/** 묶음이 아닌 시험 입력인가. */
export function isTestInput(file: string): boolean {
  return testInputs.some((pattern) =>
    path.posix.matchesGlob(posix(file), pattern)
  );
}

/** 판정 단계가 보고 폴더에 남기는 표식. 그 뒤에 도는 묶음의 보고서는 판정되지 않으므로 시작하지 않는다. */
export const judgedMarker = "judged";

/**
 * 이 실행의 보고 폴더. 없으면(로컬) undefined. CI가 보고서를 필수로 했는데(BABOJUBOT_REQUIRE_TEST_REPORTS=1) 폴더가 없거나, 그
 * 폴더를 판정 단계가 이미 판정했으면 묶음 `name`을 시작하지 않고 던진다.
 */
export function reportFolder(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const folder = env.BABOJUBOT_TEST_REPORTS || undefined;
  if (folder === undefined) {
    if (env.BABOJUBOT_REQUIRE_TEST_REPORTS === "1")
      throw new Error(
        `test suite ${name} runs where CI requires a report (BABOJUBOT_REQUIRE_TEST_REPORTS=1) but no report folder is given (BABOJUBOT_TEST_REPORTS); run it in a job that gives one and checks the counts (scripts/check-test-reports.mjs)`
      );
    return undefined;
  }
  if (statSync(path.join(folder, judgedMarker), { throwIfNoEntry: false }))
    throw new Error(
      `test suite ${name} runs after this job's reports were judged (${path.join(folder, judgedMarker)}); run it before the job's "Check test counts" step`
    );
  return folder;
}
