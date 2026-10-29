# 개발 환경

| 작업 | 진입점·검증 |
| --- | --- |
| 서버 시작/종료·embedded/외부 DB·정적 웹 | [server/main.ts](../../../apps/server/src/main.ts), server/app.ts, [db/client.ts](../../../packages/db/src/client.ts); [외부 DB 시작/종료 테스트](../../../apps/server/test/main.test.ts)·DB 테스트·관련 실행 확인 |
| 임시 Postgres 수명·테스트 환경 | [db/testing.ts](../../../packages/db/src/testing.ts), db/client.ts, [서버 지원](../../../apps/server/test/support.ts); DB·서버 테스트, 브라우저 서버는 [Playwright 설정](../../../apps/web/playwright.config.ts) |
| 실행·빌드·CI·hook | [루트 scripts](../../../package.json)·workspace package.json, [CI](../../../.github/workflows/scaffold.yml), [pre-commit](../../../.husky/pre-commit); [명령](../../../README.md#개발-시작), [링크 검사](../../../scripts/check-project.mjs) |
