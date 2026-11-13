import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, requiredFiles } from "./check-e2e-report.mjs";

// Playwright JSON 보고서의 모양(파일별 suite → specs → tests)을 줄여 만든다.
const passing = (file, title = "works") => ({
  file,
  title,
  status: "expected",
});
function report(tests, errors = []) {
  const byFile = new Map();
  for (const t of tests) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push({
      title: t.title,
      file: t.file,
      tests: [
        {
          status: t.status,
          annotations: (t.skip ?? []).map((description) => ({
            type: "skip",
            description,
          })),
        },
      ],
    });
  }
  return {
    suites: [...byFile].map(([file, specs]) => ({
      title: file,
      file,
      specs,
      suites: [],
    })),
    errors,
  };
}
const required = requiredFiles.map((file) => passing(file));

test("accepts a run where every test passed and the server lifecycle checks ran", () => {
  const { summary, problems } = judge(
    report([...required, passing("home.spec.ts")])
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(summary, {
    total: 4,
    passed: 4,
    failed: 0,
    flaky: 0,
    skipped: 0,
  });
});

test("accepts the performance measurement skipped for its stated reason", () => {
  const { summary, problems } = judge(
    report([
      ...required,
      {
        file: "research-map-perf.spec.ts",
        title: "perf",
        status: "skipped",
        skip: ["MAP_PERF=1일 때만 측정한다"],
      },
    ])
  );
  assert.deepEqual(problems, []);
  assert.equal(summary.skipped, 1);
});

for (const [name, tests, errors] of [
  [
    "a failed test",
    [...required, { ...passing("a.spec.ts"), status: "unexpected" }],
  ],
  ["a flaky test", [...required, { ...passing("a.spec.ts"), status: "flaky" }]],
  [
    "a skip without the stated reason",
    [
      ...required,
      { ...passing("a.spec.ts"), status: "skipped", skip: ["later"] },
    ],
  ],
  [
    "the performance file skipped for another reason",
    [
      ...required,
      {
        ...passing("research-map-perf.spec.ts"),
        status: "skipped",
        skip: ["flaky"],
      },
    ],
  ],
  ["no test at all", []],
  ...requiredFiles.flatMap((file) => {
    const others = required.filter((t) => t.file !== file);
    return [
      [`a missing ${file}`, others],
      [
        `a skipped ${file}`,
        [
          ...others,
          {
            ...passing(file),
            status: "skipped",
            skip: ["MAP_PERF=1일 때만 측정한다"],
          },
        ],
      ],
    ];
  }),
  [
    "a run error such as a failed teardown",
    required,
    [{ message: "공용 E2E 서버가 정리에 실패했다" }],
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.notDeepEqual(judge(report(tests, errors)).problems, []);
  });
}

test("prints the counts and fails the command for a rejected or unreadable report", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-report-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(
    new URL("./check-e2e-report.mjs", import.meta.url)
  );
  const run = (data) => {
    const file = path.join(dir, "report.json");
    writeFileSync(file, data);
    return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  };
  const ok = run(JSON.stringify(report(required)));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(
    ok.stdout,
    /E2E: 3 tests, 3 passed, 0 failed, 0 flaky, 0 skipped/
  );
  const failed = run(
    JSON.stringify(
      report([...required, { ...passing("a.spec.ts"), status: "unexpected" }])
    )
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /failed: a\.spec\.ts/);
  assert.equal(run("not json").status, 1);
});
