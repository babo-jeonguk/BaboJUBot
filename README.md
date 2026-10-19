# BaboJUBot

연구 목표마다 독립적인 AI 조직을 구성하고, Research Lead와 작업자들이 협력하는 범용 연구 운영 프로젝트입니다. 초기 계획·팀 승인, 진행 관찰, 사용자 개입, 조직별 기억, 사용자 최종 검토를 지원하는 방향으로 개발합니다.

현재 상태는 **판 1 walking skeleton**입니다. 대시보드에서 연구 조직을 만들면 전용 Research Lead가 함께 생기고 `목표 설정` 단계로 시작하며, Event stream으로 사이드바와 홈에 바로 나타납니다. Lead 대화에 메시지를 보내면 Lead가 깨어나 실행 시도를 받고, 모델을 부르지 않는 가짜 실행기가 실행 시도별 토큰으로 조직 도구를 호출해 답장합니다. 활동·실행 시도 상세·에이전트 상세에서 그 실행 시도를 볼 수 있습니다. 실제 실행기 adapter와 실제 모델 호출은 아직 없습니다.

Lead 대화에 `목표: …`와 `완료 기준: …` 줄을 보내면 가짜 Lead가 목표를 기록해 조직을 `계획 수립`으로 넘기고, 초기 연구 계획·팀 구성·연구 환경 명세·연구 흐름 템플릿을 하나의 초기 연구 승인 요청으로 올립니다. 사용자는 Inbox에서 승인 요청 상세를 열어 승인·반려·수정 요청을 합니다. 승인하면 조직이 `연구 진행`이 되고 제안한 작업자들이 생기며, 반려·수정 요청은 `계획 수립`으로 돌아가 사유와 함께 Lead를 깨웁니다. 승인 전에는 작업 생성·작업자 추가 도구를 제품이 거부하고 Event log에 남깁니다. 각 에이전트는 [하네스 라이브러리](harness/README.md)에서 복사한 자기 Role·Soul·Skill 사본을 갖고(Lead는 조직 생성 때, 작업자는 승인 때), 에이전트 상세에서 읽기 전용으로 볼 수 있습니다. 작업 생성과 작업자 실행 시도는 아직 없습니다(#55).

#54 전에 만든 개발 DB의 조직은 Lead 사본이 없어 지침 bundle 버전 없이 실행됩니다. 사본이 필요하면 `.babojubot/postgres`를 지우고 새로 만듭니다. 구조는 [전체 구조](docs/architecture.md)를 따릅니다.

실행 시도 admission·종료 저장의 DB 오류는 100ms부터 최대 5초 간격의 backoff로 서버 종료까지 재시도합니다. 종료 결과 저장이 실패하면 같은 결과를 보관해 다시 저장하며 실행기를 다시 호출하지 않습니다. 서버 종료는 backoff 대기를 취소합니다. 종료까지 DB 장애가 이어지거나 프로세스가 죽으면 메모리의 종료 결과는 보존되지 않으며, 다음 시작 때 남은 실행 시도를 실패로 끝냅니다. 입력 재처리는 후속 #60 범위입니다.

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

[CI](.github/workflows/scaffold.yml)는 `main` 대상 PR의 생성·갱신·재개와 `main` push에서 문서 검사·타입·lint·테스트·빌드·E2E를 모두 실행합니다.
기능 브랜치 push만으로는 중복 실행하지 않고, 같은 PR의 오래된 실행은 취소합니다.
`main`의 필수 검사는 workflow의 `ci / …` job 전체이며, 실행 환경과 검사 이름은 workflow를 기준으로 합니다.
표준 GitHub-hosted runner를 쓰는 공개 저장소의 실행 시간은 무료입니다([GitHub 과금 문서](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
실패한 E2E의 trace 등 결과물만 3일 보관하며 artifact·cache 저장 공간 한도는 별도로 관리합니다.

데이터베이스는 `DATABASE_URL`이 있으면 그 외부 Postgres에 연결만 하고, 없으면 embedded Postgres를 `.babojubot/postgres`(`BABOJUBOT_HOME`으로 변경)에 띄웁니다. 둘 다 시작할 때 같은 migration을 적용합니다. 운영은 `pnpm build` 후 `DATABASE_URL=… pnpm start`로 서버가 빌드한 대시보드까지 제공합니다. 그 밖의 설정(`PORT`, `HOST`, `EMBEDDED_POSTGRES_PORT`)은 [`apps/server/src/main.ts`](apps/server/src/main.ts) 머리에 있습니다. 스택은 [ADR-0004](docs/adr/0004-paperclip-aligned-stack.md)를 따릅니다.

패키지별 책임은 [전체 구조](docs/architecture.md#패키지-구성), 수정할 코드와 테스트의 위치는 [코드 지도](docs/agents/code-map.md)에서 확인합니다.

## 검증 기준

| 변경 | 완료 시 확인할 검사 |
| --- | --- |
| 모든 변경 | `git diff --check`, `pnpm check`. 문서만 바뀌면 로컬 기본 검사로 충분 |
| 제품 코드 | `pnpm test`, `pnpm typecheck`, `pnpm lint`와 변경 계약의 시나리오 |
| 빌드·실행 환경 | `pnpm build`와 관련 실행 확인 |
| 브라우저 동작 | 관련 E2E와 실제 화면·조작 확인 |

- 여러 행에 해당하면 합쳐 적용합니다. 조직 상태·승인·조직 분리 계약 변경은 해당 핵심 시나리오를 검증합니다.
- 검사마다 SHA·명령 또는 CI run·결과를 기록하고 실패 출력·종료 코드도 보존합니다. 미실행 환경·시나리오는 구분하고 PR이 있으면 본문에 모읍니다.
- 같은 코드의 검증은 재사용할 수 있습니다. 이전 SHA를 근거로 쓰면 이후 diff와 적용 이유를 남기고, 변경·실패·환경 차이에 맞춰 재검사합니다. 실패는 원인을 확인해 해소합니다.
- 로컬 검사 선택과 별개로 PR·main의 CI는 위에 설명한 전체 검사를 실행합니다. 병합 판단은 [병합 절차](docs/agents/pr-merge.md)를 따릅니다.

## 문서

[문서 지도](docs/README.md)에서 기능·구조·용어·개발 운영·인터뷰·조사 문서를 질문별로 찾습니다.

실제 실행 인스턴스의 파일·기억·실험 결과는 Git에서 제외하는 `.babojubot/` 아래 또는 설정된 외부 저장소에 둡니다. 최종 저장 방식은 후속 이슈에서 결정합니다.

상위 프로젝트의 구조를 참고해 독립적으로 작성합니다. 코드 재사용 시 해당 버전·파일·의존성의 라이선스를 확인합니다. BaboJUBot 자체의 배포 라이선스는 아직 선택하지 않았습니다.
