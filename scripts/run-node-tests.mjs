// node:test 묶음을 `node --test`와 같게 돌린다(파일마다 프로세스, 동시 실행 수는 CPU 수 - 1, 사람이 읽는 spec 보고).
// CI가 BABOJUBOT_TEST_REPORTS에 폴더를 주면 그 폴더의 `<이름>.json`에 시험마다 파일·이름·상태를 남긴다. 모양은 Vitest JSON
// 보고서(Jest 호환)와 같아 scripts/check-test-reports.mjs가 두 실행기의 보고서를 같이 판정한다. node:test는 시험이 모두
// 건너뛰어져도 0으로 끝나므로 실행 수는 그 검사기가 본다.
// 사용: node scripts/run-node-tests.mjs <이름> <시험 파일> [<시험 파일> ...]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const [name, ...files] = process.argv.slice(2);
if (!name || !/^[\w-]+$/.test(name) || files.length === 0) {
  console.error(
    "usage: node scripts/run-node-tests.mjs <name> <test file> [<test file> ...]"
  );
  process.exit(1);
}
const folder = process.env.BABOJUBOT_TEST_REPORTS;

/** 파일별 시험 결과. 묶음(describe)은 세지 않는다. */
const byFile = new Map();
/** 파일별로 지금 열려 있는 묶음 이름(nesting 깊이 순). */
const suites = new Map();
const record = (data, failed) => {
  const open = suites.get(data.file) ?? [];
  suites.set(data.file, open);
  if (data.details?.type === "suite") {
    open.length = data.nesting;
    return;
  }
  const marked = (flag) => flag !== undefined && flag !== false;
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
  const open = suites.get(data.file) ?? [];
  suites.set(data.file, open);
  open.length = data.nesting;
  open.push(data.name);
});
stream.on("test:pass", (data) => record(data, false));
stream.on("test:fail", (data) => {
  // `node --test`처럼 todo 시험의 실패는 실행을 실패시키지 않는다.
  if (!(data.todo !== undefined && data.todo !== false)) process.exitCode = 1;
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
