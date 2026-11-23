import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  intendedExclusions,
  judgeReports,
  systemOf,
} from "./check-test-reports.mjs";
import {
  isTestInput,
  judgedMarker,
  suiteFiles,
  suiteNamed,
  testSuites,
} from "./test-suites.ts";
import { codeFormatPattern } from "./test-files.mjs";
import { removeFolder } from "@babojubot/process/remove-folder";

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
/** 저장소의 파일 목록(Git). 명령은 이 목록과 묶음 정의로 기대하는 시험 파일을 정한다. */
const repositoryFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" }
)
  .split("\0")
  .filter(Boolean);
const reportsOf = (entries) => new Map(Object.entries(entries));
/** 보고서들에 든 시험 파일. 이 표본의 저장소 파일 목록으로 쓴다: 묶음 정의가 고르는 파일이 모두 돈 경우다. */
const filesIn = (entries) =>
  Object.values(entries).flatMap((entry) =>
    entry.testResults.map((result) =>
      path.relative(root, result.name).split(path.sep).join("/")
    )
  );
const problemsOf = (entries, os = "linux", expected = Object.keys(entries)) =>
  judgeReports(reportsOf(entries), { os, expected, files: filesIn(entries) })
    .problems;

const jobObject = "packages/runtime/src/providers/process-windows.test.ts";
const docker = "packages/runtime/src/providers/container.docker.test.ts";

