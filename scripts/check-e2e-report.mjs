// CI의 E2E 결과(Playwright JSON 보고서, apps/web/playwright.config.ts)를 판정하고 통과·실패·건너뜀 수를 로그에 남긴다.
// 실행기의 종료 코드만으로는 알 수 없는 것을 막는다: 테스트가 하나도 돌지 않음, 예상 밖 건너뜀, 실패 예정(test.fail)으로 감춘
// 실패, E2E 폴더의 spec이 통째로 빠짐.
// 여러 보고서(Windows의 shard별 보고서)를 주면 shard마다 통과한 시험이 있는지 보고 합쳐서 한 실행으로 판정한다.
// 사용: node scripts/check-e2e-report.mjs --os <linux|windows> <report.json> [<report.json> ...]
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 판정할 수 있는 실행 시스템. CI는 Linux job과 Windows shard job에서 E2E를 돈다. */
const systems = ["linux", "windows"];

/**
 * 이유를 적은 의도된 건너뜀. 시스템·spec 경로(E2E 폴더 기준, `/`)·시험 이름·Playwright의 skip 설명이 모두 같아야 한다.
 * 같은 파일의 다른 시험이나 다른 시스템의 실행은 이 허용을 받지 않는다.
 */
export const allowedSkips = [
  {
    systems,
    file: "research-map-perf.spec.ts",
    title:
      "research map performance across node counts, secondary link ratios and widths",
    reason: "MAP_PERF=1일 때만 측정한다",
  },
  {
    systems: ["windows"],
    file: "support/server-process.spec.ts",
    title:
      "a server that ends before it is ready and whose folder cannot be removed reports both failures",
    reason: "Windows에서는 폴더 권한으로 삭제를 막을 수 없다",
  },
];

const e2eFolder = fileURLToPath(new URL("../apps/web/e2e/", import.meta.url));

/** 실행해야 하는 spec(playwright.config.ts의 testDir `e2e`, Playwright 기본 testMatch의 `*.spec.ts`). */
export function expectedSpecs() {
  return globSync("**/*.spec.ts", { cwd: e2eFolder })
    .map((file) => file.replaceAll("\\", "/"))
    .sort();
}

/** 보고서의 파일 경로(testDir 기준, Windows는 `\\`일 수 있음)를 `/`로 맞춘다. */
const normalized = (file) => (file ?? "").replaceAll("\\", "/");

/** 이 시스템에서 허용 목록의 이유로 건너뛴 시험인가. */
const allowedSkip = (t, os) =>
  t.status === "skipped" &&
  t.expectedStatus === "skipped" &&
  allowedSkips.some(
    (skip) =>
      skip.systems.includes(os) &&
      t.file === skip.file &&
      t.title === skip.title &&
      t.skipReasons.includes(skip.reason)
  );

/** 기대한 대로 돌아 통과한 시험인가. 실패 예정 시험은 실패해도 결과 상태가 expected라서 기대 상태와 주석을 함께 본다. */
const passed = (t) =>
  t.status === "expected" &&
  t.expectedStatus === "passed" &&
  !t.annotationTypes.includes("fail");

/** 보고서의 모든 테스트를 `{ file, title, status, expectedStatus, annotationTypes, skipReasons }`로 편다. */
function collect(suites, out = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const annotations = test.annotations ?? [];
        out.push({
          file: normalized(spec.file ?? suite.file),
          title: spec.title,
          status: test.status,
          expectedStatus: test.expectedStatus,
          annotationTypes: annotations.map((a) => a.type),
          skipReasons: annotations
            .filter((a) => a.type === "skip")
            .map((a) => a.description ?? ""),
        });
      }
    collect(suite.suites, out);
  }
  return out;
}

/** 보고서의 spec마다 위치·제목 열쇠를 모은다. */
function specKeys(suites, out = new Set()) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? [])
      out.add(
        `${normalized(spec.file ?? suite.file)}:${spec.line}:${spec.column} › ${spec.title}`
      );
    specKeys(suite.suites, out);
  }
  return out;
}

/** 시험 하나가 통과도 허용된 건너뜀도 아니면 그 이유. */
function problemOf(t, os) {
  const name = `${t.file} › ${t.title}`;
  if (t.status === "unexpected") return `failed: ${name}`;
  if (t.status === "flaky") return `flaky: ${name}`;
  if (t.status === "skipped")
    return allowedSkip(t, os)
      ? undefined
      : `unexpected skip on ${os}: ${name} (${t.skipReasons.join("; ") || "no reason"})`;
  if (t.status !== "expected") return `unknown status ${t.status}: ${name}`;
  if (t.expectedStatus !== "passed" || t.annotationTypes.includes("fail"))
    return `expected status "${t.expectedStatus}"${t.annotationTypes.includes("fail") ? " (test.fail)" : ""} instead of "passed": ${name}`;
  return undefined;
}

