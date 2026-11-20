import { configDefaults, defineConfig } from "vitest/config";
import { testReport } from "../../vitest.reports.ts";

// 테스트 실행 하나가 embedded Postgres 하나를 띄우고(globalSetup) 테스트마다 원본 DB를 복제한다. 서버 테스트는 자식 서버
// 프로세스도 띄운다. 제한 시간은 부하가 큰 기기의 여유를 두되 멈춘 테스트는 이름을 남기고 끝낸다.
// 테스트 파일마다 임시 제품 폴더(BABOJUBOT_HOME)를 쓴다(test/product-home.ts).
export default defineConfig({
  test: {
    reporters: [...configDefaults.reporters, ...testReport("server")],
    globalSetup: ["../../packages/db/src/test-cluster.ts"],
    // Windows는 묶음 실행기 없이 프로그램을 띄우지 않는다(#262, test/launcher-setup.ts).
    setupFiles: ["./test/product-home.ts", "./test/launcher-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
