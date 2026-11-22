// 시험 러너가 모으는 파일이면 확장자와 상관없이 같은 시험 규칙과 타입 정보를 받는지 본다(#270). 러너는 vitest 기본 include
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`)와 Playwright 기본 testMatch로 여덟 형식을 모두 모으는데, lint의 시험 범위·화면 규칙·TypeScript
// 프로젝트는 각자 몇 형식만 담아 확장자만 바꾸면 규칙을 피할 수 있었다. 파일은 만들지 않고 설정을 판정한다.
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import { ESLint } from "eslint";
import { codeFormats } from "./test-files.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const eslint = new ESLint({ cwd: repository });
const ts = createRequire(import.meta.url)("typescript");
const tseslint = createRequire(import.meta.url)("typescript-eslint");

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

test("every runner config belongs to a TypeScript project", () => {
  // 시험 러너 설정은 시험 코드라 타입 정보로 검사한다. 저장소에 있는 설정을 모두 본다.
  const configs = ts.sys
    .readDirectory(
      repository,
      [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"],
      ["**/node_modules"],
      ["**/*.config.*"]
    )
    .map((file) => path.relative(repository, file))
    .filter((file) =>
      /(^|\/)(vitest|playwright)(\.[\w-]+)?\.config\./.test(file)
    );
  assert.ok(configs.length > 0, "no runner config found");
  assert.deepEqual(
    configs.filter((file) => !inProject(file)),
    []
  );
});

test("the project check sees a file it should (a check that cannot fail proves nothing)", () => {
  assert.equal(inProject("packages/core/src/sample.test.ts"), true);
  // 프로젝트 밖(빌드 산출물 폴더)은 들지 않는다.
  assert.equal(inProject("packages/core/dist/sample.test.ts"), false);
});

/** 표본 파일에서 가장 가까운 tsconfig.json(저장소 안). */
function nearestConfig(relative) {
  for (let dir = path.dirname(relative); ; dir = path.dirname(dir)) {
    const config = path.join(dir, "tsconfig.json");
    if (existsSync(path.join(repository, config))) return config;
    if (dir === ".") throw new Error(`no tsconfig.json above ${relative}`);
  }
}

/**
 * 표본 파일마다 lint의 타입 정보 경로가 그 파일을 TypeScript 프로젝트에서 찾는지(`true`) 못 찾는지(`false`). lint는 typescript-eslint의
 * project service로 가장 가까운 tsconfig.json의 프로그램에서 타입을 얻고, 프로그램에 없는 파일은 "was not found by the project
 * service"로 거부한다(기본 프로젝트 특별 목록은 없다). project service는 디스크에 있는 파일만 프로그램에 넣으므로, 저장소의
 * tsconfig.json들과 tsconfig.base.json을 같은 상대 위치로 임시 폴더에 옮겨 그 옆에 표본을 만들고 같은 parser 설정으로 검사한다. 타입
 * 선언(`types`)을 찾게 node_modules는 저장소 것을 잇는다. ESLint가 검사하지 않은 파일(무시 목록 등)은 판정할 수 없으므로 실패로 드러낸다.
 */
async function projectMembership(context, samples) {
  const mirror = mkdtempSync(path.join(tmpdir(), "lint-scope-"));
  context.after(() => removeFolder(mirror));
  const configs = new Set([
    "tsconfig.base.json",
    ...samples.map(nearestConfig),
  ]);
  for (const config of configs) {
    mkdirSync(path.join(mirror, path.dirname(config)), { recursive: true });
    copyFileSync(path.join(repository, config), path.join(mirror, config));
    const modules = path.join(path.dirname(config), "node_modules");
    if (existsSync(path.join(repository, modules)))
      symlinkSync(
        path.join(repository, modules),
        path.join(mirror, modules),
        "junction"
      );
  }
  for (const sample of samples) {
    mkdirSync(path.join(mirror, path.dirname(sample)), { recursive: true });
    writeFileSync(path.join(mirror, sample), "export const a = 1;\n");
  }
  const eslint = new ESLint({
    cwd: mirror,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: [`**/*.${codeFormats}`],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { projectService: true, tsconfigRootDir: mirror },
        },
      },
    ],
  });
  const results = await eslint.lintFiles(samples);
  return new Map(
    results.map(({ filePath, messages }) => {
      const sample = path.relative(mirror, filePath);
      const fatal = messages.find((m) => m.fatal);
      if (fatal && !/was not found by the project service/.test(fatal.message))
        throw new Error(`${sample}: ${fatal.message}`);
      return [sample, !fatal];
    })
  );
}

/** 표본 중 프로젝트에서 찾지 못한 것. lint가 표본을 하나라도 검사하지 않았으면 실패한다. */
async function outsideProjects(context, samples) {
  const found = await projectMembership(context, samples);
  assert.deepEqual(
    samples.filter((sample) => !found.has(sample)),
    [],
    "lint did not check these samples"
  );
  return samples.filter((sample) => !found.get(sample));
}

test("the project check tells a file in a project from one outside every project", async (context) => {
  // 패키지 뿌리와 빌드 산출물(dist) 폴더의 파일은 그 tsconfig.json의 include(src·러너 설정)에 들지 않는다. 판정이 늘 "있음"이면 아래
  // 시험은 아무것도 지키지 않는다(저장소 lint는 dist를 무시 목록으로 건너뛰지만, 이 판정은 무시 목록 없이 parser 경로만 본다).
  assert.deepEqual(
    await outsideProjects(context, [
      "packages/core/src/sample.test.ts",
      "packages/core/sample-outside.test.ts",
      "packages/core/dist/sample.test.ts",
    ]),
    [
      "packages/core/sample-outside.test.ts",
      "packages/core/dist/sample.test.ts",
    ]
  );
});
