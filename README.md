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

패키지별 책임은 [전체 구조](docs/architecture.md#패키지-구성), 수정할 코드와 테스트의 위치는 [코드 지도](docs/agents/code-map.md)에서 확인합니다.

## 문서

[문서 지도](docs/README.md)에서 기능·구조·용어·개발 운영·인터뷰·조사 문서를 질문별로 찾습니다.

실제 실행 인스턴스의 파일·기억·실험 결과는 Git에서 제외하는 `.babojubot/` 아래 또는 설정된 외부 저장소에 둡니다. 최종 저장 방식은 후속 이슈에서 결정합니다.

상위 프로젝트의 구조를 참고해 독립적으로 작성합니다. 코드 재사용 시 해당 버전·파일·의존성의 라이선스를 확인합니다. BaboJUBot 자체의 배포 라이선스는 아직 선택하지 않았습니다.
