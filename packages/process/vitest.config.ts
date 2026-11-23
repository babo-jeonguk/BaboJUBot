import { configDefaults, defineConfig } from "vitest/config";
import { suiteTest } from "../../vitest.reports.ts";

// 시험마다 실제 프로그램을 띄우고 끈다. 바쁜 기기에서도 멈춘 시험만 이름을 남기고 끝나도록 runtime과 같은 제한 시간을 둔다.
// `*.alone.test.*`는 다른 시험과 겹치면 안 되는 시험이라 따로 돈다(vitest.alone.config.ts). 파일 고르기는 묶음 정의(scripts/test-suites.ts)다.
export default defineConfig({
  test: {
    ...suiteTest("process", configDefaults),
    // 세 OS 모두 감독 실행기 없이 프로그램을 띄우지 않는다(#268). 시험 파일마다 준비한다.
    setupFiles: ["src/launcher-setup-support.ts"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
