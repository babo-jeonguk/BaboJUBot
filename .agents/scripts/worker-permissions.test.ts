// The code worker may not edit tests (docs/agents/worker.md). Its permission file is not code, so it cannot import the
// test scope (scripts/test-files.mjs); this test keeps the denied files in line with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isTestFile, testFiles } from "../../scripts/test-files.mjs";
import { editRules, isProtected } from "./worker-permissions.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const rules = editRules(
  readFileSync(path.join(root, ".opencode/agents/dev-worker.md"), "utf8")
);
if (!rules) throw new Error("dev-worker.md has no frontmatter");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

/** Brace expansion, innermost first (`{a,b}` → a, b). */
function expand(pattern: string): string[] {
  const group = /\{([^{}]*)\}/.exec(pattern);
  if (!group) return [pattern];
  return pattern
    .slice(group.index + 1, group.index + group[0].length - 1)
    .split(",")
    .flatMap((choice) =>
      expand(
        pattern.slice(0, group.index) +
          choice +
          pattern.slice(group.index + group[0].length)
      )
    );
}

/** One concrete file for each shape a test scope pattern names: `**` becomes folders, `*` a name. */
function samples(pattern: string) {
  return expand(pattern).map((shape) =>
    shape
      .replace(/^\*\*\//, "packages/core/src/")
      .replace(/\/\*\*$/, "/sample/sample.ts")
      .replaceAll("**", "sample/sample")
      .replaceAll("*", "sample")
  );
}

test("the samples come from the test scope", () => {
  const all = testFiles.flatMap(samples);
  assert.ok(all.length > testFiles.length);
  assert.deepEqual(
    all.filter((file) => !isTestFile(file)),
    []
  );
});

test("the code worker may not edit any test file", () => {
  // Every shape the test scope names, in every format, and every test file the repository has.
  const files = [...testFiles.flatMap(samples), ...tracked.filter(isTestFile)];
  assert.deepEqual(
    files.filter((file) => !isProtected(rules, file)),
    []
  );
});

test("the code worker may edit product code", () => {
  // The worker changes product code (src outside the test scope). A denial there blocks the work it is given.
  const product = tracked.filter(
    (file) => /^(?:apps|packages)\/[^/]+\/src\//.test(file) && !isTestFile(file)
  );
  assert.ok(product.length > 0);
  assert.deepEqual(
    product.filter((file) => isProtected(rules, file)),
    []
  );
});

test("the code worker may edit a product file named like a test helper or placed like a test folder", () => {
  // The denied names come from the test scope, which names helpers only in some packages and folders. The same name
  // elsewhere in product code (another package's src, a sub folder) is product code and stays editable.
  const sources = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => /^(?:apps|packages)\/[^/]+\/src\//.exec(file)?.[0])
    .filter((folder, index, all) => folder && all.indexOf(folder) === index);
  assert.ok(sources.length > 1);
  const twins = testFiles.flatMap(samples).flatMap((file) => {
    const name = path.posix.basename(file);
    const tail = file.replace(/^(?:apps|packages)\/[^/]+\/(?:src\/)?/, "");
    return sources.flatMap((src) => [
      `${src}${name}`,
      `${src}sample/${name}`,
      `${src}${tail}`,
    ]);
  });
  // A folder whose name starts with a helper's name (`runtime-contract.schema/index.ts`) holds product code. OpenCode's
  // `*` crosses `/`, so a helper rule such as `runtime-contract.*` also reaches into that folder (#286 item 27).
  const helperFolders = testFiles.flatMap(samples).map((file) => {
    const stem = path.posix.basename(file).split(".")[0] ?? "";
    return `${path.posix.dirname(file)}/${stem}.schema/index.ts`;
  });
  const product = [...new Set([...twins, ...helperFolders])].filter(
    (file) => !isTestFile(file)
  );
  // Reopening sub folders must not reopen what the later rules deny there.
  for (const file of [
    "packages/process/src/sample/.env",
    "packages/runtime/src/providers/sample/package.json",
    "packages/runtime/src/providers/sample/sample.test.ts",
  ])
    assert.ok(isProtected(rules, file), file);
  assert.ok(product.length > 0);
  assert.deepEqual(
    product.filter((file) => isProtected(rules, file)),
    []
  );
});

// OpenCode의 `*`는 `/`도 넘는다(설치된 OpenCode의 판정: `*` → `.*`). 설정 파일 이름 패턴(`*vitest*config*`, `*tsconfig*.json`,
// `*package.json` 등)이 폴더 경계를 넘으면, 이름에 그 글자가 든 폴더 안의 제품 파일까지 막는다(#286 항목 27과 같은 모양). 설정 파일은
// 경로의 마지막 조각(파일 이름)으로 판정해야 한다.
test("the code worker may edit product code in folders whose names hold a check setting's words", () => {
  const product = [
    "packages/core/src/vitest-tools/config.ts",
    "packages/core/src/vitest.helpers/run.ts",
    "packages/core/src/playwright-steps/config.ts",
    "packages/core/src/eslint.config.d/rules.ts",
    "packages/core/src/vite.config.parts/alias.ts",
    "packages/core/src/tsconfig-tools/data.json",
    "packages/core/src/prettierrc-rules/data.json",
    "packages/core/src/mypackage.json",
    "packages/core/src/release.github/notes.ts",
    "packages/core/src/agents.agents/list.ts",
  ];
  assert.deepEqual(
    product.filter((file) => isProtected(rules, file)),
    []
  );
  // 같은 이름의 실제 설정 파일은 어느 폴더에 있든 막힌다. 위에서 다시 연 폴더 안에 있어도 그렇다.
  const settings = [
    "packages/core/src/vitest.d/eslint.config.js",
    "packages/core/src/eslint.config.d/vitest.config.ts",
    "packages/core/src/tsconfig-tools/tsconfig.json",
    "packages/core/src/playwright.parts/vitest.alone.config.ts",
    "packages/core/src/vitest.helpers/package.json",
    "eslint.config.js",
    "apps/web/playwright.config.ts",
    "apps/web/vite.config.ts",
    "packages/core/vitest.config.ts",
    "packages/process/vitest.alone.config.ts",
    "packages/core/tsconfig.test.json",
    "alternate-tsconfig.json",
    "packages/core/package.json",
    "package.json",
    "pnpm-lock.yaml",
    ".prettierrc.json",
    "apps/web/.prettierrc",
    ".github/workflows/scaffold.yml",
    ".agents/scripts/run-worker.ts",
    "packages/core/src/sample.test.ts",
  ];
  assert.deepEqual(
    settings.filter((file) => !isProtected(rules, file)),
    []
  );
});
