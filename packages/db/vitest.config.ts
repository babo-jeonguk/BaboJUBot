import { defineConfig } from "vitest/config";

// 파일마다 embedded Postgres를 초기화하므로 파일 간 자원 경쟁을 피한다. 테스트 내부의 동시 호출은 유지한다.
// 가장 느린 테스트가 한가할 때 ~2.5s다. 제한 시간은 부하가 큰 기기의 여유를 두되 멈춘 테스트는 이름을 남기고 끝낸다.
export default defineConfig({
  test: { hookTimeout: 120_000, testTimeout: 60_000, fileParallelism: false },
});
