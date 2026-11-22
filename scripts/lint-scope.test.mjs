// 시험 러너가 모으는 파일이면 확장자와 상관없이 같은 시험 규칙과 타입 정보를 받는지 본다(#270). 러너는 vitest 기본 include
// (`**/*.{test,spec}.?(c|m)[jt]s?(x)`)와 Playwright 기본 testMatch로 여덟 형식을 모두 모으는데, lint의 시험 범위·화면 규칙·TypeScript
// 프로젝트는 각자 몇 형식만 담아 확장자만 바꾸면 규칙을 피할 수 있었다. 파일은 만들지 않고 설정을 판정한다.
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import { ESLint } from "eslint";
import { parseDocument } from "yaml";
import { codeFormats, isTestFile } from "./test-files.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const eslint = new ESLint({ cwd: repository });
const require = createRequire(import.meta.url);
const tseslint = require("typescript-eslint");
const ts = require("typescript");

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
/** 시험 러너 설정의 자리(형식 앞까지). */
const runnerConfigPlaces = [
  "packages/core/vitest.sample.config",
  "apps/server/vitest.sample.config",
  "apps/web/vitest.sample.config",
  "apps/web/playwright.sample.config",
];
/** 제품 코드와 그 밖의 자리. lint 설정이 영역(패키지 경계·프로그램 띄우기·db·서버)마다 규칙을 거는 곳을 모두 담는다. */
const productPlaces = [
  "packages/contracts/src/sample",
  "packages/core/src/sample",
  "packages/db/src/sample",
  "packages/process/src/sample",
  "packages/process/src/sample-support",
  "packages/runtime/src/sample",
  "packages/runtime/src/providers/sample",
  "packages/runtime/src/providers/sample-support",
  "apps/server/src/sample",
  "apps/web/src/sample",
  "packages/runtime/test-fixtures/sample",
  "sample",
];

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
  assert.deepEqual(
    await missing(runnerConfigPlaces, ["tests/no-fixed-time-wait"]),
    []
  );
});

