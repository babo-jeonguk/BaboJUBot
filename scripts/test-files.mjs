// 시험 코드 범위를 eslint.config.js와 scripts/verify-changed.mjs가 함께 쓴다. 패키지의 tsconfig.test.json·tsconfig.src.json의
// include/exclude는 JSON이라 이 파일을 가져올 수 없어, 형식 글자 없이(`*.test.*`) 같은 범위로 적고 scripts/lint-scope.test.mjs가 맞는지 본다.
// 시험 코드: 시험 파일과 시험 러너 설정, 시험 폴더, src 안의 시험 도움 파일(프로바이더 계약 공통 검사 `runtime-contract.ts` 포함). 시험 전용 규칙은 이 범위에 건다.
// 외부 프로그램을 흉내 내는 가짜 CLI(`*/test-fixtures/`)와 손으로 돌리는 스크립트(`scripts/live/` 등)는 시험 코드가 아니다.
import path from "node:path";

// 코드 파일 형식. vitest 기본 include(`**/*.{test,spec}.?(c|m)[jt]s?(x)`)와 Playwright 기본 testMatch가 모으는 형식과 같다. 시험
// 범위·타입 정보·화면 규칙·스크립트와 제품 규칙, 검사 스크립트와 러너 설정이 모두 이 목록에서 만들어 써서, 확장자만 바꿔 규칙·검사를
// 피하지 못한다(#270). 손으로 적은 형식 목록·형식 glob은 scripts/lint-scope.test.mjs가 짚는다.
export const codeFormats = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
/** codeFormats의 형식 이름들. 형식마다 다르게 다루는 곳(파서 종류 등)은 이 목록에서 만든다. */
export const codeFormatNames = codeFormats.slice(1, -1).split(",");
/** 정규식에 넣는 형식 이름 하나(앞의 `\.`은 쓰는 곳이 붙인다). */
export const codeFormatPattern = `(?:${codeFormatNames.join("|")})`;

export const testFiles = [
  `**/*.{test,spec}.${codeFormats}`,
  // 시험 러너 설정(전역 준비·보고·시한을 정한다).
  `**/{vitest,playwright}{,.*}.config.${codeFormats}`,
  "apps/web/e2e/**",
  "apps/web/test/**",
  "apps/server/test/**",
  `packages/runtime/src/{testing,runtime-contract}.${codeFormats}`,
  `packages/runtime/src/providers/{test-folders,*-support}.${codeFormats}`,
  `packages/process/src/{testing,test-cleanup,test-folders,*-support}.${codeFormats}`,
  `packages/db/src/{testing,test-cluster}.${codeFormats}`,
];

export function isTestFile(file) {
  return testFiles.some((pattern) => path.matchesGlob(file, pattern));
}
