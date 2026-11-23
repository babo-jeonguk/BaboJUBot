import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";

const script = fileURLToPath(
  new URL("./check-worker-change.ts", import.meta.url)
);
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

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: limitMs,
  }).trim();
}

function commit(cwd: string, message: string) {
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

function write(cwd: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

function repository(t: TestContext, definition = workerDefinition) {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "babojubot-worker-change-")
  );
  t.after(() => removeFolder(cwd));
  fs.mkdirSync(path.join(cwd, ".opencode/agents"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"));
  write(cwd, ".opencode/agents/dev-worker.md", definition);
  write(cwd, ".gitignore", "ignored/\n");
  write(cwd, "src/a.ts", "export const a = 1;\n");
  write(cwd, "src/a.test.ts", "// test\n");
  write(cwd, "eslint.config.js", "export default [];\n");
  git(cwd, "init", "-q");
  commit(cwd, "base");
  return { cwd, base: git(cwd, "rev-parse", "HEAD") };
}

function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: limitMs,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

function check(
  { cwd, base }: { cwd: string; base: string },
  {
    allow = ["src/*"],
    reported = ["src/a.ts"],
    tests = [passing],
  }: { allow?: string[]; reported?: string[]; tests?: string[] } = {}
) {
  return run(cwd, [
    "--base",
    base,
    ...allow.flatMap((pattern) => ["--allow", pattern]),
    ...reported.flatMap((file) => ["--reported", file]),
    ...tests.flatMap((command) => ["--test", command]),
  ]);
}

function assertProblem(
  result: { status: number | null; output: string },
  reason: RegExp
) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, reason);
}

test("passes a change inside the allowed files and reports it in one line", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  write(repo.cwd, "src/b.ts", "export const b = 1;\n");
  const result = check(repo, {
    allow: ["src/*.ts"],
    reported: ["src/b.ts", "src/a.ts"],
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output.trim().split("\n").length, 1);
  assert.match(result.output, /ok: 2 files, 1 test command/);
  assert.doesNotMatch(result.output, /noisy output/);
});

test("reports an edited test even when the allowed files include it", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  const result = check(repo, { reported: ["src/a.test.ts"] });
  assertProblem(result, /protected file changed: src\/a\.test\.ts/);
});

test("reports a new test file and an edited check setting", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/new.test.ts", "// new\n");
  write(repo.cwd, "eslint.config.js", "export default {};\n");
  const result = check(repo, {
    allow: ["*"],
    reported: ["src/new.test.ts", "eslint.config.js"],
  });
  assertProblem(result, /protected file changed: src\/new\.test\.ts/);
  assertProblem(result, /protected file changed: eslint\.config\.js/);
});

test("reports a deleted test", (t) => {
  const repo = repository(t);
  fs.rmSync(path.join(repo.cwd, "src/a.test.ts"));
  const result = check(repo, { reported: ["src/a.test.ts"] });
  assertProblem(result, /protected file changed: src\/a\.test\.ts/);
});

// The after-check does not read the permissions, so a change that loosens them cannot loosen the check either.
test("does not let a change to the worker's permissions loosen what it may change", (t) => {
  const repo = repository(t);
  write(
    repo.cwd,
    ".opencode/agents/dev-worker.md",
    "---\npermissions: []\n---\n"
  );
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  const result = check(repo, {
    allow: ["*"],
    reported: [".opencode/agents/dev-worker.md", "src/a.test.ts"],
  });
  assertProblem(result, /protected file changed: src\/a\.test\.ts/);
});

// 사후 확인은 OpenCode 권한을 흉내 내지 않고 보호할 파일의 정의(설정 이름·시험 파일·비밀 파일)를 경로 조각으로 판정한다. OpenCode의
// `*`는 `/`를 넘어 권한이 다시 연 폴더 안의 실제 설정을 놓칠 수 있고, 같은 판정기를 쓰면 사후 확인도 똑같이 놓친다(#286 항목 27).
test("judges protected files by their names, not by OpenCode's patterns", (t) => {
  const repo = repository(
    t,
    fs.readFileSync(
      path.join(import.meta.dirname, "../../.opencode/agents/dev-worker.md"),
      "utf8"
    )
  );
  write(repo.cwd, "src/vitest.d/eslint.config.js", "export default [];\n");
  write(repo.cwd, "src/tsconfig-tools/tsconfig.json", "{}\n");
  write(repo.cwd, "src/vitest-tools/config.ts", "export const a = 1;\n");
  const result = check(repo, {
    allow: ["src/*"],
    reported: [
      "src/tsconfig-tools/tsconfig.json",
      "src/vitest-tools/config.ts",
      "src/vitest.d/eslint.config.js",
    ],
  });
  assertProblem(
    result,
    /protected file changed: src\/vitest\.d\/eslint\.config\.js/
  );
  assert.match(
    result.output,
    /protected file changed: src\/tsconfig-tools\/tsconfig\.json/
  );
  assert.doesNotMatch(result.output, /src\/vitest-tools\/config\.ts/);
});

