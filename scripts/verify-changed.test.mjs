import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import { codeFormats, isTestFile } from "./test-files.mjs";
import { plan } from "./verify-changed.mjs";

const script = fileURLToPath(new URL("./verify-changed.mjs", import.meta.url));
const limitMs = 30_000;

const graph = {
  "@babojubot/contracts": { dir: "packages/contracts", deps: [] },
  "@babojubot/core": {
    dir: "packages/core",
    deps: ["@babojubot/contracts"],
  },
  "@babojubot/runtime": {
    dir: "packages/runtime",
    deps: ["@babojubot/contracts"],
  },
  "@babojubot/server": {
    dir: "apps/server",
    deps: ["@babojubot/core", "@babojubot/runtime"],
  },
  "@babojubot/web": { dir: "apps/web", deps: ["@babojubot/runtime"] },
  // 저장소 뿌리 패키지: scripts·.agents의 시험이 쓰는 패키지를 의존성으로 둔다.
  babojubot: { dir: ".", deps: ["@babojubot/runtime"] },
};

const lint = (...files) =>
  `pnpm exec eslint --no-warn-ignored ${files.join(" ")}`;
const typecheck = (name, kind = "") =>
  `pnpm --filter ${name} run typecheck${kind ? `:${kind}` : ""}`;
/** 문서 검사는 늘 돈다. 나머지 묶음은 그 묶음의 시험이 보는 파일이 바뀌었을 때만 돈다. */
const docs = "pnpm check:docs";
const typecheckJs = "pnpm typecheck:js";
const rules = "pnpm check:rules";
const agents = "pnpm check:agents";
const scripts = "pnpm check:scripts";

test("runs only the document check for document changes", () => {
  assert.deepEqual(plan(["README.md", "docs/agents/worker.md"], graph), [docs]);
});

test("runs only the document check when nothing changed", () => {
  assert.deepEqual(plan([], graph), [docs]);
});

test("type-checks only the test side when only tests changed", () => {
  assert.deepEqual(plan(["apps/server/test/a.test.ts"], graph), [
    lint("apps/server/test/a.test.ts"),
    typecheck("@babojubot/server", "test"),
    typecheckJs,
    docs,
  ]);
});

test("type-checks the changed package and every package that uses it when product code changed", () => {
  assert.deepEqual(plan(["packages/core/src/policy.ts"], graph), [
    lint("packages/core/src/policy.ts"),
    typecheck("@babojubot/core"),
    typecheck("@babojubot/server"),
    typecheckJs,
    docs,
  ]);
});

test("follows users of users", () => {
  assert.deepEqual(plan(["packages/contracts/src/task.ts"], graph), [
    lint("packages/contracts/src/task.ts"),
    typecheck("@babojubot/contracts"),
    typecheck("@babojubot/core"),
    typecheck("@babojubot/runtime"),
    typecheck("@babojubot/server"),
    typecheck("@babojubot/web"),
    typecheckJs,
    docs,
    rules,
    agents,
    scripts,
  ]);
});

test("type-checks the test side of users when a shared test helper changed", () => {
  assert.deepEqual(plan(["packages/runtime/src/testing.ts"], graph), [
    lint("packages/runtime/src/testing.ts"),
    typecheck("@babojubot/runtime", "test"),
    typecheck("@babojubot/server", "test"),
    typecheck("@babojubot/web", "test"),
    typecheckJs,
    docs,
    rules,
    agents,
    scripts,
  ]);
});

test("a full type check wins over a test-side one for the same package", () => {
  assert.deepEqual(
    plan(["apps/server/test/a.test.ts", "packages/runtime/src/run.ts"], graph),
    [
      lint("apps/server/test/a.test.ts", "packages/runtime/src/run.ts"),
      typecheck("@babojubot/runtime"),
      typecheck("@babojubot/server"),
      typecheck("@babojubot/web"),
      typecheckJs,
      docs,
      rules,
      agents,
      scripts,
    ]
  );
});

