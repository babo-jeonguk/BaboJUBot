// `ci / test` 집계 job의 판정을 shell 없이 Node로 한 번만 구현한다. Windows 개발 환경은 Node·Git만 약속하므로
// workflow가 Bash를 요구하지 않게 한다. 입력 환경 변수와 판정 규칙은 기존 집계 job과 같다.
const suites = [
  ["unit", process.env.UNIT_RESULT],
  ["runtime", process.env.RUNTIME_RESULT],
  ["db", process.env.DB_RESULT],
  ["server", process.env.SERVER_RESULT],
  ["opencode", process.env.OPENCODE_RESULT],
];

// 반환값은 프로세스 종료 코드다. 빠진 값은 빈 문자열처럼 다뤄 모두 거부한다.
function decide() {
  const changes = process.env.CHANGES_RESULT;
  if (changes !== "success") {
    console.error(`changes job did not succeed: ${changes ?? ""}`);
    return 1;
  }
  const code = process.env.CODE;
  let expected;
  if (code === "false") {
    expected = "skipped";
  } else if (code === "true") {
    expected = "success";
  } else {
    console.error(`unknown changes output: '${code ?? ""}'`);
    return 1;
  }
  for (const [name, result] of suites) {
    if (result !== expected) {
      console.error(
        `test-${name} did not finish as ${expected}: '${result ?? ""}'`
      );
      return 1;
    }
  }
  if (expected === "skipped") {
    console.log("Markdown-only change; tests skipped.");
  } else {
    console.log("All test suites passed.");
  }
  return 0;
}

process.exitCode = decide();