test("a file gets the same rules in every format", async () => {
  // 형식으로 갈리는 규칙은 typescript-eslint가 TypeScript 형식에서 컴파일러와 겹치는 핵심 규칙을 바꾸는 것뿐이다(eslintRecommended).
  // 그 밖의 규칙(패키지 입구·영역 경계·프로그램 띄우기·시험 규칙과 그 완화)은 같은 자리의 파일이면 형식과 상관없이 같아야 한다.
  const { files, rules: compilerChecked } = tseslint.configs.eslintRecommended;
  // 자리마다 `.ts`와 다른 형식과 그 규칙을 모은다.
  const gaps = [];
  for (const place of [
    ...testPlaces,
    ...scriptPlaces,
    ...runnerConfigPlaces,
    ...productPlaces,
  ]) {
    const base = await rulesOf(`${place}.ts`);
    const formats = new Set();
    const rules = new Set();
    for (const format of runnerFormats) {
      const file = `${place}.${format}`;
      const set = await rulesOf(file);
      const typeScript = files.some((pattern) =>
        path.matchesGlob(file, pattern)
      );
      for (const rule of new Set([...Object.keys(base), ...Object.keys(set)]))
        if (
          JSON.stringify(set[rule]) !== JSON.stringify(base[rule]) &&
          (typeScript || !(rule in compilerChecked))
        ) {
          formats.add(format);
          rules.add(rule);
        }
    }
    if (rules.size > 0)
      gaps.push(`${place}.{${[...formats]}} ${[...rules].sort().join(" ")}`);
  }
  assert.deepEqual(gaps, []);
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
 * 저장소의 tsconfig.base.json과 표본마다 가장 가까운 tsconfig.json(같은 폴더의 tsconfig.*.json 포함)을 같은 상대 위치로 임시 폴더에
 * 옮기고 그 옆에 표본을 만든다. TypeScript는 디스크에 있는 파일만 프로그램에 넣으므로 표본은 실제 파일이어야 한다. 타입 선언
 * (`types`)을 찾게 node_modules는 저장소 것을 잇는다.
 */
function mirrorOf(context, samples) {
  const mirror = mkdtempSync(path.join(tmpdir(), "lint-scope-"));
  context.after(() => removeFolder(mirror));
  const configs = new Set(["tsconfig.base.json"]);
  for (const config of samples.map(nearestConfig))
    for (const file of globSync("tsconfig{,.*}.json", {
      cwd: path.join(repository, path.dirname(config)),
    }))
      configs.add(path.join(path.dirname(config), file));
  for (const config of configs) {
    mkdirSync(path.join(mirror, path.dirname(config)), { recursive: true });
    copyFileSync(path.join(repository, config), path.join(mirror, config));
    const modules = path.join(path.dirname(config), "node_modules");
    if (
      existsSync(path.join(repository, modules)) &&
      !existsSync(path.join(mirror, modules))
    )
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
  return mirror;
}

/**
 * 표본 파일마다 lint의 타입 정보 경로가 그 파일을 TypeScript 프로젝트에서 찾는지(`true`) 못 찾는지(`false`). lint는 typescript-eslint의
 * project service로 가장 가까운 tsconfig.json의 프로그램에서 타입을 얻고, 프로그램에 없는 파일은 "was not found by the project
 * service"로 거부한다(기본 프로젝트 특별 목록은 없다). 임시 폴더(mirrorOf)에서 같은 parser 설정으로 검사한다. ESLint가 검사하지
 * 않은 파일(무시 목록 등)은 판정할 수 없으므로 실패로 드러낸다.
 */
async function projectMembership(context, samples) {
  const mirror = mirrorOf(context, samples);
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

test("every test file format and runner config belongs to a TypeScript project", async (context) => {
  // TypeScript는 이름이 같고 확장자만 다른 파일 중 하나만 프로그램에 넣으므로(`a.ts`가 있으면 `a.tsx`·`a.js`는 빠진다) 형식마다 이름을 다르게 한다.
  const samples = [
    ...testPlaces,
    ...scriptPlaces,
    ...runnerConfigPlaces,
  ].flatMap((place) =>
    runnerFormats.map(
      (format) => `${place.replace("sample", `sample-${format}`)}.${format}`
    )
  );
  // 저장소의 시험 러너 설정(vitest·Playwright)도 시험 코드라 타입 정보로 검사한다.
  const configs = globSync("**/{vitest,playwright}{,.*}.config.*", {
    cwd: repository,
    exclude: (entry) => /(^|[\\/])node_modules$/.test(entry),
  });
  assert.ok(configs.length > 0, "no runner config found");
  assert.deepEqual(
    await outsideProjects(context, [...samples, ...configs]),
    []
  );
});

/** tsconfig 파일이 고르는 파일(tsc -p와 같은 판정, 저장소 기준 경로). */
function filesOf(root, config) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(root, config),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        );
      },
    }
  );
  if (!parsed) throw new Error(`${config}: not read`);
  return new Set(
    parsed.fileNames.map((file) =>
      path.relative(root, file).replaceAll("\\", "/")
    )
  );
}

/**
 * 제품 타입 검사(tsconfig.src.json)와 시험 타입 검사(tsconfig.test.json)가 lint 프로젝트(tsconfig.json)의 파일을 시험 범위
 * (scripts/test-files.mjs)대로 나누는가. 시험 코드는 시험 쪽에만, 그 밖은 제품 쪽에 든다(시험 쪽은 가져오는 제품 파일을 어차피 함께
 * 검사하므로 제품 파일이 들어도 된다). 어긋난 파일을 모두 돌려준다.
 */
function splitGaps(root, packages) {
  const gaps = [];
  for (const folder of packages) {
    const project = filesOf(root, `${folder}/tsconfig.json`);
    const product = filesOf(root, `${folder}/tsconfig.src.json`);
    const tests = filesOf(root, `${folder}/tsconfig.test.json`);
    for (const file of project) {
      const test = isTestFile(file);
      if (test && !tests.has(file))
        gaps.push(`${file} not in tsconfig.test.json`);
      if (test === product.has(file))
        gaps.push(`${file} ${test ? "in" : "not in"} tsconfig.src.json`);
    }
  }
  return gaps;
}

test("the product and test type checks split files the way the test scope does", async (context) => {
  // tsconfig는 JSON이라 시험 범위(codeFormats)를 가져올 수 없다. 저장소 파일과 형식마다 만든 표본으로 같은 범위인지 본다.
  const packages = globSync("{apps,packages}/*/tsconfig.test.json", {
    cwd: repository,
  }).map((file) => path.dirname(file).replaceAll("\\", "/"));
  assert.ok(packages.length > 0, "no tsconfig.test.json found");
  assert.deepEqual(splitGaps(repository, packages), []);
  const samples = [...testPlaces, ...runnerConfigPlaces, ...productPlaces]
    .filter((place) =>
      packages.some((folder) => place.startsWith(`${folder}/`))
    )
    .flatMap((place) =>
      runnerFormats.map(
        (format) => `${place.replace("sample", `sample-${format}`)}.${format}`
      )
    );
  assert.deepEqual(splitGaps(mirrorOf(context, samples), packages), []);
});

