import { configDefaults, defineConfig } from "vitest/config";
import { testReport } from "../../vitest.reports.ts";

// 시스템 전체에 보이는 프로그램(환경을 읽을 수 없게 막은 프로그램 등)을 띄우는 시험. 같은 시각에 도는 다른 시험의 실행 시도가
// 그 프로그램을 자기 것일 수 있다고 보므로(#219), 나머지 시험이 끝난 뒤 파일 하나씩 차례로 돈다.
export default defineConfig({
  test: {
    reporters: [...configDefaults.reporters, ...testReport("runtime-alone")],
    // Windows는 묶음 실행기 없이 프로그램을 띄우지 않는다(#262). 시험 파일마다 준비한다.
    setupFiles: ["@babojubot/process/launcher-setup"],
    include: ["src/**/*.alone.test.ts"],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