test("treats package settings outside src as product changes", () => {
  assert.deepEqual(
    plan(["packages/core/package.json", "apps/web/vite.config.ts"], graph),
    [
      lint("apps/web/vite.config.ts"),
      typecheck("@babojubot/core"),
      typecheck("@babojubot/server"),
      typecheck("@babojubot/web"),
      typecheckJs,
      docs,
    ]
  );
});

for (const file of [
  "eslint.config.js",
  "scripts/test-files.mjs",
  "scripts/eslint-test-rules.mjs",
  "scripts/eslint-product-rules.mjs",
  "tsconfig.base.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/some-package.patch",
]) {
  test(`checks everything when shared setting ${file} changed`, () => {
    assert.deepEqual(plan([file, "packages/core/src/policy.ts"], graph), [
      "pnpm lint",
      "pnpm typecheck",
      "pnpm check",
    ]);
  });
}

test("lints scripts outside packages without type-checking a package", () => {
  assert.deepEqual(
    plan(["scripts/ci-changes.mjs", ".agents/scripts/run-worker.mjs"], graph),
    [
      lint(".agents/scripts/run-worker.mjs", "scripts/ci-changes.mjs"),
      typecheckJs,
      docs,
      agents,
      scripts,
    ]
  );
});

test("type-checks the JS when any code file changed", () => {
  // JS는 패키지의 TypeScript를 부르므로 TypeScript가 바뀌어도 다시 검사한다(지운 파일도 부르던 쪽이 깨진다).
  for (const file of [
    "scripts/ci-changes.mjs",
    "packages/runtime/test-fixtures/fake-docker.mjs",
    "packages/core/src/policy.ts",
  ]) {
    assert.ok(plan([file], graph).includes(typecheckJs), file);
    assert.ok(
      plan([file], graph, { exists: () => false }).includes(typecheckJs),
      `${file} deleted`
    );
  }
  assert.ok(!plan(["README.md"], graph).includes(typecheckJs));
});

test("lints a changed code file in every format", () => {
  // lint가 검사하는 형식(scripts/test-files.mjs의 codeFormats)이면 어느 것이든 바뀐 파일을 lint한다(#270).
  for (const format of codeFormats.slice(1, -1).split(",")) {
    const file = `packages/core/src/a.${format}`;
    assert.equal(plan([file], graph)[0], lint(file), file);
  }
});

test("runs the lint rule tests when a lint rule or its test changed", () => {
  for (const file of [
    "scripts/eslint-imports.mjs",
    "scripts/lint-access-shapes.mjs",
    "scripts/lint-rule-testing.mjs",
    "scripts/lint-rules.test.mjs",
    "scripts/product-lint-rules.test.mjs",
  ])
    assert.deepEqual(
      plan([file], graph),
      [lint(file), typecheckJs, docs, rules],
      file
    );
});

test("runs the worker tests when the agent tools changed", () => {
  assert.deepEqual(plan([".agents/agents/dev-worker.md"], graph), [
    docs,
    agents,
  ]);
  assert.deepEqual(plan([".opencode/agents/dev-worker.md"], graph), [
    docs,
    agents,
  ]);
});

test("runs the script tests when a script or the CI workflow changed", () => {
  assert.deepEqual(plan([".github/workflows/scaffold.yml"], graph), [
    docs,
    scripts,
  ]);
  assert.deepEqual(plan(["scripts/live/check-server.mjs"], graph), [
    lint("scripts/live/check-server.mjs"),
    typecheckJs,
    docs,
    scripts,
  ]);
});

test("runs the rule, worker and script tests when a package the root uses changed", () => {
  // 뿌리 패키지가 쓰는 runtime이 바뀌면 lint 규칙·scripts·.agents의 시험도 돈다. 쓰지 않는 core만 바뀌면 돌지 않는다.
  assert.deepEqual(plan(["packages/runtime/src/run.ts"], graph), [
    lint("packages/runtime/src/run.ts"),
    typecheck("@babojubot/runtime"),
    typecheck("@babojubot/server"),
    typecheck("@babojubot/web"),
    typecheckJs,
    docs,
    rules,
    agents,
    scripts,
  ]);
});