test("reports a staged change that the working tree no longer shows", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  git(repo.cwd, "add", "src/a.test.ts");
  write(repo.cwd, "src/a.test.ts", "// test\n");
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = check(repo);
  assertProblem(result, /protected file changed: src\/a\.test\.ts/);
});

test("reports a file outside the allowed files", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = check(repo, { allow: ["src/b.ts"] });
  assertProblem(result, /outside the brief: src\/a\.ts/);
});

test("reports a report that differs from the actual change", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  write(repo.cwd, "src/b.ts", "export const b = 1;\n");
  const result = check(repo, { reported: ["src/a.ts", "src/c.ts"] });
  assertProblem(result, /changed but not reported: src\/b\.ts/);
  assertProblem(result, /reported but not changed: src\/c\.ts/);
});

test("reports a run that moved HEAD away from the base", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  commit(repo.cwd, "worker commit");
  assertProblem(check(repo), /HEAD moved/);
});

test("shows the output of a failing test command", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = check(repo, {
    tests: [
      `"${process.execPath}" -e "console.error('why it failed'); process.exit(3)"`,
    ],
  });
  assertProblem(result, /test command failed \(exit 3\)/);
  assertProblem(result, /why it failed/);
});

// 신호로 끝난 시험 명령은 종료 코드가 없다. "exit null"로 접지 않고 끝낸 신호를 알린다. 셸이 자기 자신을 끝내는 명령이라 POSIX만이다
// (check:agents는 Linux에서 돈다).
test(
  "names the signal that ended a test command",
  {
    skip:
      process.platform === "win32"
        ? "Windows has no signal a shell sends itself"
        : false,
  },
  (t) => {
    const repo = repository(t);
    write(repo.cwd, "src/a.ts", "export const a = 2;\n");
    const result = check(repo, { tests: ["kill -KILL $$"] });
    assertProblem(result, /test command failed \(SIGKILL\): kill -KILL \$\$/);
  }
);

test("does not run test commands once a problem is found", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.test.ts", "// weakened\n");
  const marker = path.join(repo.cwd, "ignored-marker");
  const result = check(repo, {
    reported: ["src/a.test.ts"],
    tests: [
      `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], '')" "${marker}"`,
    ],
  });
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(marker), false);
});

test("reports a change that the test commands leave behind", (t) => {
  const repo = repository(t);
  write(repo.cwd, "src/a.ts", "export const a = 2;\n");
  const result = check(repo, {
    tests: [
      `"${process.execPath}" -e "require('fs').writeFileSync('src/a.test.ts', '// rewritten')"`,
    ],
  });
  assertProblem(result, /protected file changed: src\/a\.test\.ts/);
});

test("the real worker permissions protect development scripts and leave product code editable", (t) => {
  const definition = fs.readFileSync(
    fileURLToPath(
      new URL("../../.opencode/agents/dev-worker.md", import.meta.url)
    ),
    "utf8"
  );
  for (const file of [
    "scripts/ci-changes.mjs",
    "scripts/boot-check.mjs",
    "scripts/file-boundary-run.mjs",
    "scripts/live/chaos-run.mjs",
    "patches/some-package.patch",
  ]) {
    const repo = repository(t, definition);
    write(repo.cwd, file, "// changed\n");
    const result = check(repo, { allow: ["*"], reported: [file] });
    assertProblem(result, new RegExp(`protected file changed: ${file}`));
  }
  for (const file of [
    "packages/core/src/approval.ts",
    "apps/server/src/main.ts",
    "apps/web/src/App.tsx",
  ]) {
    const repo = repository(t, definition);
    write(repo.cwd, file, "// changed\n");
    const result = check(repo, { allow: ["*"], reported: [file] });
    assert.equal(result.status, 0, result.output);
  }
});

test("reports a run that changed nothing", (t) => {
  assertProblem(check(repository(t)), /no files changed/);
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
