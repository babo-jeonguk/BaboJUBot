import path from "node:path";

/**
 * CI가 job마다 BABOJUBOT_TEST_REPORTS에 폴더를 주면 Vitest가 그 폴더의 `<묶음>.json`에 JSON 보고서를 남기게 하는 보고기.
 * 시험이 모두 건너뛰어진 파일도 Vitest는 0으로 끝나므로 scripts/check-test-reports.mjs가 이 보고서로 파일마다 통과한 시험을
 * 확인한다. 폴더가 없으면(로컬) 아무것도 더하지 않는다. 각 설정은 기본 보고기 뒤에 붙인다:
 * `reporters: [...configDefaults.reporters, ...testReport("runtime")]`.
 */
export function testReport(
  name: string
): Array<["json", { outputFile: string }]> {
  const folder = process.env.BABOJUBOT_TEST_REPORTS;
  return folder
    ? [["json", { outputFile: path.join(folder, `${name}.json`) }]]
    : [];
}
