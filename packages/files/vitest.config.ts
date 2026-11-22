import { configDefaults, defineConfig } from "vitest/config";
import { testReport } from "../../vitest.reports.ts";

// 믿을 수 없는 자리의 파일을 실제 파일 시스템에서 연다. 링크·FIFO·바꿔치기를 시스템마다 실제로 만든다.
export default defineConfig({
  test: {
    reporters: [...configDefaults.reporters, ...testReport("files")],
  },
});
