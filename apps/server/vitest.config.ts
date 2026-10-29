import { defineConfig } from "vitest/config";

// 검사 실행 하나가 embedded Postgres 하나를 띄우고(globalSetup) 검사마다 원본 DB를 복제한다. 서버 검사는 자식 서버
// 프로세스도 띄운다. 제한 시간은 부하가 큰 기기의 여유를 두되 멈춘 테스트는 이름을 남기고 끝낸다.
export default defineConfig({
  test: {
    globalSetup: ["../../packages/db/src/test-cluster.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