/** 시험 러너가 모으는 형식의 이름 하나(앞의 `.`이나 정규식의 `\.` 포함). */
const formatName = `(?:${runnerFormats.join("|")})`;
/** 형식 목록이나 형식 glob을 손으로 적은 모양. */
const handWrittenFormats = [
  // 형식 이름만 적은 문자열(".ts", "mjs").
  new RegExp(`^(?:\\\\?\\.)?${formatName}$`),
  // 한 묶음({…}·(…))에 형식 이름이 둘 이상.
  new RegExp(
    `[{(](?:\\?:)?(?:[^{}()]*[,|])?\\s*(?:\\\\?\\.)?${formatName}\\s*[,|](?:[^{}()]*[,|])?\\s*(?:\\\\?\\.)?${formatName}\\s*[,|})]`
  ),
  // 형식을 줄여 적은 정규식·glob(`[jt]s`, `m?js`, `?(c|m)`, `tsx?`).
  /\[(?:jt|tj|cm|mc)\]|\b[cm]\?[jt]sx?\b|\b[jt]sx\?|\?\(c\|m\)/,
  // 아무 이름에 형식 하나를 붙인 glob·정규식(`*.ts`, `vitest*.config.ts`, `[^/]*\.ts$`, `[\w-]+-x\.mjs`).
  new RegExp(`[*+][^\\s/"'\`]*?\\\\?\\.${formatName}(?![\\w-])`),
];

/** 코드 파일(TypeScript 구문 트리)의 문자열·template 조각·정규식. 주석은 보지 않는다. */
function codeLiterals(file, text) {
  const literals = [];
  const visit = (node) => {
    if (ts.isRegularExpressionLiteral(node)) literals.push(node.text);
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return literals;
}

/** JSON·YAML 값 안의 문자열(키는 이름이라 보지 않는다). */
function valueStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(valueStrings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(valueStrings);
  return [];
}

test("format lists and format globs are built from codeFormats", () => {
  // 형식 목록은 scripts/test-files.mjs의 codeFormats 하나다. lint·검사 스크립트·러너와 TypeScript 설정·CI가 손으로 적은 형식 목록이나
  // 형식 glob을 두면 형식이 하나 빠진 사본이 생겨(확장자만 바꾸면 규칙·검사 밖) 그 목록에서 만들어 쓴다. 일부 형식만 받는 곳은
  // codeFormats에서 이름 붙여 걸러 낸다. 시험 파일의 표본 이름·입력은 형식 목록이 아니어서 보지 않는다. agent 정의(.opencode)는
  // 머리말(YAML)의 권한 경로를 본다(코드 worker가 고치지 못하는 시험 파일).
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: repository,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) =>
        !path.matchesGlob(file, `**/*.{test,spec}.${codeFormats}`) &&
        (/^(?:scripts|\.agents|\.github|\.opencode)\//.test(file) ||
          !file.includes("/") ||
          /(?:^|\/)(?:tsconfig[^/]*\.json|package\.json|(?:vitest|playwright)[^/]*\.config\.[^/]+)$/.test(
            file
          ))
    );
  const found = [];
  for (const file of files) {
    const text = readFileSync(path.join(repository, file), "utf8");
    let literals;
    if (path.matchesGlob(file, `**/*.${codeFormats}`))
      literals = codeLiterals(file, text);
    else if (file.endsWith(".json") || file.endsWith("rc"))
      literals = valueStrings(ts.parseConfigFileTextToJson(file, text).config);
    else if (/\.ya?ml$/.test(file))
      literals = valueStrings(parseDocument(text).toJS());
    else if (file.startsWith(".opencode/") && file.endsWith(".md"))
      literals = valueStrings(
        parseDocument(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "").toJS()
      );
    else continue;
    for (const literal of literals)
      if (handWrittenFormats.some((shape) => shape.test(literal)))
        found.push(`${file}: ${literal}`);
  }
  // 목록 자체(codeFormats)는 찾아야 한다. 못 찾으면 이 검사가 아무것도 보지 않는 것이다.
  assert.deepEqual(found, [`scripts/test-files.mjs: ${codeFormats}`]);
});
