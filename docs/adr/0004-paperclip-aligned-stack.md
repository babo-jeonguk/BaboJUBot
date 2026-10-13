# Paperclip과 같은 TypeScript·Postgres 스택

BaboJUBot은 Node 24, pnpm workspace의 TypeScript 모노레포로 만들고, 서버는 Express와 `ws`, DB는 Postgres와 Drizzle, 웹은 React·Vite·Tailwind·Radix/shadcn·TanStack Query, 경계 스키마는 zod, 테스트는 Vitest와 Playwright를 쓴다. Paperclip(MIT)과 같은 스택이다. 대시보드와 control plane 기능 상당수를 Paperclip에서 옮겨 올 계획이라, 스택을 맞추면 route·realtime·스키마·화면 코드를 거의 그대로 가져올 수 있다. self-host 단일 사용자라 SQLite도 후보였지만 Paperclip 스키마와 동시성 제어(checkout, 깨우기 queue)를 그대로 쓰려고 Postgres를 골랐다.

## Consequences

- 개발과 테스트는 embedded-postgres로 Docker 없이 돌리고, self-host 운영은 외부 Postgres URL을 받는다.
- 깨우기 queue와 외부 job 상태도 Postgres에 둔다. Redis 같은 추가 인프라는 두지 않는다.
- 복사한 코드는 파일 머리에 출처 저장소·SHA·경로를 남기고 `THIRD_PARTY_NOTICES.md`에 라이선스 고지를 모은다.
