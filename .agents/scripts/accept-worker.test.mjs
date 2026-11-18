import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/runtime/remove-folder";

const script = fileURLToPath(new URL("./accept-worker.mjs", import.meta.url));
const limitMs = 30_000;
const passing = `"${process.execPath}" -e "console.log('noisy output')"`;

const workerDefinition = `---
description: test worker
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: edit
    resource: "*.test.*"
    effect: deny
  - action: edit
    resource: "*eslint.config.*"
    effect: deny
---

Worker.
`;

// A Git hook sets variables such as GIT_DIR that would point these commands at the real repository.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
);

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: limitMs,
  }).trim();
}

function commit(cwd, message) {
  git(cwd, "add", ".");
  git(
    cwd,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    message
  );
}

function write(cwd, file, content) {
  fs.writeFileSync(path.join(cwd, file), content);
}

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "babojubot-accept-"));
  t.after(() => removeFolder(cwd));
  fs.mkdirSync(path.join(cwd, ".opencode/agents"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"));
  write(cwd, ".opencode/agents/dev-worker.md", workerDefinition);
  write(cwd, ".gitignore", "ignored/\n");
  write(cwd, "src/a.ts", "export const a = 1;\n");
  write(cwd, "src/a.test.ts", "// test\n");
  write(cwd, "eslint.config.js", "export default [];\n");
  git(cwd, "init", "-q");
  commit(cwd, "base");
  return { cwd, base: git(cwd, "rev-parse", "HEAD") };
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: limitMs,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

function accept(
  { cwd, base },
  { allow = ["src/*"], reported = ["src/a.ts"], tests = [passing] } = {}
) {
  return run(cwd, [
    "--base",
    base,
    ...allow.flatMap((pattern) => ["--allow", pattern]),
    ...reported.flatMap((file) => ["--reported", file]),
    ...tests.flatMap((command) => ["--test", command]),
  ]);
}

function assertRejected(result, reason) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, reason);
}

test("accepts a change inside the allowed files and reports it in one line", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  write(repo.cwd, "src/b.ts", "export const b = 1;\n");
  const result = accept(repo, {
    allow: ["src/*.ts"],
    reported: ["src/b.ts", "src/a.ts"],
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output.trim().split("\n").length, 1);
  assert.match(result.output, /accepted: 2 files, 1 test command/);
  assert.doesNotMatch(result.output, /noisy output/);
});

test("rejects an edited test even when the allowed files include it", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  const result = accept(repo, { reported: ["src/a.test.ts"] });
  assertRejected(result, /protected file changed: src\/a\.test\.ts/);
});

test("rejects a new test file and an edited check setting", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/new.test.ts", "// new\n");
  write(repo.cwd, "eslint.config.js", "export default {};\n");
  const result = accept(repo, {
    allow: ["*"],
    reported: ["src/new.test.ts", "eslint.config.js"],
  });
  assertRejected(result, /protected file changed: src\/new\.test\.ts/);
  assertRejected(result, /protected file changed: eslint\.config\.js/);
});

test("rejects a deleted test", (t) => {
  const repo = repository(t);
  fs.rmSync(path.join(repo.cwd, "src/a.test.ts"));
  const result = accept(repo, { reported: ["src/a.test.ts"] });
  assertRejected(result, /protected file changed: src\/a\.test\.ts/);
});

test("judges protected files by the base commit's permissions", (t) => {
  const repo = repository(t);
  write(
    repo.cwd,
    ".opencode/agents/dev-worker.md",
    "---\npermissions: []\n---\n"
  );
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  const result = accept(repo, {
    allow: ["*"],
    reported: [".opencode/agents/dev-worker.md", "src/a.test.ts"],
  });
  assertRejected(result, /protected file changed: src\/a\.test\.ts/);
});

test("rejects a staged change that the working tree no longer shows", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  git(repo.cwd, "add", "src/a.test.ts");
  write(repo.cwd, "src/a.test.ts", "// test\n");
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = accept(repo);
  assertRejected(result, /protected file changed: src\/a\.test\.ts/);
});

test("rejects a file outside the allowed files", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = accept(repo, { allow: ["src/b.ts"] });
  assertRejected(result, /outside the brief: src\/a\.ts/);
});

test("rejects a report that differs from the actual change", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  write(repo.cwd, "src/b.ts", "export const b = 1;\n");
  const result = accept(repo, { reported: ["src/a.ts", "src/c.ts"] });
  assertRejected(result, /changed but not reported: src\/b\.ts/);
  assertRejected(result, /reported but not changed: src\/c\.ts/);
});

test("rejects a run that moved HEAD away from the base", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  commit(repo.cwd, "worker commit");
  assertRejected(accept(repo), /HEAD moved/);
});

test("shows the output of a failing test command", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = accept(repo, {
    tests: [
      `"${process.execPath}" -e "console.error('why it failed'); process.exit(3)"`,
    ],
  });
  assertRejected(result, /test command failed \(exit 3\)/);
  assertRejected(result, /why it failed/);
});

test("does not run test commands once the change is rejected", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  const marker = path.join(repo.cwd, "ignored-marker");
  const result = accept(repo, {
    reported: ["src/a.test.ts"],
    tests: [
      `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], '')" "${marker}"`,
    ],
  });
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(marker), false);
});

test("rejects a change that the test commands leave behind", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = accept(repo, {
    tests: [
      `"${process.execPath}" -e "require('fs').writeFileSync('src/a.test.ts', '// rewritten')"`,
    ],
  });
  assertRejected(result, /protected file changed: src\/a\.test\.ts/);
});

test("rejects a run that changed nothing", (t) => {
  assertRejected(accept(repository(t)), /no files changed/);
});

test("requires a base, allowed files, the reported files and a test command", (t) => {
  const { cwd, base } = repository(t);
  const complete = {
    "--base": base,
    "--allow": "src/*",
    "--reported": "src/a.ts",
    "--test": passing,
  };
  for (const missing of Object.keys(complete)) {
    const args = Object.entries(complete)
      .filter(([name]) => name !== missing)
      .flat();
    assert.equal(run(cwd, args).status, 2, missing);
  }
});
