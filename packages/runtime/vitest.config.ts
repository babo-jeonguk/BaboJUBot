import { defineConfig } from "vitest/config";

// 테스트마다 가짜 프로바이더 프로세스를 띄워서, 바쁜 기기에서는 평소 1초 안쪽인 테스트도 5초를 넘긴다(부하 30에서 6.6초 측정).
// 제한 시간은 그 여유를 두되 멈춘 테스트는 이름을 남기고 끝낸다.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
