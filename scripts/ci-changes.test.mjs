import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify } from "./ci-changes.mjs";

const script = fileURLToPath(new URL("./ci-changes.mjs", import.meta.url));
const run = (input, args = []) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test("runs nothing but the document check for Markdown-only changes", () => {
  assert.deepEqual(classify(["README.md", "docs/current-implementation.md"]), {
    code: false,
    files: false,
  });
});

test("runs the tests but not the file-system verification for unrelated code", () => {
  assert.deepEqual(classify(["apps/web/src/App.tsx", "docs/a.md"]), {
    code: true,
    files: false,
  });
  assert.deepEqual(classify(["apps/server/src/app.ts"]), {
    code: true,
    files: false,
  });
});

for (const file of [
  "apps/server/src/workspace.ts",
  "apps/server/test/workspace-cases.test.ts",
  "apps/server/test/workspace-race.test.ts",
  "apps/server/test/files-volume.ts",
  "apps/server/vitest.files.config.ts",
  "apps/server/package.json",
  "packages/contracts/src/task.ts",
  "scripts/file-boundary-report.mjs",
  "scripts/files/prepare-windows.ps1",
  "scripts/check-ci-test-gate.mjs",
  ".github/workflows/scaffold.yml",
  "pnpm-lock.yaml",
  "package.json",
]) {
  test(`runs the file-system verification when ${file} changes`, () => {
    assert.deepEqual(classify(["docs/a.md", file]), {
      code: true,
      files: true,
    });
  });
}

test("runs everything when there is nothing to compare with", () => {
  assert.deepEqual(classify([], { full: true }), { code: true, files: true });
  assert.equal(run("", ["--full"]), "code=true\nfiles=true\n");
});

test("reads the changed files from standard input as GitHub outputs", () => {
  assert.equal(run("README.md\r\n"), "code=false\nfiles=false\n");
  assert.equal(
    run("apps/web/src/App.tsx\napps/server/src/workspace.ts\n"),
    "code=true\nfiles=true\n"
  );
  assert.equal(run(""), "code=false\nfiles=false\n");
});
