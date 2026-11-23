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
  "apps/server/src/workspace-reader.ts",
  "apps/server/test/workspace-cases.test.ts",
  "apps/server/test/workspace-race.test.ts",
  "apps/server/test/files-volume.ts",
  "apps/server/vitest.files.config.ts",
  "apps/server/package.json",
  "packages/contracts/src/task.ts",
  "packages/files/src/regular-file.ts",
  "packages/files/package.json",
  "packages/contracts/src/failure.ts",
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

// 바뀐 파일은 `git diff -z --name-only`의 NUL 구분 목록으로 받는다. 줄 단위로 받으면 Git이 따옴표로 감싸 이스케이프한 이름(줄바꿈·
// 따옴표가 든 파일)이 다른 경로가 되거나 둘로 갈라진다(#285 리뷰 STD-1).
test("reads the changed files from standard input as GitHub outputs", () => {
  assert.equal(run("README.md\0"), "code=false\nfiles=false\n");
  assert.equal(
    run("apps/web/src/App.tsx\0apps/server/src/workspace.ts\0"),
    "code=true\nfiles=true\n"
  );
  assert.equal(run(""), "code=false\nfiles=false\n");
  // 이름에 줄바꿈이 든 파일 하나다. 줄 단위로 나누면 경계 밖 경로 둘이 된다.
  assert.equal(
    run("apps/server/src/workspace\nreader.ts\0"),
    "code=true\nfiles=true\n"
  );
  // 이름에 줄바꿈이 든 Markdown 하나는 문서뿐인 변경이다.
  assert.equal(run("docs/a\nb.md\0"), "code=false\nfiles=false\n");
});
