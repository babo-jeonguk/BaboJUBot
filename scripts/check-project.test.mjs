import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  try {
    runChecker(fixture);
  } catch (error) {
    return {
      status: error.status,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
  assert.fail("check-project.mjs unexpectedly succeeded");
}

test("check-project checks Git's file list without scanning ignored worktrees", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "babojubot-check-project-")
  );
  try {
    copyFromRepository(
      "scripts/check-project.mjs",
      path.join(fixture, "scripts/check-project.mjs")
    );
    copyFromRepository(
      ".agents/scripts/run-worker.mjs",
      path.join(fixture, ".agents/scripts/run-worker.mjs")
    );
    copyFromRepository(
      ".opencode/agents/dev-worker.md",
      path.join(fixture, ".opencode/agents/dev-worker.md")
    );

    fs.writeFileSync(
      path.join(fixture, ".gitignore"),
      ".worktrees/\nnode_modules/\n"
    );
    fs.writeFileSync(path.join(fixture, "AGENTS.md"), "# AGENTS\n");
    fs.writeFileSync(path.join(fixture, "GLOSSARY.md"), "# GLOSSARY\n");
    fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "docs/features.md"), "# Features\n");

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
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