test("accepts reports where every test file passed a test, skips beside passes included", () => {
  const entries = {
    server: report({
      "apps/server/test/a.test.ts": ["passed", "skipped", "todo"],
      "apps/server/test/b.test.ts": ["passed"],
    }),
  };
  const { problems, lines } = judgeReports(reportsOf(entries), {
    os: "linux",
    expected: ["server"],
    files: filesIn(entries),
  });
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

// 묶음 정의 밖의 시험 파일은 어느 판정도 기대하지 않아, 돌지 않아도 아무것도 실패하지 않는다. 저장소의 시험 파일은 모두 어느 묶음이
// 고르거나 시험 입력이어야 한다(#286 항목 19).
test("every test file in the repository is selected by a suite or is a test input", () => {
  const testFile = new RegExp(`\\.(?:test|spec)\\.${codeFormatPattern}$`);
  const tests = repositoryFiles.filter((file) => testFile.test(file));
  assert.ok(tests.length > 100, `${tests.length} test files`);
  const selected = new Set(
    testSuites.flatMap((suite) => suiteFiles(suite, repositoryFiles))
  );
  assert.deepEqual(
    tests.filter((file) => !selected.has(file) && !isTestInput(file)),
    []
  );
  // 시험 입력은 묶음이 고르지 않는다(묶음으로 돌리면 일부러 실패한다).
  assert.deepEqual(
    [...selected].filter((file) => isTestInput(file)),
    []
  );
});

test("names each suite once and lists node:test files that exist", () => {
  const names = testSuites.map((suite) => suite.name);
  assert.deepEqual(names, [...new Set(names)]);
  const present = new Set(repositoryFiles);
  for (const suite of testSuites)
    if (suite.runner === "node") {
      assert.ok(suite.files.length > 0, suite.name);
      assert.deepEqual(
        suite.files.filter((file) => !present.has(file)),
        [],
        suite.name
      );
    } else
      assert.ok(
        suiteFiles(suite, repositoryFiles).length > 0,
        `${suite.name} selects no test file`
      );
});

test("lists intended exclusions only for files their suite selects", () => {
  for (const exclusion of intendedExclusions)
    assert.ok(
      suiteFiles(suiteNamed(exclusion.report), repositoryFiles).includes(
        exclusion.file
      ),
      `${exclusion.report}: ${exclusion.file}`
    );
});

/** @type {[string, Record<string, ReturnType<typeof report>>, string?, string[]?][]} */
const rejected = [
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
];
for (const [name, entries, os = "linux", expected] of rejected) {
  test(`rejects ${name}`, () => {
    assert.notDeepEqual(problemsOf(entries, os, expected), [], name);
  });
}

// 보고서에 남은 파일만 판정하면, 묶음 설정의 필터나 명령의 파일 목록에서 시험 파일 하나가 통째로 빠져도 남은 파일이 통과해 성공한다
// (#286 항목 19). 기대하는 시험 파일은 실행과 따로, 저장소의 파일 목록(Git)과 묶음 정의로 정한다.
test("rejects a suite whose report misses a test file the suite selects", () => {
  const files = [
    "packages/contracts/src/a.test.ts",
    "packages/contracts/src/b.test.ts",
    "packages/contracts/src/helper.ts",
  ];
  assert.deepEqual(
    judgeReports(
      reportsOf({
        contracts: report({ "packages/contracts/src/a.test.ts": ["passed"] }),
      }),
      { os: "linux", expected: ["contracts"], files }
    ).problems,
    [
      "contracts: packages/contracts/src/b.test.ts did not run, though the suite selects it (scripts/test-suites.ts)",
    ]
  );
});

test("rejects a report that ran a test file its suite does not select", () => {
  const alone = "packages/process/src/lease-hidden.alone.test.ts";
  const files = ["packages/process/src/a.test.ts", alone];
  assert.deepEqual(
    judgeReports(
      reportsOf({
        process: report({
          "packages/process/src/a.test.ts": ["passed"],
          [alone]: ["passed"],
        }),
      }),
      { os: "linux", expected: ["process"], files }
    ).problems,
    [
      `process: ran ${alone}, which the suite does not select (scripts/test-suites.ts)`,
    ]
  );
});

// 시스템이 지원하지 않아 건너뛰는 파일도 시험을 모아 건너뛴 기록이 있어야 한다. 시험이 0개면 파일을 읽지 못했거나 시험이 사라진 것이다.
test("rejects an intended exclusion that ran no test at all", () => {
  const relay = "packages/runtime/src/providers/relay.test.ts";
  const skippedOnWindows = Object.fromEntries(
    intendedExclusions
      .filter(
        (e) =>
          e.report === "runtime" &&
          e.systems.includes("windows") &&
          e.file !== relay
      )
      .map((e) => [e.file, ["skipped"]])
  );
  const runtime = {
    "packages/runtime/src/a.test.ts": ["passed"],
    [jobObject]: ["passed"],
    ...skippedOnWindows,
    [relay]: [],
  };
  const files = Object.keys(runtime);
  assert.deepEqual(
    judgeReports(reportsOf({ runtime: report(runtime) }), {
      os: "windows",
      expected: ["runtime"],
      files,
    }).problems,
    [
      `runtime: ${relay} is listed as skipped on windows but recorded no test; a skipped file still reports its skipped tests`,
    ]
  );
});

test("rejects an unknown system and names the system of this computer", () => {
  assert.throws(
    () => judgeReports(reportsOf({}), { os: "aix", expected: [], files: [] }),
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

/** 묶음 정의가 이 저장소에서 고르는 시험 파일마다 `statuses`를 둔 보고서. */
const fullReport = (name, statuses = ["passed"]) =>
  report(
    Object.fromEntries(
      suiteFiles(suiteNamed(name), repositoryFiles).map((file) => [
        file,
        statuses,
      ])
    )
  );

test("fails the command for a rejected, unreadable or unnamed report, prints the counts and marks the folder judged", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-reports-"));
  context.after(() => removeFolder(dir));
  const run = (...args) =>
    spawnSync(process.execPath, [checker, ...args], {
      encoding: "utf8",
      env: { ...process.env, BABOJUBOT_TEST_REPORTS: dir },
    });
  const contracts = fullReport("contracts");
  writeFileSync(path.join(dir, "contracts.json"), JSON.stringify(contracts));
  const ok = run("--expect", "contracts");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(
    ok.stdout,
    new RegExp(
      `^contracts: ${contracts.testResults.length} files, ${contracts.testResults.length} tests, ${contracts.testResults.length} passed`,
      "m"
    )
  );
  // 판정한 폴더에는 표식이 남아, 같은 job에서 판정 뒤에 도는 묶음이 시작하지 않는다(scripts/test-suites.ts reportFolder).
  assert.match(readFileSync(path.join(dir, judgedMarker), "utf8"), /contracts/);
  // 묶음 정의가 고르는 파일 하나가 보고서에서 빠지면 실패한다.
  const [dropped, ...kept] = contracts.testResults;
  writeFileSync(
    path.join(dir, "contracts.json"),
    JSON.stringify({ testResults: kept })
  );
  const missingFile = run("--expect", "contracts");
  assert.equal(missingFile.status, 1);
  assert.match(
    missingFile.stderr,
    new RegExp(
      `contracts: ${path
        .relative(root, dropped?.name ?? "")
        .split(path.sep)
        .join("/")
        .replaceAll(".", "\\.")} did not run`
    )
  );
  writeFileSync(path.join(dir, "contracts.json"), JSON.stringify(contracts));
  writeFileSync(
    path.join(dir, "core.json"),
    JSON.stringify(fullReport("core", ["skipped"]))
  );
  const skippedOnly = run("--expect", "contracts,core");
  assert.equal(skippedOnly.status, 1);
  assert.match(skippedOnly.stderr, /^core: packages\/core\/.* passed no test/m);
  writeFileSync(path.join(dir, "core.json"), "not json");
  const unreadable = run("--expect", "contracts,core");
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /cannot read test report .*core\.json/);
  assert.equal(run().status, 1);
  const unknown = run("--expect", "contracts,no-such-suite");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown test suite "no-such-suite"/);
  // 보고 폴더를 줬는데 아무 묶음도 보고서를 남기지 않았으면 묶음마다 보고서가 없다고 알린다(#272 외부 리뷰 S1).
  const empty = spawnSync(
    process.execPath,
    [checker, "--expect", "server,web"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BABOJUBOT_TEST_REPORTS: path.join(dir, "never-made"),
      },
    }
  );
  assert.equal(empty.status, 1, empty.stderr);
  assert.match(empty.stderr, /^server: no test report$/m);
  assert.match(empty.stderr, /^web: no test report$/m);
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

/**
 * 자식 실행기의 환경. 이 시험을 돌리는 node:test의 자식 표시(NODE_TEST_CONTEXT)를 물려주면 자식이 시험을 돌리지 않는다. CI가 준
 * 보고서 필수 표시(BABOJUBOT_REQUIRE_TEST_REPORTS)도 물려주지 않는다: 그 표시가 있는 장면은 시험이 직접 켠다.
 */
function childEnv(reports) {
  const {
    NODE_TEST_CONTEXT: _context,
    BABOJUBOT_REQUIRE_TEST_REPORTS: _required,
    ...env
  } = process.env;
  return { ...env, BABOJUBOT_TEST_REPORTS: reports };
}

// node:test 묶음은 run-node-tests.mjs로 돌린다. 사람이 읽는 줄 보고는 그대로 내고, 보고 폴더가 있으면 같은 모양의 보고서를 남긴다.
// 묶음 정의 밖의 시험 입력(scripts/fixtures)은 실행기의 runNodeTests로 돌린다.
test("runs node:test files, keeps their exit code and writes a report the checker reads", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-reports-"));
  context.after(() => removeFolder(dir));
  // node:test의 run은 부모의 실행 인수(`-e` 등)를 시험 파일 프로세스에 물려주므로, 코드 글이 아니라 파일로 실행기를 부른다.
  const driver = path.join(dir, "driver.mjs");
  writeFileSync(
    driver,
    `import { runNodeTests } from ${JSON.stringify(pathToFileURL(runner).href)};\nrunNodeTests(process.argv[2], process.argv.slice(3));\n`
  );
  const runIn = (env, name, ...files) =>
    spawnSync(
      process.execPath,
      [driver, name, ...files.map((file) => path.join(fixtures, file))],
      { encoding: "utf8", env }
    );
  const run = (name, ...files) => runIn(childEnv(dir), name, ...files);
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
  const skipFile = path
    .relative(root, path.join(fixtures, "skips.test.mjs"))
    .split(path.sep)
    .join("/");
  assert.match(
    judgeReports(reportsOf({ boot: judged }), {
      os: "linux",
      expected: [],
      files: [skipFile],
    }).problems.join("\n"),
    /boot: report this job did not expect/
  );
  // 보고 폴더가 없으면(로컬) 보고서를 남기지 않고 줄 보고만 낸다.
  const local = runIn(childEnv(""), "fixture-local", "passes.test.mjs");
  assert.equal(local.status, 0, local.stderr);
  assert.throws(() =>
    readFileSync(path.join(dir, "fixture-local.json"), "utf8")
  );
  // CI가 보고서를 필수로 했는데 보고 폴더가 없으면 시험을 돌리지 않고 실패한다(래퍼 스크립트로 옮긴 실행도 같다).
  const unreported = runIn(
    { ...childEnv(""), BABOJUBOT_REQUIRE_TEST_REPORTS: "1" },
    "fixture-unreported",
    "passes.test.mjs"
  );
  assert.notEqual(unreported.status, 0);
  assert.match(
    unreported.stderr,
    /test suite fixture-unreported runs where CI requires a report/
  );
  assert.doesNotMatch(unreported.stdout, /✔ adds/);
  // 그 job의 판정이 끝난 폴더면 돌리지 않는다. 판정 뒤의 보고서는 아무도 판정하지 않는다.
  writeFileSync(path.join(dir, judgedMarker), "judged\n");
  const afterJudging = run("fixture-late", "passes.test.mjs");
  assert.notEqual(afterJudging.status, 0);
  assert.match(
    afterJudging.stderr,
    /test suite fixture-late runs after this job's reports were judged/
  );
});

test("runs a node:test suite by its name only, with the files the suite definition lists", () => {
  const extra = spawnSync(
    process.execPath,
    [runner, "check-rules", "scripts/lint-rules.test.mjs"],
    { encoding: "utf8", env: childEnv("") }
  );
  assert.equal(extra.status, 1);
  assert.match(
    extra.stderr,
    /usage: node scripts\/run-node-tests\.mjs <suite>/
  );
  const vitestSuite = spawnSync(process.execPath, [runner, "core"], {
    encoding: "utf8",
    env: childEnv(""),
  });
  assert.equal(vitestSuite.status, 1);
  assert.match(vitestSuite.stderr, /test suite core is not a node:test suite/);
});
