// CI의 E2E 결과(Playwright JSON 보고서, apps/web/playwright.config.ts)를 판정하고 통과·실패·건너뜀 수를 로그에 남긴다.
// 실행기의 종료 코드만으로는 알 수 없는 것을 막는다: 테스트가 하나도 돌지 않음, 예상 밖 건너뜀, 서버 수명 시험이 빠짐.
// 사용: node scripts/check-e2e-report.mjs <report.json>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 이유를 적은 의도된 건너뜀. 파일과 Playwright의 skip 설명이 같아야 한다. */
export const allowedSkips = [
  {
    file: "research-map-perf.spec.ts",
    reason: "MAP_PERF=1일 때만 측정한다",
  },
];
/** 실제로 돌아 통과해야 하는 E2E 서버 수명 시험(격리 서버 fixture·공용 서버). */
export const requiredFiles = [
  "support/isolated-server.spec.ts",
  "support/shared-server.spec.ts",
];

/** 보고서의 모든 테스트를 `{ file, title, status, skipReasons }`로 편다. */
function collect(suites, out = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        out.push({
          file: spec.file ?? suite.file,
          title: spec.title,
          status: test.status,
          skipReasons: (test.annotations ?? [])
            .filter((a) => a.type === "skip")
            .map((a) => a.description ?? ""),
        });
    collect(suite.suites, out);
  }
  return out;
}

/** 판정한다. `problems`가 비어 있어야 성공이다. */
export function judge(report) {
  const tests = collect(report.suites);
  const count = (status) => tests.filter((t) => t.status === status).length;
  const summary = {
    total: tests.length,
    passed: count("expected"),
    failed: count("unexpected"),
    flaky: count("flaky"),
    skipped: count("skipped"),
  };
  const problems = [];
  for (const error of report.errors ?? [])
    problems.push(`run error: ${error.message ?? JSON.stringify(error)}`);
  if (tests.length === 0) problems.push("no E2E test ran");
  for (const t of tests) {
    const name = `${t.file} › ${t.title}`;
    if (t.status === "unexpected") problems.push(`failed: ${name}`);
    else if (t.status === "flaky") problems.push(`flaky: ${name}`);
    else if (t.status === "skipped") {
      const allowed = allowedSkips.some(
        (skip) =>
          t.file?.endsWith(skip.file) && t.skipReasons.includes(skip.reason)
      );
      if (!allowed)
        problems.push(
          `unexpected skip: ${name} (${t.skipReasons.join("; ") || "no reason"})`
        );
    } else if (t.status !== "expected")
      problems.push(`unknown status ${t.status}: ${name}`);
  }
  for (const file of requiredFiles) {
    const ran = tests.filter((t) =>
      t.file?.replaceAll("\\", "/").endsWith(file)
    );
    if (ran.length === 0 || ran.some((t) => t.status !== "expected"))
      problems.push(
        `required server lifecycle checks did not all pass: ${file}`
      );
  }
  const skips = tests
    .filter((t) => t.status === "skipped")
    .map((t) => `${t.file} › ${t.title}: ${t.skipReasons.join("; ")}`);
  return { summary, skips, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`cannot read E2E report ${file}: ${error.message}`);
    process.exit(1);
  }
  const { summary, skips, problems } = judge(report);
  console.log(
    `E2E: ${summary.total} tests, ${summary.passed} passed, ${summary.failed} failed, ${summary.flaky} flaky, ${summary.skipped} skipped`
  );
  for (const skip of skips) console.log(`skipped: ${skip}`);
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
