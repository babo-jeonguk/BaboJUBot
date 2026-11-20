import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  intendedExclusions,
  judgeReports,
  systemOf,
} from "./check-test-reports.mjs";
import { removeFolder } from "@babojubot/runtime/remove-folder";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (file) => path.join(root, file);

// Vitest JSON 보고서(Jest 호환 모양)를 줄여 만든다. files는 { 저장소 기준 경로: [상태, …] }.
function report(files) {
  return {
    testResults: Object.entries(files).map(([file, statuses]) => ({
      name: at(file),
      assertionResults: statuses.map((status, i) => ({
        title: `case ${i}`,
        fullName: `group case ${i}`,
        status,
      })),
    })),
  };
}
const reportsOf = (entries) => new Map(Object.entries(entries));
const problemsOf = (entries, os = "linux", expected = Object.keys(entries)) =>
  judgeReports(reportsOf(entries), { os, expected }).problems;

const jobObject = "packages/runtime/src/providers/job-object.test.ts";
const docker = "packages/runtime/src/providers/container.docker.test.ts";

test("accepts reports where every test file passed a test, skips beside passes included", () => {
  const { problems, lines } = judgeReports(
    reportsOf({
      server: report({
        "apps/server/test/a.test.ts": ["passed", "skipped", "todo"],
        "apps/server/test/b.test.ts": ["passed"],
      }),
    }),
    { os: "linux", expected: ["server"] }
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(lines, [
    "server: 2 files, 4 tests, 2 passed, 1 skipped, 1 todo, 0 failed",
  ]);
});

test("accepts a test file skipped on purpose on a system listed with its reason", () => {
  assert.deepEqual(
    problemsOf({
      runtime: report({
        [jobObject]: ["skipped", "skipped"],
        "packages/runtime/src/a.test.ts": ["passed"],
      }),
    }),
    []
  );
  assert.deepEqual(
    problemsOf(
      {
        runtime: report({
          [jobObject]: ["skipped"],
          [docker]: ["skipped"],
          "packages/runtime/src/a.test.ts": ["passed"],
        }),
      },
      "macos"
    ),
    []
  );
});

test("lists each intended exclusion with its suite, systems and reason, and only for files that exist", () => {
  for (const exclusion of intendedExclusions) {
    assert.ok(exclusion.report && exclusion.reason, JSON.stringify(exclusion));
    assert.ok(exclusion.systems.length > 0, exclusion.file);
    assert.ok(
      exclusion.systems.every((os) =>
        ["linux", "macos", "windows"].includes(os)
      ),
      exclusion.file
    );
    assert.ok(
      readFileSync(at(exclusion.file), "utf8").length > 0,
      exclusion.file
    );
  }
});

for (const [name, entries, os = "linux", expected] of [
  // 이 파일의 시험이 모두 건너뛰어져도 Vitest는 0으로 끝난다(재현: test.skip만 있는 파일).
  [
    "a test file whose every test was skipped",
    {
      server: report({
        "apps/server/test/a.test.ts": ["passed"],
        "apps/server/test/b.test.ts": ["skipped", "skipped"],
      }),
    },
  ],
  [
    "a test file with only todo tests",
    { server: report({ "apps/server/test/a.test.ts": ["todo"] }) },
  ],
  [
    "a test file with no test",
    {
      server: report({
        "apps/server/test/a.test.ts": ["passed"],
        "apps/server/test/b.test.ts": [],
      }),
    },
  ],
  ["a report with no test file", { server: report({}) }],
  [
    "a failed test",
    { server: report({ "apps/server/test/a.test.ts": ["passed", "failed"] }) },
  ],
  [
    "an unknown status",
    {
      server: report({ "apps/server/test/a.test.ts": ["passed", "disabled"] }),
    },
  ],
  // 의도한 제외는 그 묶음·시스템에만 적용한다.
  [
    "the Windows-only launcher test skipped on Windows",
    { runtime: report({ [jobObject]: ["skipped"] }) },
    "windows",
  ],
  [
    "a listed file skipped in another suite",
    { server: report({ [jobObject]: ["skipped"] }) },
  ],
  [
    "the Docker test skipped on Linux, where CI requires Docker",
    { runtime: report({ [docker]: ["skipped"], [jobObject]: ["skipped"] }) },
  ],
  // 제외한 파일이 그 시스템에서 돌기 시작하거나 빠지면 목록이 낡았다.
  [
    "a listed file that now passes on its system",
    {
      runtime: report({
        [jobObject]: ["passed"],
        "packages/runtime/src/a.test.ts": ["passed"],
      }),
    },
  ],
  [
    "a listed file missing from its suite",
    { runtime: report({ "packages/runtime/src/a.test.ts": ["passed"] }) },
  ],
  // 예상한 보고서가 빠지거나 모르는 보고서가 있으면 그 묶음을 확인하지 못했다.
  [
    "a missing report",
    { server: report({ "apps/server/test/a.test.ts": ["passed"] }) },
    "linux",
    ["server", "server-files"],
  ],
  [
    "a report nobody expected",
    {
      server: report({ "apps/server/test/a.test.ts": ["passed"] }),
      web: report({ "apps/web/src/a.test.ts": ["passed"] }),
    },
    "linux",
    ["server"],
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.notDeepEqual(problemsOf(entries, os, expected), [], name);
  });
}

test("rejects an unknown system and names the system of this computer", () => {
  assert.throws(
    () => judgeReports(reportsOf({}), { os: "aix", expected: [] }),
    /unknown system "aix"/
  );
  assert.equal(systemOf("linux"), "linux");
  assert.equal(systemOf("darwin"), "macos");
  assert.equal(systemOf("win32"), "windows");
  assert.throws(() => systemOf("aix"), /aix/);
});

const checker = fileURLToPath(
  new URL("./check-test-reports.mjs", import.meta.url)
);
const runner = fileURLToPath(new URL("./run-node-tests.mjs", import.meta.url));
const fixtures = fileURLToPath(
  new URL("./fixtures/test-reports/", import.meta.url)
);

test("fails the command for a rejected, unreadable or unnamed report and prints the counts", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-reports-"));
  context.after(() => removeFolder(dir));
  const run = (...args) =>
    spawnSync(process.execPath, [checker, ...args], {
      encoding: "utf8",
      env: { ...process.env, BABOJUBOT_TEST_REPORTS: dir },
    });
  writeFileSync(
    path.join(dir, "server.json"),
    JSON.stringify(report({ "apps/server/test/a.test.ts": ["passed"] }))
  );
  const ok = run("--expect", "server");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /server: 1 files, 1 tests, 1 passed/);
  writeFileSync(
    path.join(dir, "web.json"),
    JSON.stringify(report({ "apps/web/src/a.test.ts": ["skipped"] }))
  );
  const skippedOnly = run("--expect", "server,web");
  assert.equal(skippedOnly.status, 1);
  assert.match(
    skippedOnly.stderr,
    /apps\/web\/src\/a\.test\.ts passed no test/
  );
  writeFileSync(path.join(dir, "web.json"), "not json");
  const unreadable = run("--expect", "server,web");
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /cannot read test report .*web\.json/);
  assert.equal(run().status, 1);
  const noFolder = spawnSync(
    process.execPath,
    [checker, "--expect", "server"],
    {
      encoding: "utf8",
      env: { ...process.env, BABOJUBOT_TEST_REPORTS: "" },
    }
  );
  assert.equal(noFolder.status, 1);
  assert.match(noFolder.stderr, /BABOJUBOT_TEST_REPORTS/);
});

