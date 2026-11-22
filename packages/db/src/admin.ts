// 개발 도구(사고 재현·실제 모델 시험 스크립트)가 DB를 직접 들여다보고 고치는 입구. 연결 하나 열기와 그 도구가 쓰는 표 정의만
// 연다. 제품 코드는 이 입구를 가져오지 않는다(eslint.config.js의 package-import-scope). 제품 동작은 db 패키지 입구의 함수로 한다.
export { withClient } from "./client.ts";
export { agentSessions } from "./schema.ts";
