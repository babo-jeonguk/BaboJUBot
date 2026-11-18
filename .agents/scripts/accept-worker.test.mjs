import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/runtime/remove-folder";

const script = fileURLToPath(new URL("./accept-worker.mjs", import.meta.url));

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

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function withRepository(run) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "babojubot-accept-"));
  try {
    fs.mkdirSync(path.join(cwd, ".opencode/agents"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(
      path.join(cwd, ".opencode/agents/dev-worker.md"),
      workerDefinition
    );
    fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(cwd, "src/a.test.ts"), "// test\n");
    fs.writeFileSync(
      path.join(cwd, "eslint.config.js"),
      "export default [];\n"
    );
    git(cwd, "init", "-q");
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base"
    );
    await run(cwd, git(cwd, "rev-parse", "HEAD"));
  } finally {
    await removeFolder(cwd);
  }
}

function accept(cwd, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

test("accepts a change inside the allowed files and reports it in one line", async () => {
  await withRepository(async (cwd, base) => {
    fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(cwd, "src/b.ts"), "export const b = 1;\n");
    const result = accept(
      cwd,
      "--base",
      base,
      "--allow",
      "src/*.ts",
      "--test",
      `"${process.execPath}" -e "console.log('noisy output')"`
    );
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.trim().split("\n").length, 1);
    assert.match(result.output, /accepted: 2 files, 1 test command/);
    assert.doesNotMatch(result.output, /noisy output/);
  });
});

test("rejects an edited test even when the allowed files include it", async () => {
  await withRepository(async (cwd, base) => {
    fs.writeFileSync(path.join(cwd, "src/a.test.ts"), "// weakened\n");
    const result = accept(cwd, "--base", base, "--allow", "src/*");
    assert.equal(result.status, 1);
    assert.match(result.output, /protected file changed: src\/a\.test\.ts/);
  });
});

test("rejects a new test file and an edited check setting", async () => {
  await withRepository(async (cwd, base) => {
    fs.writeFileSync(path.join(cwd, "src/new.test.ts"), "// new\n");
    fs.writeFileSync(path.join(cwd, "eslint.config.js"), "export default;\n");
    const result = accept(cwd, "--base", base, "--allow", "*");
    assert.equal(result.status, 1);
    assert.match(result.output, /protected file changed: src\/new\.test\.ts/);
    assert.match(result.output, /protected file changed: eslint\.config\.js/);
  });
});

test("rejects a deleted test", async () => {
  await withRepository(async (cwd, base) => {
    fs.rmSync(path.join(cwd, "src/a.test.ts"));
    const result = accept(cwd, "--base", base, "--allow", "src/*");
    assert.equal(result.status, 1);
    assert.match(result.output, /protected file changed: src\/a\.test\.ts/);
  });
});

test("rejects a file outside the allowed files", async () => {
  await withRepository(async (cwd, base) => {
    fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 2;\n");
    const result = accept(cwd, "--base", base, "--allow", "src/b.ts");
    assert.equal(result.status, 1);
    assert.match(result.output, /outside the brief: src\/a\.ts/);
  });
});

test("rejects a run that moved HEAD away from the base", async () => {
  await withRepository(async (cwd, base) => {
    fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 2;\n");
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "worker commit"
    );
    const result = accept(cwd, "--base", base, "--allow", "src/*");
    assert.equal(result.status, 1);
    assert.match(result.output, /HEAD moved/);
  });
});

test("shows the output of a failing test command", async () => {
  await withRepository(async (cwd, base) => {
    fs.writeFileSync(path.join(cwd, "src/a.ts"), "export const a = 2;\n");
    const result = accept(
      cwd,
      "--base",
      base,
      "--allow",
      "src/*.ts",
      "--test",
      `"${process.execPath}" -e "console.error('why it failed'); process.exit(3)"`
    );
    assert.equal(result.status, 1);
    assert.match(result.output, /test command failed \(exit 3\)/);
    assert.match(result.output, /why it failed/);
  });
});

test("does not run test commands once the change is rejected", async () => {
  await withRepository(async (cwd, base) => {
    fs.writeFileSync(path.join(cwd, "src/a.test.ts"), "// weakened\n");
    const marker = path.join(cwd, "ran");
    const result = accept(
      cwd,
      "--base",
      base,
      "--allow",
      "src/*",
      "--test",
      `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], '')" "${marker}"`
    );
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(marker), false);
  });
});

test("rejects a run that changed nothing", async () => {
  await withRepository(async (cwd, base) => {
    const result = accept(cwd, "--base", base, "--allow", "src/*");
    assert.equal(result.status, 1);
    assert.match(result.output, /no files changed/);
  });
});

test("requires a base and at least one allowed pattern", async () => {
  await withRepository(async (cwd, base) => {
    assert.equal(accept(cwd, "--allow", "src/*").status, 2);
    assert.equal(accept(cwd, "--base", base).status, 2);
  });
});