test("pnpm check runs every group, and changing a group's test file runs that group", () => {
  // 묶음에 시험을 더하고 고르는 규칙을 고치지 않으면 그 시험만 바꿔도 묶음이 돌지 않는다.
  const { scripts: commands } = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  const groups = Object.keys(commands)
    .filter((name) => name.startsWith("check:"))
    .map((name) => name.slice("check:".length));
  assert.deepEqual(
    commands.check.split("&&").map((part) => part.trim()),
    groups.map((group) => `pnpm run check:${group}`)
  );
  for (const group of groups.filter((group) => group !== "docs"))
    for (const file of commands[`check:${group}`]
      .split(/\s+/)
      .filter((word) => word.endsWith(".test.mjs")))
      assert.ok(
        plan([file], graph).includes(`pnpm check:${group}`),
        `${file} does not run check:${group}`
      );
});

test("with tests, runs the tests of the changed packages and the packages that use them", () => {
  assert.deepEqual(
    plan(["packages/core/src/policy.ts"], graph, { tests: true }),
    [
      lint("packages/core/src/policy.ts"),
      typecheck("@babojubot/core"),
      typecheck("@babojubot/server"),
      typecheckJs,
      docs,
      "pnpm --filter @babojubot/core --filter @babojubot/server run test",
    ]
  );
  // 뿌리 패키지가 쓰는 패키지가 바뀌면 뿌리의 시험(boot-check, 시험 실패 종료 코드)도 돈다.
  assert.deepEqual(
    plan(["packages/runtime/src/testing.ts"], graph, { tests: true }),
    [
      lint("packages/runtime/src/testing.ts"),
      typecheck("@babojubot/runtime", "test"),
      typecheck("@babojubot/server", "test"),
      typecheck("@babojubot/web", "test"),
      typecheckJs,
      docs,
      rules,
      agents,
      scripts,
      "pnpm --filter @babojubot/runtime --filter @babojubot/server --filter @babojubot/web run test",
      "pnpm test:root",
    ]
  );
});

test("with tests, runs the root tests when a root test or its script changed", () => {
  for (const file of [
    "scripts/boot-check.mjs",
    "scripts/boot-check-flow.test.mjs",
    "scripts/check-test-exit-code.mjs",
    "scripts/fixtures/test-exit-code/broken-setup.mjs",
  ])
    assert.deepEqual(
      plan([file], graph, { tests: true }),
      [lint(file), typecheckJs, docs, scripts, "pnpm test:root"],
      file
    );
});

test("with tests, runs no test for document changes and every test for shared settings", () => {
  assert.deepEqual(plan(["docs/agents/worker.md"], graph, { tests: true }), [
    docs,
  ]);
  assert.deepEqual(plan(["pnpm-lock.yaml"], graph, { tests: true }), [
    "pnpm lint",
    "pnpm typecheck",
    "pnpm check",
    "pnpm test",
  ]);
});

test("pnpm test runs every package's tests and then the root tests", () => {
  const { scripts: commands } = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(
    commands.test,
    "pnpm -r --if-present run test && pnpm run test:root"
  );
});

test("does not lint deleted files but still type-checks their package", () => {
  const exists = (file) => file !== "packages/core/src/old.ts";
  assert.deepEqual(
    plan(["packages/core/src/old.ts", "packages/core/src/new.ts"], graph, {
      exists,
    }),
    [
      lint("packages/core/src/new.ts"),
      typecheck("@babojubot/core"),
      typecheck("@babojubot/server"),
      typecheckJs,
      docs,
    ]
  );
});

test("lints each file once, in path order", () => {
  assert.deepEqual(
    plan(
      [
        "packages/core/src/b.ts",
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
      ],
      graph
    ),
    [
      lint("packages/core/src/a.ts", "packages/core/src/b.ts"),
      typecheck("@babojubot/core"),
      typecheck("@babojubot/server"),
      typecheckJs,
      docs,
    ]
  );
});

