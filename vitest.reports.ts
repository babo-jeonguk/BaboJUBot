import path from "node:path";
import { reportFolder, suiteNamed } from "./scripts/test-suites.ts";

/** Vitest 기본값 중 suiteTest가 이어 쓰는 것(`configDefaults`). 이 파일은 vitest를 가져오지 않는다(뿌리는 vitest에 의존하지 않음). */
type Defaults<Reporter> = {
  exclude: readonly string[];
  reporters: readonly Reporter[];
};

/**
 * Vitest 설정 하나가 도는 시험 묶음(scripts/test-suites.ts)의 파일 고르기와 보고기. 각 설정은
 * `test: { ...suiteTest("runtime", configDefaults), … }`로 받는다. include·exclude는 묶음 정의 그대로이고(기본 exclude 뒤에 묶음의
 * exclude), 보고 폴더(BABOJUBOT_TEST_REPORTS)가 있으면 기본 보고기 뒤에 그 폴더의 `<묶음>.json` JSON 보고기를 붙인다.
 * scripts/check-test-reports.mjs가 그 보고서를 묶음 정의와 대조한다. CI가 보고서를 필수로 했는데 폴더가 없으면 설정을 읽을 때 던진다.
 */
export function suiteTest<Reporter>(
  name: string,
  defaults: Defaults<Reporter>
) {
  const suite = suiteNamed(name);
  if (suite.runner !== "vitest")
    throw new Error(`test suite ${name} is not a Vitest suite`);
  const folder = reportFolder(name);
  return {
    include: suite.include,
    exclude: [...defaults.exclude, ...(suite.exclude ?? [])],
    reporters: [
      ...defaults.reporters,
      ...(folder
        ? [
            [
              "json",
              { outputFile: path.join(folder, `${name}.json`) },
            ] satisfies ["json", { outputFile: string }],
          ]
        : []),
    ],
  };
}
