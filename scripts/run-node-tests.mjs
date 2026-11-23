// node:test 묶음을 `node --test`와 같게 돌린다(파일마다 프로세스, 동시 실행 수는 CPU 수 - 1, 사람이 읽는 spec 보고).
// 묶음의 파일은 묶음 정의(scripts/test-suites.ts)에서 온다. CI가 BABOJUBOT_TEST_REPORTS에 폴더를 주면 그 폴더의 `<이름>.json`에 시험마다
// 파일·이름·상태를 남긴다. 모양은 Vitest JSON 보고서(Jest 호환)와 같아 scripts/check-test-reports.mjs가 두 실행기의 보고서를 같이
// 판정한다. node:test는 시험이 모두 건너뛰어져도 0으로 끝나므로 실행 수는 그 검사기가 본다. CI가 보고서를 필수로 했는데 폴더가
// 없거나 이미 판정한 폴더면 돌리지 않고 실패한다(reportFolder).
// 사용: node scripts/run-node-tests.mjs <묶음>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { pathToFileURL } from "node:url";
import { reportFolder, suiteNamed } from "./test-suites.ts";

/**
 * 시험 파일을 `name` 묶음으로 돌리고 보고 폴더가 있으면 보고서를 남긴다. 실패하면 process.exitCode를 1로 둔다. 묶음 정의에 없는
 * 시험 입력(scripts/fixtures)을 돌리는 시험도 이 함수를 쓴다.
 * @param {string} name
 * @param {string[]} files
 */
export function runNodeTests(name, files) {
  const folder = reportFolder(name);
  /** 파일별 시험 결과. 묶음(describe)은 세지 않는다. */
  const byFile = new Map();
  /** 파일별로 지금 열려 있는 묶음 이름(nesting 깊이 순). */
  const suites = new Map();
  const openSuites = (file) => {
    if (!suites.has(file)) suites.set(file, []);
    return suites.get(file);
  };
  /** node:test의 skip·todo 표시(이유 문자열 또는 true)가 붙었는가. */
  const marked = (flag) => flag !== undefined && flag !== false;
  const record = (data, failed) => {
    const open = openSuites(data.file);
    // 묶음은 세지 않는다. 묶음의 실패(hook 실패 등)는 안쪽 시험의 실패와 종료 코드로 드러난다.
    if (data.details?.type === "suite") {
      open.length = data.nesting;
      return;
    }
    const status = marked(data.todo)
      ? "todo"
      : failed
        ? "failed"
        : marked(data.skip)
          ? "skipped"
          : "passed";
    const results = byFile.get(data.file) ?? [];
    byFile.set(data.file, results);
    results.push({
      title: data.name,
      fullName: [...open.slice(0, data.nesting), data.name].join(" > "),
      status,
    });
  };

  // `node --test`처럼 파일마다 프로세스를 띄우고 CPU 수 - 1개를 함께 돌린다(run의 concurrency 기본값은 하나씩이다).
  const stream = run({ files, concurrency: true });
  // 묶음은 안쪽 시험이 끝난 뒤에 끝을 알리므로, 시작(test:start)에서 이름을 열어 안쪽 시험의 전체 이름에 붙인다.
  stream.on("test:start", (data) => {
    const open = openSuites(data.file);
    open.length = data.nesting;
    open.push(data.name);
  });
  stream.on("test:pass", (data) => record(data, false));
  stream.on("test:fail", (data) => {
    // `node --test`처럼 todo 시험의 실패는 실행을 실패시키지 않는다.
    if (!marked(data.todo)) process.exitCode = 1;
    record(data, true);
  });
  stream.on("end", () => {
    if (!folder) return;
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, `${name}.json`),
      JSON.stringify({
        testResults: [...byFile].map(([file, assertionResults]) => ({
          name: file,
          assertionResults,
        })),
      })
    );
  });
  stream.compose(spec).pipe(process.stdout);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || rest.length > 0) {
    console.error(
      "usage: node scripts/run-node-tests.mjs <suite> (files come from scripts/test-suites.ts)"
    );
    process.exit(1);
  }
  const suite = suiteNamed(name);
  if (suite.runner !== "node") {
    console.error(`test suite ${name} is not a node:test suite`);
    process.exit(1);
  }
  runNodeTests(name, suite.files);
}
