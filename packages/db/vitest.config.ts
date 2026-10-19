import { defineConfig } from "vitest/config";

// 파일마다 embedded Postgres를 초기화하므로 파일 간 자원 경쟁을 피한다. 테스트 내부의 동시 호출은 유지한다.
export default defineConfig({
  test: { hookTimeout: 60_000, fileParallelism: false },
});