/** 자식 실행기의 환경. 이 시험을 돌리는 node:test의 자식 표시(NODE_TEST_CONTEXT)를 물려주면 자식이 시험을 돌리지 않는다. */
function childEnv(reports) {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return { ...env, BABOJUBOT_TEST_REPORTS: reports };
}

// node:test 묶음은 run-node-tests.mjs로 돌린다. 사람이 읽는 줄 보고는 그대로 내고, 보고 폴더가 있으면 같은 모양의 보고서를 남긴다.
test("runs node:test files, keeps their exit code and writes a report the checker reads", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-reports-"));
  context.after(() => removeFolder(dir));
  const run = (name, ...files) =>
    spawnSync(
      process.execPath,
      [runner, name, ...files.map((file) => path.join(fixtures, file))],
      { encoding: "utf8", env: childEnv(dir) }
    );
  const passing = run("fixture-pass", "passes.test.mjs");
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /✔ adds/);
  const written = JSON.parse(
    readFileSync(path.join(dir, "fixture-pass.json"), "utf8")
  );
  assert.deepEqual(
    written.testResults.map((file) => [
      path.basename(file.name),
      file.assertionResults.map((t) => [t.fullName, t.status]),
    ]),
    [
      [
        "passes.test.mjs",
        [
          ["adds", "passed"],
          ["group > nested", "passed"],
          ["skipped on purpose", "skipped"],
          ["later", "todo"],
        ],
      ],
    ]
  );
  // 시험이 모두 건너뛰어져도 node:test는 0으로 끝난다. 그 보고서를 검사기가 거부한다.
  const skipped = run("fixture-skip", "skips.test.mjs");
  assert.equal(skipped.status, 0, skipped.stderr);
  const failing = run("fixture-fail", "fails.test.mjs");
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /✖ breaks/);
  const missing = run("fixture-missing", "missing.test.mjs");
  assert.equal(missing.status, 1);
  const judged = JSON.parse(
    readFileSync(path.join(dir, "fixture-skip.json"), "utf8")
  );
  assert.match(
    judgeReports(reportsOf({ "fixture-skip": judged }), {
      os: "linux",
      expected: ["fixture-skip"],
    }).problems.join("\n"),
    /skips\.test\.mjs passed no test/
  );
  // 보고 폴더가 없으면(로컬) 보고서를 남기지 않고 줄 보고만 낸다.
  const local = spawnSync(
    process.execPath,
    [runner, "fixture-local", path.join(fixtures, "passes.test.mjs")],
    { encoding: "utf8", env: childEnv("") }
  );
  assert.equal(local.status, 0, local.stderr);
  mkdirSync(dir, { recursive: true });
  assert.throws(() =>
    readFileSync(path.join(dir, "fixture-local.json"), "utf8")
  );
});
