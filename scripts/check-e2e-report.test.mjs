import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { combine, expectedSpecs, judge } from "./check-e2e-report.mjs";
import { removeFolder } from "@babojubot/process/remove-folder";

// Playwright JSON 보고서의 모양(파일별 suite → specs → tests, 시험마다 기대 상태·주석·결과 상태)을 줄여 만든다.
const passing = (file, title = "works") => ({
  file,
  title,
  status: "expected",
  expectedStatus: "passed",
});
const skipped = (file, title, reason) => ({
  file,
  title,
  status: "skipped",
  expectedStatus: "skipped",
  annotations: [{ type: "skip", description: reason }],
});
function report(tests, { errors = [], shard } = {}) {
  const byFile = new Map();
  for (const t of tests) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push({
      title: t.title,
      file: t.file,
      line: byFile.get(t.file).length + 1,
      column: 1,
      tests: [
        {
          status: t.status,
          expectedStatus: t.expectedStatus,
          annotations: t.annotations ?? [],
        },
      ],
    });
  }
  return {
    config: shard ? { shard } : { shard: null },
    suites: [...byFile].map(([file, specs]) => ({
      title: file,
      file,
      specs,
      suites: [],
    })),
    errors,
  };
}

const perf = "research-map-perf.spec.ts";
const perfTitle =
  "research map performance across node counts, secondary link ratios and widths";
const perfReason = "MAP_PERF=1일 때만 측정한다";
const helper = "support/server-process.spec.ts";
const helperTitle =
  "a server that ends before it is ready and whose folder cannot be removed reports both failures";
const helperReason = "Windows에서는 폴더 권한으로 삭제를 막을 수 없다";
// 판정이 예상하는 spec. 실제 목록(expectedSpecs)과 따로 두어 시험이 디스크의 spec 수에 묶이지 않게 한다.
const specs = ["home.spec.ts", helper, "support/shared-settings.spec.ts", perf];
const allPassing = () => [
  passing("home.spec.ts"),
  passing(helper),
  passing(helper, helperTitle),
  passing("support/shared-settings.spec.ts"),
  skipped(perf, perfTitle, perfReason),
];
const check = (tests, os = "linux", options) =>
  judge(report(tests, options), { os, specs }).problems;

