# BaboJUBot

연구 목표마다 독립적인 AI 조직을 구성하고, Research Lead와 작업자들이 협력하는 범용 연구 운영 프로젝트입니다. 초기 계획·팀 승인, 진행 관찰, 사용자 개입, 조직별 기억, 사용자 최종 검토를 지원하는 방향으로 개발합니다.

현재 상태는 **판 1 walking skeleton**입니다. 대시보드에서 연구 조직을 만들면 전용 Research Lead가 함께 생기고 `목표 설정` 단계로 시작하며, Event stream으로 사이드바와 홈에 바로 나타납니다. Lead 대화·실행 시도·실제 agent 실행은 아직 없습니다. 구조는 [전체 구조](docs/architecture.md)를 따릅니다.

## 개발 시작

Node.js 24.x, pnpm 10.33.0 및 Git을 사용합니다. GitHub 이슈 작업에는 인증된 `gh`가 필요합니다.

```bash
pnpm install
pnpm dev          # 서버(http://127.0.0.1:3100)와 대시보드(http://127.0.0.1:5173)
pnpm test         # 패키지별 Vitest. 서버·DB 테스트는 임시 embedded Postgres를 띄웁니다.
pnpm test:e2e     # Playwright smoke. 처음 한 번 `pnpm --filter @babojubot/web exec playwright install chromium`
pnpm typecheck
pnpm lint
pnpm check        # Markdown 로컬 링크 검사
```

`pnpm install`은 `@embedded-postgres/linux-x64`의 postinstall만 실행합니다(`pnpm-workspace.yaml`의 `onlyBuiltDependencies`). 이 script가 Postgres native library의 symlink를 만들기 때문에 `--ignore-scripts`로 설치하면 embedded Postgres가 뜨지 않습니다. 다른 OS·아키텍처에서는 해당 `@embedded-postgres/*` 패키지를 같은 목록에 추가합니다.

데이터베이스는 `DATABASE_URL`이 있으면 그 외부 Postgres에 연결만 하고, 없으면 embedded Postgres를 `.babojubot/postgres`(`BABOJUBOT_HOME`으로 변경)에 띄웁니다. 둘 다 시작할 때 같은 migration을 적용합니다. 운영은 `pnpm build` 후 `DATABASE_URL=… pnpm start`로 서버가 빌드한 대시보드까지 제공합니다. 그 밖의 설정(`PORT`, `HOST`, `EMBEDDED_POSTGRES_PORT`)은 [`apps/server/src/main.ts`](apps/server/src/main.ts) 머리에 있습니다. 스택은 [ADR-0004](docs/adr/0004-paperclip-aligned-stack.md)를 따릅니다.

| 위치 | 담는 것 |
|---|---|
| `packages/contracts` | seam별 zod 스키마: 조직 생성 제어 명령, 조직·에이전트, Event와 Event stream frame |
| `packages/core` | 도메인 규칙. 새 조직은 `목표 설정`에서 시작하고 전용 Research Lead 하나를 가집니다. |
| `packages/db` | Drizzle 스키마·migration, embedded/외부 Postgres 연결, 조직·Lead·Event 원자 저장 |
| `packages/runtime` | 실행기·job runner·채널 adapter 자리(#53부터) |
| `apps/server` | HTTP API와 Event stream(`/api/events`, 전체 또는 `?organizationId=`로 조직 구독) |
| `apps/web` | 대시보드(배치 C) |
| `harness/` | Role·Soul·Skill·연구 흐름 템플릿 자리 |

## 문서

- [기능 범위](docs/features.md)
- [전체 구조](docs/architecture.md)와 [ADR](docs/adr/)
- [인터뷰 기록](docs/project-intent.md)
- [공통 용어](GLOSSARY.md)
- [6개 참고 프로젝트 코드 구조](docs/research/reference-code-structure.md)
- [23개 비교 대상](docs/research/comparative-survey.md)

실제 실행 인스턴스의 파일·기억·실험 결과는 Git에서 제외하는 `.babojubot/` 아래 또는 설정된 외부 저장소에 둡니다. 최종 저장 방식은 후속 이슈에서 결정합니다.

상위 프로젝트의 구조를 참고해 독립적으로 작성합니다. 코드 재사용 시 해당 버전·파일·의존성의 라이선스를 확인합니다. BaboJUBot 자체의 배포 라이선스는 아직 선택하지 않았습니다.
