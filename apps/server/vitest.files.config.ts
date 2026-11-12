import { defineConfig } from "vitest/config";

// 시스템마다 다른 파일 식별을 실제로 돌려 보는 검사다. DB를 쓰지 않으므로 시험용 DB를 띄우지 않는다.
export default defineConfig({
  test: {
    include: [
      "test/workspace.test.ts",
      "test/workspace-race.test.ts",
      "test/workspace-cases.test.ts",
    ],
    testTimeout: 240_000,
    // 바꿔치기 시험은 시도마다 만든 임시 폴더 수백 개를 끝에 지운다. 느린 Windows runner에서도 끝나게 둔다.
    hookTimeout: 120_000,
  },
});