test("accepts a run where every expected spec ran and passed", () => {
  const { summary, problems } = judge(report(allPassing()), {
    os: "linux",
    specs,
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(summary, {
    total: 5,
    passed: 4,
    failed: 0,
    flaky: 0,
    skipped: 1,
  });
});

test("accepts the performance measurement skipped for its stated reason on every system", () => {
  for (const os of ["linux", "windows"])
    assert.deepEqual(check(allPassing(), os), [], os);
});

test("accepts the helper's folder permission check skipped on Windows for its stated reason", () => {
  const tests = allPassing().map((t) =>
    t.title === helperTitle ? skipped(helper, helperTitle, helperReason) : t
  );
  assert.deepEqual(check(tests, "windows"), []);
  // Windows 보고서의 `\`도 같은 경로다.
  const backslashed = tests.map((t) => ({
    ...t,
    file: t.file.replaceAll("/", "\\"),
  }));
  assert.deepEqual(check(backslashed, "windows"), []);
});

test("reads the expected specs from the E2E folder", () => {
  const found = expectedSpecs();
  for (const spec of [
    "home.spec.ts",
    "support/shared-settings.spec.ts",
    "support/server-process.spec.ts",
    perf,
  ])
    assert.ok(found.includes(spec), `${spec} in ${found.join(", ")}`);
  // 안쪽 실행의 check 파일과 도움 파일은 spec이 아니다.
  assert.ok(found.every((spec) => spec.endsWith(".spec.ts")));
  assert.ok(found.every((spec) => !spec.includes("\\")));
});

const replace = (title, replacement) =>
  allPassing().map((t) => (t.title === title ? replacement : t));
for (const [name, tests, os = "linux", options] of [
  [
    "a failed test",
    [
      ...allPassing(),
      { ...passing("home.spec.ts", "b"), status: "unexpected" },
    ],
  ],
  [
    "a flaky test",
    [...allPassing(), { ...passing("home.spec.ts", "b"), status: "flaky" }],
  ],
  [
    "a skip without the stated reason",
    [...allPassing(), skipped("home.spec.ts", "b", "later")],
  ],
  [
    "the performance file skipped for another reason",
    replace(perfTitle, skipped(perf, perfTitle, "flaky")),
  ],
  [
    "another test of the performance file skipped for its reason",
    [...allPassing(), skipped(perf, "another measurement", perfReason)],
  ],
  // 실패 예정(test.fail)으로 표시한 시험은 실패해도 결과 상태가 expected다. 기대 상태와 주석으로 거부한다.
  [
    "a failure expected by test.fail",
    [
      ...allPassing(),
      {
        ...passing("home.spec.ts", "b"),
        expectedStatus: "failed",
        annotations: [{ type: "fail" }],
      },
    ],
  ],
  [
    "a test expected to fail without the annotation",
    [
      ...allPassing(),
      { ...passing("home.spec.ts", "b"), expectedStatus: "failed" },
    ],
  ],
  [
    "a test expected to time out",
    [
      ...allPassing(),
      { ...passing("home.spec.ts", "b"), expectedStatus: "timedOut" },
    ],
  ],
  [
    "a fail annotation on a passing test",
    [
      ...allPassing(),
      { ...passing("home.spec.ts", "b"), annotations: [{ type: "fail" }] },
    ],
  ],
  ["no test at all", []],
  // Windows 전용 건너뜀은 Linux에서, 다른 시험에서, 다른 경로에서 허용하지 않는다.
  [
    "the Windows-only skip on Linux",
    replace(helperTitle, skipped(helper, helperTitle, helperReason)),
    "linux",
  ],
  [
    "the Windows reason on another test of the same file",
    [...allPassing(), skipped(helper, "another check", helperReason)],
    "windows",
  ],
  [
    "the Windows reason on a file that only ends with the same path",
    [...allPassing(), skipped(`other/${helper}`, helperTitle, helperReason)],
    "windows",
  ],
  // 예상 spec이 통째로 빠지거나, 돌았지만 하나도 통과하지 않거나, 모르는 spec이 섞이면 거부한다.
  [
    "a missing spec such as the shared settings one",
    allPassing().filter((t) => t.file !== "support/shared-settings.spec.ts"),
  ],
  [
    "a spec whose every test was skipped",
    [
      ...allPassing().filter((t) => t.file !== "home.spec.ts"),
      skipped("home.spec.ts", "works", perfReason),
    ],
  ],
  [
    "a spec the E2E folder does not have",
    [...allPassing(), passing("gone.spec.ts")],
  ],
  [
    "a run error such as a failed teardown",
    allPassing(),
    "linux",
    { errors: [{ message: "공용 E2E 서버가 정리에 실패했다" }] },
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.notDeepEqual(check(tests, os, options), [], name);
  });
}

test("rejects a run without a known system", () => {
  assert.throws(
    () => judge(report(allPassing()), { os: "macos", specs }),
    /unknown system "macos"/
  );
});

test("judges shard reports together, with any spec in either shard", () => {
  const [first, ...rest] = allPassing();
  const shards = [
    report([first], { shard: { current: 1, total: 2 } }),
    report(rest, { shard: { current: 2, total: 2 } }),
  ];
  const { summary, problems } = judge(combine(shards), { os: "linux", specs });
  assert.deepEqual(problems, []);
  assert.equal(summary.total, 5);
  const problemsOf = (reports) =>
    judge(combine(reports), { os: "linux", specs }).problems;
  // 같은 보고서를 두 번 넘기면 shard가 겹친 것을 실행 오류로 본다.
  assert.ok(
    problemsOf([shards[1], shards[1]]).some((problem) =>
      /shard reports overlap: .*works/.test(problem)
    )
  );
  // 시험이 하나도 없는 shard도, 허용된 건너뜀만 있는 shard도 아무것도 확인하지 않았다.
  assert.ok(
    problemsOf([
      report(allPassing(), { shard: { current: 1, total: 2 } }),
      report([], { shard: { current: 2, total: 2 } }),
    ]).includes("run error: shard report 2 passed no test")
  );
  const perfOnly = allPassing().filter((t) => t.file === perf);
  assert.ok(
    problemsOf([
      report(
        allPassing().filter((t) => t.file !== perf),
        { shard: { current: 1, total: 2 } }
      ),
      report(perfOnly, { shard: { current: 2, total: 2 } }),
    ]).includes("run error: shard report 2 passed no test")
  );
  // shard 번호가 겹치거나 빠지거나 없으면 나머지 절반을 돌았는지 알 수 없다.
  for (const [name, numbers] of [
    [
      "the same shard twice",
      [
        { current: 1, total: 2 },
        { current: 1, total: 2 },
      ],
    ],
    [
      "a shard of another split",
      [
        { current: 1, total: 2 },
        { current: 2, total: 3 },
      ],
    ],
    ["a report without its shard", [{ current: 1, total: 2 }, undefined]],
  ])
    assert.ok(
      problemsOf([
        report([first], { shard: numbers[0] }),
        report(rest, { shard: numbers[1] }),
      ]).some((problem) => /shard/.test(problem)),
      name
    );
  // shard 하나만 보면 다른 shard에 있는 spec이 빠진다.
  assert.notDeepEqual(
    judge(report([first]), { os: "linux", specs }).problems,
    []
  );
});

/** 디스크의 spec마다 통과한 시험 하나를 담은 보고서. */
const everySpec = () =>
  expectedSpecs().flatMap((file) =>
    file === perf ? [skipped(perf, perfTitle, perfReason)] : [passing(file)]
  );
const script = fileURLToPath(
  new URL("./check-e2e-report.mjs", import.meta.url)
);

test("prints the counts and fails the command for a rejected or unreadable report", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-report-"));
  context.after(() => removeFolder(dir));
  const run = (data, ...args) => {
    const file = path.join(dir, "report.json");
    writeFileSync(file, data);
    return spawnSync(process.execPath, [script, ...args, file], {
      encoding: "utf8",
    });
  };
  const total = everySpec().length;
  const ok = run(JSON.stringify(report(everySpec())), "--os", "linux");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(
    ok.stdout,
    new RegExp(
      `E2E on linux: ${total} tests, ${total - 1} passed, 0 failed, 0 flaky, 1 skipped`
    )
  );
  const failed = run(
    JSON.stringify(
      report([
        ...everySpec(),
        { ...passing("home.spec.ts", "b"), status: "unexpected" },
      ])
    ),
    "--os",
    "linux"
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /failed: home\.spec\.ts/);
  assert.equal(run("not json", "--os", "linux").status, 1);
  // 어느 시스템의 실행인지 밝히지 않으면 시스템별 건너뜀을 판정할 수 없다.
  const noOs = run(JSON.stringify(report(everySpec())));
  assert.equal(noOs.status, 1);
  assert.match(noOs.stderr, /usage:/);
});

test("fails the command when one of several reports is unreadable or none is given", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-report-"));
  context.after(() => removeFolder(dir));
  const [first, ...rest] = everySpec();
  const good = path.join(dir, "good.json");
  const other = path.join(dir, "other.json");
  const bad = path.join(dir, "bad.json");
  writeFileSync(
    good,
    JSON.stringify(report([first], { shard: { current: 1, total: 2 } }))
  );
  writeFileSync(
    other,
    JSON.stringify(report(rest, { shard: { current: 2, total: 2 } }))
  );
  writeFileSync(bad, "not json");
  const run = (...args) =>
    spawnSync(process.execPath, [script, "--os", "windows", ...args], {
      encoding: "utf8",
    });
  const overlapped = run(good, good);
  assert.equal(overlapped.status, 1);
  assert.match(overlapped.stderr, /shard reports overlap/);
  const ok = run(good, other);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(
    ok.stdout,
    new RegExp(`E2E on windows: ${everySpec().length} tests`)
  );
  const failed = run(good, bad);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /cannot read E2E report/);
  const none = run();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /usage:/);
});
