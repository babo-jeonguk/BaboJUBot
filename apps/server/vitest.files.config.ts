import { defineConfig } from "vitest/config";

// 시스템마다 다른 파일 식별을 실제로 돌려 보는 검사다. DB를 쓰지 않으므로 시험용 DB를 띄우지 않는다.
export default defineConfig({
  test: {
    include: ["test/workspace*.test.ts"],
    testTimeout: 240_000,
  },
});
