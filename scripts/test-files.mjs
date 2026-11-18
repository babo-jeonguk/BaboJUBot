// 시험 코드 범위를 eslint.config.js와 scripts/verify-changed.mjs가 함께 쓴다. 패키지의 tsconfig.test.json·tsconfig.src.json의
// include/exclude도 이 범위에 맞춘다.
// 시험 코드: 시험 파일과 시험 폴더, src 안의 시험 도움 파일. 시험 전용 규칙은 이 범위에 건다.
// 외부 프로그램을 흉내 내는 가짜 CLI(`*/test-fixtures/`)와 손으로 돌리는 스크립트(`scripts/live/` 등)는 시험 코드가 아니다.
import path from "node:path";

export const testFiles = [
  "**/*.test.{ts,tsx,mts,mjs,js}",
  "**/*.spec.{ts,tsx}",
  "apps/web/e2e/**",
  "apps/web/test/**",
  "apps/server/test/**",
  "packages/runtime/src/testing.ts",
  "packages/runtime/src/providers/{test-support,test-folders,*-support}.ts",
  "packages/db/src/{testing,test-cluster}.ts",
];

export function isTestFile(file) {
  return testFiles.some((pattern) => path.matchesGlob(file, pattern));
}