/**
 * 판정한다. `problems`가 비어 있어야 성공이다. `os`는 보고서를 만든 시스템, `specs`는 실행해야 하는 spec 목록이다.
 * 예상 spec마다 통과한 시험이 하나는 있어야 한다. 그 spec의 모든 시험이 이 시스템에서 허용된 건너뜀이면(성능 측정) 예외다.
 */
export function judge(report, { os, specs }) {
  if (!systems.includes(os))
    throw new Error(`unknown system "${os}" (one of ${systems.join(", ")})`);
  const tests = collect(report.suites);
  const count = (status) => tests.filter((t) => t.status === status).length;
  const summary = {
    total: tests.length,
    passed: tests.filter(passed).length,
    failed: count("unexpected"),
    flaky: count("flaky"),
    skipped: count("skipped"),
  };
  const problems = [];
  for (const error of report.errors ?? [])
    problems.push(`run error: ${error.message ?? JSON.stringify(error)}`);
  if (tests.length === 0) problems.push("no E2E test ran");
  for (const t of tests) {
    const problem = problemOf(t, os);
    if (problem) problems.push(problem);
  }
  for (const spec of specs) {
    const own = tests.filter((t) => t.file === spec);
    const onlyAllowedSkips =
      own.length > 0 && own.every((t) => allowedSkip(t, os));
    if (!onlyAllowedSkips && !own.some(passed))
      problems.push(
        own.length === 0
          ? `expected spec did not run: ${spec}`
          : `expected spec passed no test: ${spec}`
      );
  }
  for (const file of new Set(tests.map((t) => t.file)))
    if (!specs.includes(file))
      problems.push(`spec outside the E2E folder's specs: ${file}`);
  const skips = tests
    .filter((t) => t.status === "skipped")
    .map((t) => `${t.file} › ${t.title}: ${t.skipReasons.join("; ")}`);
  return { summary, skips, problems };
}

/**
 * 여러 보고서(shard별)를 한 보고서로 합친다. 합친 보고서에 shard 번호가 한 분할의 서로 다른 번호가 아닌 것, shard끼리 겹친
 * spec, 통과한 시험이 없는 shard를 실행 오류로 덧붙인다(같은 보고서를 두 번 넘기거나 두 job이 같은 절반을 돌면 나머지 절반이
 * 빠지고, 허용된 건너뜀만 있는 shard는 아무것도 확인하지 않았다). spec은 어느 shard에 있어도 된다.
 */
export function combine(reports) {
  const errors = reports.flatMap((report) => report.errors ?? []);
  if (reports.length > 1) {
    const shards = reports.map((report) => report.config?.shard);
    const numbers = new Set(shards.map((shard) => shard?.current));
    if (
      shards.some((shard) => shard?.total !== reports.length) ||
      numbers.size !== reports.length ||
      [...numbers].some((n) => !(n >= 1 && n <= reports.length))
    )
      errors.push({
        message: `shard reports are not shards 1-${reports.length} of one split: ${JSON.stringify(shards)}`,
      });
    reports.forEach((report, index) => {
      if (!collect(report.suites).some(passed))
        errors.push({ message: `shard report ${index + 1} passed no test` });
    });
    const seen = new Set();
    const duplicated = new Set();
    for (const report of reports)
      for (const key of specKeys(report.suites))
        if (seen.has(key)) duplicated.add(key);
        else seen.add(key);
    for (const key of duplicated)
      errors.push({ message: `shard reports overlap: ${key}` });
  }
  return {
    suites: reports.flatMap((report) => report.suites ?? []),
    errors,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [flag, os, ...files] = process.argv.slice(2);
  if (flag !== "--os" || !systems.includes(os) || files.length === 0) {
    console.error(
      `usage: node scripts/check-e2e-report.mjs --os <${systems.join("|")}> <report.json> [<report.json> ...]`
    );
    process.exit(1);
  }
  const reports = [];
  for (const file of files) {
    try {
      reports.push(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      console.error(`cannot read E2E report ${file}: ${error.message}`);
      process.exit(1);
    }
  }
  const { summary, skips, problems } = judge(combine(reports), {
    os,
    specs: expectedSpecs(),
  });
  console.log(
    `E2E on ${os}: ${summary.total} tests, ${summary.passed} passed, ${summary.failed} failed, ${summary.flaky} flaky, ${summary.skipped} skipped`
  );
  for (const skip of skips) console.log(`skipped: ${skip}`);
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
