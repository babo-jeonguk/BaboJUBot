// boot-check의 시한. 스크립트와 그 회귀 시험(scripts/boot-check.test.mjs)이 같은 값을 쓴다.

// 실행 전체의 시한. 지나면 멈춤을 요청한 것과 같다. CI 실측 전체 소요(macOS 약 5초, Windows 약 13초)의 9배 이상이다.
export const runTimeoutMs = 120_000;

// 멈춤 요청 뒤 끝나기까지의 시한. 멈춤은 진행 중인 단계가 끝난 뒤에 받으므로 가장 긴 한 단계를 담는다:
// 남은 Postgres 정지(10초) + Postgres 시작(60초) + 닫을 때 정지(30초)와 정리(15초)에 여유를 더했다(packages/db/src/embedded.ts).
// 이 시한이 지나면 떠 있는 서버만 끝내고, 남았을 수 있는 것을 밝혀 실패한다.
export const stopGraceMs = 150_000;
