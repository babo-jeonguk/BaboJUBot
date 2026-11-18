// `ci / test` 집계 job의 판정을 shell 없이 Node로 한 번만 구현한다. Windows 개발 환경은 Node·Git만 약속하므로
// workflow가 Bash를 요구하지 않게 한다. 입력 환경 변수와 판정 규칙은 기존 집계 job과 같다.
// 실패하면 job마다 실패 이유(시험 실패·실행 컴퓨터 미배정·취소·알 수 없음)를 로그와 job summary에 표로 남긴다(#218).
// 분류는 설명일 뿐이다. 통과·실패는 아래 decide()만 정하고, 분류 조회가 실패해도 바뀌지 않는다.
import { appendFileSync } from "node:fs";
import {
  classifyFailures,
  renderReport,
  unknownRows,
} from "./ci-job-failures.mjs";

// [job 이름(GitHub가 보여 주는 name), 결과 환경 변수]. 이름은 workflow와 같아야 한다(scripts/ci-test-gate.test.mjs).
const suites = [
  ["tests / unit", process.env.UNIT_RESULT],
  ["tests / runtime", process.env.RUNTIME_RESULT],
  ["tests / db", process.env.DB_RESULT],
  ["tests / server", process.env.SERVER_RESULT],
  ["tests / opencode", process.env.OPENCODE_RESULT],
  ["runtime on macos-latest", process.env.MACOS_RESULT],
  ["runtime on windows-latest", process.env.WINDOWS_RESULT],
  ["e2e on windows-latest (1/2)", process.env.E2E_WINDOWS_1_RESULT],
  ["e2e on windows-latest (2/2)", process.env.E2E_WINDOWS_2_RESULT],
  ["e2e on windows-latest", process.env.E2E_WINDOWS_RESULT],
];
// 파일 시스템별 전체 검증. 파일 읽기 경계에 닿는 변경(changes의 files 출력)에서만 돌고, 그때는 셋 모두 성공해야 한다.
const fileSuites = [
  ["files / linux", process.env.FILES_LINUX_RESULT],
  ["files / windows", process.env.FILES_WINDOWS_RESULT],
  ["files / macos", process.env.FILES_MACOS_RESULT],
];

// 기대와 다른 job을 모두 모은다. job이 아닌 이유(알 수 없는 changes 출력)는 notes에 남는다.
// ok는 예전 판정(첫 불일치에서 실패)과 같다. 빠진 값은 빈 문자열처럼 다뤄 모두 거부한다.
function decide() {
  const failures = [];
  const notes = [];
  const verdict = (ok) => ({ ok, failures, notes });
  const changes = process.env.CHANGES_RESULT;
  if (changes !== "success") {
    failures.push({
      name: "changes",
      result: changes ?? "",
      expected: "success",
    });
    return verdict(false);
  }
  const code = process.env.CODE;
  let expected;
  if (code === "false") {
    expected = "skipped";
  } else if (code === "true") {
    expected = "success";
  } else {
    notes.push(`unknown changes output: '${code ?? ""}'`);
    return verdict(false);
  }
  const mismatched = (list, want) =>
    list
      .filter(([, result]) => result !== want)
      .map(([name, result]) => ({
        name,
        result: result ?? "",
        expected: want,
      }));
  failures.push(...mismatched(suites, expected));
  const files = process.env.FILES;
  if (
    (files !== "true" && files !== "false") ||
    (code === "false" && files === "true")
  ) {
    notes.push(`unknown files output: '${files ?? ""}' (code '${code}')`);
    return verdict(false);
  }
  failures.push(
    ...mismatched(fileSuites, files === "true" ? "success" : "skipped")
  );
  if (failures.length > 0) return verdict(false);
  if (expected === "skipped") {
    console.log("Markdown-only change; tests skipped.");
  } else {
    console.log(
      files === "true"
        ? "All test suites and file-system verifications passed."
        : "All test suites passed; file-system verification not affected."
    );
  }
  return verdict(true);
}

const { ok, failures, notes } = decide();
for (const each of failures)
  console.error(
    `${each.name} did not finish as ${each.expected}: '${each.result}'`
  );
for (const note of notes) console.error(note);
// 분류 조회는 실패한 경우에만 하고, 어떤 오류도 판정을 바꾸지 않는다.
let report;
try {
  const rows = await classifyFailures(failures, {
    apiUrl: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    token: process.env.GITHUB_TOKEN,
  });
  report = renderReport(rows, notes);
} catch (error) {
  report = renderReport(
    unknownRows(
      failures,
      `분류 실패: ${error instanceof Error ? error.message : error}`
    ),
    notes
  );
}
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  } catch (error) {
    console.error(`job summary not written: ${error}`);
  }
}
process.exitCode = ok ? 0 : 1;
