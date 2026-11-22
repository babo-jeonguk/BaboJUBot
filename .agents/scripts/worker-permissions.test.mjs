// The code worker may not edit tests (docs/agents/worker.md). Its permission file is not code, so it cannot import the
// test scope (scripts/test-files.mjs); this test keeps the denied files in line with it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isTestFile, testFiles } from "../../scripts/test-files.mjs";
import { editRules, isProtected } from "./worker-permissions.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const rules = editRules(
  readFileSync(path.join(root, ".opencode/agents/dev-worker.md"), "utf8")
);
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

/** Brace expansion, innermost first (`{a,b}` → a, b). */
function expand(pattern) {
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
function samples(pattern) {
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
  const product = [...new Set(twins)].filter((file) => !isTestFile(file));
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
