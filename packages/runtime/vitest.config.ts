import { configDefaults, defineConfig } from "vitest/config";
import { codeFormats } from "../../scripts/test-files.mjs";
import { testReport } from "../../vitest.reports.ts";

// 테스트마다 가짜 프로바이더 프로세스를 띄워서, 바쁜 기기에서는 평소 1초 안쪽인 테스트도 5초를 넘긴다(부하 30에서 6.6초 측정).
// 제한 시간은 그 여유를 두되 멈춘 테스트는 이름을 남기고 끝낸다.
// `*.alone.test.*`는 다른 시험과 겹치면 안 되는 시험이라 따로 돈다(vitest.alone.config.ts).
export default defineConfig({
  test: {
    reporters: [...configDefaults.reporters, ...testReport("runtime")],
    // Windows는 묶음 실행기 없이 프로그램을 띄우지 않는다(#262). 시험 파일마다 준비한다.
    setupFiles: ["@babojubot/process/launcher-setup"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    exclude: [...configDefaults.exclude, `**/*.alone.test.${codeFormats}`],
  },
});
