// 시험 러너가 모으는 파일이면 확장자와 상관없이 같은 시험 규칙과 타입 정보를 받는지 본다(#270). 러너는 vitest 기본 include
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`)와 Playwright 기본 testMatch로 여덟 형식을 모두 모으는데, lint의 시험 범위·화면 규칙·TypeScript
// 프로젝트는 각자 몇 형식만 담아 확장자만 바꾸면 규칙을 피할 수 있었다. 파일은 만들지 않고 설정을 판정한다.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const eslint = new ESLint({ cwd: repository });
const ts = createRequire(import.meta.url)("typescript");

/** vitest·Playwright가 기본으로 모으는 형식. */
const runnerFormats = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
/** 시험 파일·시험 도움이 놓이는 자리(확장자 앞까지). */
const testPlaces = [
  "packages/core/src/sample.test",
  "packages/core/src/sample.spec",
  "packages/runtime/src/providers/sample.test",
  "apps/server/test/sample.test",
  "apps/server/test/sample-support",
  "apps/web/src/sample.test",
  "apps/web/e2e/sample.spec",
  "apps/web/e2e/support/sample",
  "scripts/sample.test",
  "scripts/live/sample.test",
  ".agents/scripts/sample.test",
];
const e2ePlaces = ["apps/web/e2e/sample.spec", "apps/web/e2e/support/sample"];
/** 개발 스크립트(시험이 아닌 파일)의 자리. */
const scriptPlaces = ["scripts/sample", "scripts/live/sample"];

const rulesOf = async (file) =>
  (await eslint.calculateConfigForFile(file))?.rules ?? {};
const isError = (setting) =>
  setting !== undefined && [2, "error"].includes(setting[0] ?? setting);

/** 빠진 조합을 모두 모아 한 번에 보인다. */
async function missing(places, rules) {
  const gaps = [];
  for (const place of places)
    for (const format of runnerFormats) {
      const file = `${place}.${format}`;
      const set = await rulesOf(file);
      for (const rule of rules)
        if (!isError(set[rule])) gaps.push(`${file} ${rule}`);
    }
  return gaps;
}

test("every test file format a runner collects gets the test rules", async () => {
  assert.deepEqual(
    await missing(testPlaces, [
      "tests/no-fixed-time-wait",
      "tests/no-skipped-cleanup",
    ]),
    []
  );
});

test("every E2E file format gets the screen rules", async () => {
  assert.deepEqual(
    await missing(e2ePlaces, [
      "tests/no-page-wide-locator",
      "tests/no-one-shot-ui-read",
    ]),
    []
  );
});

test("every development script format gets the script rules", async () => {
  assert.deepEqual(
    await missing(scriptPlaces, [
      "product/no-ignored-error",
      "product/no-silent-exit-status",
    ]),
    []
  );
});

test("runner configs get the test rules", async () => {
  const configs = [
    "packages/core/vitest.config.ts",
    "packages/runtime/vitest.alone.config.ts",
    "apps/server/vitest.files.config.ts",
    "apps/web/playwright.config.ts",
    "apps/web/e2e/support/shared-settings-run/playwright.config.ts",
  ];
  const gaps = [];
  for (const file of configs)
    if (!isError((await rulesOf(file))["tests/no-fixed-time-wait"]))
      gaps.push(file);
  assert.deepEqual(gaps, []);
});

/**
 * 파일이 가장 가까운 tsconfig.json의 프로그램에 드는가. 타입 정보를 쓰는 규칙(Promise·화면)은 그 프로그램에서 타입을 얻는다. 파일을 만들지
 * 않으려고 그 폴더에 표본 하나가 있는 것처럼 보이게 하고, include·exclude·확장자·allowJs 판정은 TypeScript에 맡긴다.
 */
function inProject(relative) {
  const file = path.join(repository, relative);
  const configPath = ts.findConfigFile(
    path.dirname(file),
    ts.sys.fileExists,
    "tsconfig.json"
  );
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const base = path.dirname(configPath);
  // 표본이 든 폴더만 보이는 가짜 파일 시스템. TypeScript의 matchFiles(내부 함수)가 include 판정을 한다.
  const entries = (dir) => {
    const rest = path.relative(dir, file);
    if (rest.startsWith("..")) return { files: [], directories: [] };
    const [first, ...deeper] = rest.split(path.sep);
    return deeper.length
      ? { files: [], directories: [first] }
      : { files: [first], directories: [] };
  };
  const host = {
    ...ts.sys,
    readDirectory: (root, extensions, excludes, includes, depth) =>
      ts.matchFiles(
        root,
        extensions,
        excludes,
        includes,
        ts.sys.useCaseSensitiveFileNames,
        base,
        depth,
        entries,
        (p) => p
      ),
  };
  return ts
    .parseJsonConfigFileContent(config, host, base)
    .fileNames.some((name) => path.resolve(name) === file);
}

test("every test file format belongs to a TypeScript project", () => {
  const gaps = [];
  for (const place of [...testPlaces, ...scriptPlaces])
    for (const format of runnerFormats) {
      const file = `${place}.${format}`;
      if (!inProject(file)) gaps.push(file);
    }
  assert.deepEqual(gaps, []);
});

test("the project check sees a file it should (a check that cannot fail proves nothing)", () => {
  assert.equal(inProject("packages/core/src/sample.test.ts"), true);
  // 프로젝트 밖(빌드 산출물 폴더)은 들지 않는다.
  assert.equal(inProject("packages/core/dist/sample.test.ts"), false);
});
