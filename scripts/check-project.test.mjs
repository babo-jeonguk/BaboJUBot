import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function copyFromRepository(relative, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repository, relative), destination);
}

function runChecker(fixture) {
  return execFileSync(process.execPath, ["scripts/check-project.mjs"], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
    stdio: "pipe",
  });
}

function runCheckerFailure(fixture) {
  const result = spawnSync(process.execPath, ["scripts/check-project.mjs"], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30_000,
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, 0, "check-project.mjs unexpectedly succeeded");
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** check-project.mjs를 돌릴 임시 저장소. 필수 파일과 스크립트를 넣고 저장소의 node_modules를 잇는다. */
function createFixture(defer) {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "babojubot-check-project-")
  );
  defer(() => removeFolder(fixture));
  for (const relative of [
    "scripts/check-project.mjs",
    "scripts/ignored-dot-folders.mjs",
    "scripts/markdown.mjs",
    ".agents/scripts/run-worker.ts",
    ".agents/scripts/worker-permissions.ts",
    ".opencode/agents/dev-worker.md",
  ])
    copyFromRepository(relative, path.join(fixture, relative));
  // 복사한 스크립트가 저장소의 Markdown 파서를 가져가도록 node_modules를 잇는다.
  fs.symlinkSync(
    path.join(repository, "node_modules"),
    path.join(fixture, "node_modules"),
    "junction"
  );
  fs.writeFileSync(
    path.join(fixture, ".gitignore"),
    ".worktrees/\nnode_modules\n"
  );
  fs.writeFileSync(path.join(fixture, "AGENTS.md"), "# AGENTS\n");
  fs.writeFileSync(path.join(fixture, "GLOSSARY.md"), "# GLOSSARY\n");
  fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "docs/features.md"), "# Features\n");
  return fixture;
}

test("check-project checks Git's file list without scanning ignored worktrees", async () => {
  await withCleanup(async (defer) => {
    const fixture = createFixture(defer);

    // Git이 무시하는 worktree의 깨진 문서·점 폴더 언급은 검사 대상이 아니다.
    fs.mkdirSync(path.join(fixture, ".worktrees/other"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, ".worktrees/other/broken.md"),
      "[missing](./missing.md)\n\n이 폴더는 `.worktrees/other/`에 있다.\n"
    );

    execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: fixture, stdio: "ignore" });

    assert.match(runChecker(fixture), /Checked local links/);

    // 무시되지 않은 untracked 문서(공백 있는 이름)도 검사한다.
    fs.writeFileSync(
      path.join(fixture, "broken link.md"),
      "[missing](./missing.md)\n"
    );
    const untracked = runCheckerFailure(fixture);
    assert.notEqual(untracked.status, 0);
    assert.match(untracked.output, /Broken local link/);

    fs.rmSync(path.join(fixture, "broken link.md"));
    // index에 든 문서를 깨진 링크로 바꾸면 unstaged 수정도 읽어 실패한다.
    fs.writeFileSync(path.join(fixture, "docs/tracked.md"), "# Tracked\n");
    execFileSync("git", ["add", "docs/tracked.md"], {
      cwd: fixture,
      stdio: "ignore",
    });
    fs.writeFileSync(
      path.join(fixture, "docs/tracked.md"),
      "[missing](./missing.md)\n"
    );
    const tracked = runCheckerFailure(fixture);
    assert.notEqual(tracked.status, 0);
    assert.match(tracked.output, /Broken local link/);
  });
});

test("check-project reads links by CommonMark: reference definitions count, code does not", async () => {
  await withCleanup(async (defer) => {
    const fixture = createFixture(defer);
    execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });

    // 코드 블록·코드 스팬 안 글은 링크가 아니다(CommonMark §4.5·§6.1).
    fs.writeFileSync(
      path.join(fixture, "docs/code.md"),
      "```md\n[예시](./missing.md)\n```\n\n`[예시](./missing.md)`\n"
    );
    assert.match(runChecker(fixture), /Checked local links/);

    // 참조식 링크 정의(§4.7)는 링크다.
    fs.writeFileSync(
      path.join(fixture, "docs/reference.md"),
      "[예시][r]\n\n[r]: ./missing.md\n"
    );
    const reference = runCheckerFailure(fixture);
    assert.notEqual(reference.status, 0);
    assert.match(
      reference.output,
      /Broken local link .*docs\/reference\.md:3: \.\/missing\.md/
    );
  });
});

// 문법이 태그로 읽지 못한 `<a/href=…>`를 건너뛰면 브라우저가 여는 링크를 검사하지 않는다. 판정할 수 없음으로 실패한다
// (#286 병합분 감사 항목 1).
test("check-project fails on an HTML link it cannot read", async () => {
  await withCleanup(async (defer) => {
    const fixture = createFixture(defer);
    execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });
    fs.writeFileSync(
      path.join(fixture, "docs/html.md"),
      '<div>\n<a/href="./missing.md">예시</a>\n</div>\n'
    );
    const result = runCheckerFailure(fixture);
    assert.match(
      result.output,
      /Cannot tell where an HTML link points .*docs\/html\.md:2: /
    );
  });
});