test("does not lint files ESLint does not read", () => {
  assert.deepEqual(plan(["packages/core/src/data.json"], graph), [
    typecheck("@babojubot/core"),
    typecheck("@babojubot/server"),
    docs,
  ]);
});

for (const file of [
  "apps/web/src/markdown.test.tsx",
  "apps/web/e2e/support/organization.ts",
  "apps/web/test/playwright-config.test.ts",
  "apps/server/test/support.ts",
  "packages/runtime/src/testing.ts",
  "packages/runtime/src/providers/test-support.ts",
  "packages/runtime/src/providers/test-folders.ts",
  "packages/runtime/src/providers/cli-tolerance-support.ts",
  "packages/process/src/testing.ts",
  "packages/process/src/test-cleanup.ts",
  "packages/process/src/test-support.ts",
  "packages/process/src/test-folders.ts",
  "packages/process/src/lifeline-support.ts",
  "packages/process/src/process-test-support.ts",
  "packages/process/src/launcher-setup-support.ts",
  "packages/db/src/testing.ts",
  "packages/db/src/test-cluster.ts",
  "scripts/ci-changes.test.mjs",
]) {
  test(`counts ${file} as test code`, () => {
    assert.equal(isTestFile(file), true);
  });
}

for (const file of [
  "apps/web/src/App.tsx",
  "apps/server/src/main.ts",
  "packages/runtime/src/providers/process.ts",
  "packages/process/src/launch.ts",
  "packages/process/src/remove-folder.ts",
  "packages/process/src/recovery.ts",
  "apps/server/test-fixtures/fake-cli.mjs",
]) {
  test(`counts ${file} as non-test code`, () => {
    assert.equal(isTestFile(file), false);
  });
}

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

function write(cwd, file, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "babojubot-verify-"));
  t.after(() => removeFolder(cwd));
  write(cwd, "package.json", '{ "name": "root" }\n');
  write(cwd, "packages/a/package.json", '{ "name": "@x/a" }\n');
  write(
    cwd,
    "apps/b/package.json",
    '{ "name": "@x/b", "dependencies": { "@x/a": "workspace:*", "left-pad": "1.0.0" } }\n'
  );
  write(cwd, "apps/c/package.json", '{ "name": "@x/c" }\n');
  write(cwd, "packages/a/src/a.ts", "export const a = 1;\n");
  write(cwd, "packages/a/src/gone.ts", "export const gone = 1;\n");
  git(cwd, "init", "-q");
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
    "base"
  );
  return { cwd, base: git(cwd, "rev-parse", "HEAD") };
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: limitMs,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("prints the plan for uncommitted, untracked and deleted files against the base", (t) => {
  const { cwd, base } = repository(t);
  write(cwd, "packages/a/src/a.ts", "export const a = 2;\n");
  write(cwd, "packages/a/src/new.ts", "export const b = 1;\n");
  fs.rmSync(path.join(cwd, "packages/a/src/gone.ts"));
  write(cwd, "docs/a.md", "# a\n");

  const result = run(cwd, ["--dry-run", "--base", base]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "pnpm exec eslint --no-warn-ignored packages/a/src/a.ts packages/a/src/new.ts",
    "pnpm --filter @x/a run typecheck",
    "pnpm --filter @x/b run typecheck",
    "pnpm typecheck:js",
    "pnpm check:docs",
  ]);
});

test("adds the tests of the changed packages with --tests", (t) => {
  const { cwd, base } = repository(t);
  write(cwd, "packages/a/src/a.ts", "export const a = 2;\n");

  const result = run(cwd, ["--dry-run", "--tests", "--base", base]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "pnpm exec eslint --no-warn-ignored packages/a/src/a.ts",
    "pnpm --filter @x/a run typecheck",
    "pnpm --filter @x/b run typecheck",
    "pnpm typecheck:js",
    "pnpm check:docs",
    "pnpm --filter @x/a --filter @x/b run test",
  ]);
});

test("rejects an unknown option", (t) => {
  const { cwd } = repository(t);
  const result = run(cwd, ["--bogus"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--bogus/);
});
