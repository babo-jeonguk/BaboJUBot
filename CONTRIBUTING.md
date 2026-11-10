# BaboJUBot 개발 가이드

개발 환경 구성, 데모 시나리오, 테스트·CI를 안내합니다. 제품 소개는 [README](README.md), 지금 구현된 동작은 [현재 구현 현황](docs/current-implementation.md)을 따릅니다.

## 개발 시작

Node.js 24.x, pnpm 10.33.0 및 Git을 사용합니다. GitHub 이슈 작업에는 인증된 `gh`가 필요합니다.

```bash
pnpm install
pnpm dev          # 서버(http://127.0.0.1:3100, 가짜 프로바이더 데모 시나리오)와 대시보드(http://127.0.0.1:5173)
pnpm test         # 패키지별 Vitest. 서버·DB 테스트는 실행마다 embedded Postgres 하나를 띄우고 테스트마다 DB를 복제합니다. 끝으로 테스트 실패가 실패 종료로 이어지는지 확인합니다.
pnpm test:e2e     # Playwright E2E(대시보드는 프로덕션 빌드로 띄움). 처음 한 번 `pnpm --filter @babojubot/web exec playwright install chromium`
pnpm typecheck
pnpm lint
pnpm check        # Markdown 로컬 링크 검사
```

Paseo로 research·implement·review-fix·merge를 네 세션으로 나눠 진행하는 개발 절차는 [개발 오케스트레이션](docs/agents/dev-orchestration.md)을 따릅니다.

### 데모 시나리오

`pnpm dev`의 서버는 기본으로 가짜 프로바이더를 씁니다. 실제 모델·유료 API·자격 증명 없이 대시보드(http://127.0.0.1:5173)에서 판 1 흐름을 처음부터 끝까지 해 볼 수 있습니다. 개발 DB(`BABOJUBOT_HOME` 아래 `postgres`)는 지우지 않으므로 전에 만든 조직도 그대로 보입니다.

1. 레일의 `＋`(새 연구 조직)를 누르고 조직 이름, 연구 목표 `공개 자료로 오류 유형을 정리한다`, 완료 기준 `유형 목록과 근거 메모`를 적어 만듭니다.
2. Lead 대화가 열리고, 생성으로 깨어난 Lead가 초기 연구 승인을 요청했다고 답합니다. 완료 기준을 비워 두면 Lead가 목표에서 만든 기준을 같은 요청에 제안합니다.
3. Inbox에서 초기 연구 승인 요청을 열어 계획·팀·연구 환경 명세를 보고 승인합니다. 작업자 2명이 생기고 Lead가 한 명에 작업 하나씩 맡깁니다.
4. 조직 › 작업에서 끝난 작업의 자기 보고·산출물과 연결된 연구 노드(누르면 연구 지도)를 봅니다. 산출물이 있어도 연구는 `연구 진행` 그대로입니다.
5. 조직 › 에이전트의 조직도에서 Lead 아래 작업자 2명을 보고, 카드를 눌러 에이전트 상세로 갑니다. 이름을 눌러 바꾸고(Enter 저장, Esc 취소) 얼굴을 눌러 꾸밀 수 있으며, heartbeat를 켜고 끌 수 있습니다. 조직 › 설정에서 `작업자 추가` 승인 정책을 켭니다.
6. 조직 › 대시보드에서 조직을 일시정지하고 Lead 대화에 `작업자 추가: researcher`를 보냅니다. 메시지는 입력창 위 `줄 세운 메시지`에 남습니다. 재개하면 Lead가 작업자 추가 승인을 요청하고, Inbox에서 승인하면 조직도의 작업자가 3명이 됩니다.
7. Lead 대화에 `결과 제출 부탁해요`를 보내면 Lead가 산출물을 근거로 결과를 제출합니다. Inbox에서 결과 제출을 열어 요약·완료 기준·근거 산출물을 보고(전체 내용은 `원래 화면에서 자세히 보기`) `최종 완료`를 확정합니다. 의견을 적어 수정 요청하면 Lead가 다시 제출합니다.

[데모 흐름 E2E](apps/web/e2e/demo-flow.spec.ts)가 같은 순서를 화면 조작으로 지킵니다(`pnpm test:e2e demo-flow`). 그 밖에 Lead 대화의 `실패 연습`·`실행 유지 연습` 부탁으로 실패한 실행 시도와 실행 중인 에이전트를 볼 수 있고, 작업 댓글로 같은 부탁을 하면 그 작업의 작업자가 그렇게 합니다(홈의 걱정하는 얼굴·작업 말풍선 확인용). `끼워 넣기 연습`을 부탁하면 가짜 Lead가 실행 중에 끼워 넣은 말을 받을 때까지 기다렸다가 반영했다고 답하고, `메모해 주세요: <말>`과 `세션 메모를 알려 주세요`로 세션 이어가기를 볼 수 있습니다(에이전트 기억과는 다른 세션 안의 메모). 위 흐름은 모두 기본 대화에서 진행되며, 대화 목록의 `＋ 새 대화`로 다른 주제를 보내면 가짜 Lead가 그 대화에 답하고, 승인 직후 분담·작업 완료 보고처럼 스스로 알리는 메시지는 기본 대화에 옵니다.

`pnpm install`은 `@embedded-postgres/*`의 postinstall만 실행합니다(`pnpm-workspace.yaml`의 `onlyBuiltDependencies`). 이 script가 Postgres native library의 symlink를 만들기 때문에 `--ignore-scripts`로 설치하면 embedded Postgres가 뜨지 않습니다. 내장 Postgres는 묶여 온 `pg_ctl`로 켜고 끄므로 Windows 관리자 계정에서도 뜹니다. 서버가 강제로 끝나 남은 내장 Postgres는 다음 시작이 정상 정지하고 다시 띄웁니다. 다른 프로세스가 아직 쓰고 있거나 BaboJUBot이 띄운 것인지 확인할 수 없으면 끄는 명령을 알리고 시작하지 않습니다.

[CI](.github/workflows/scaffold.yml)는 `main` 대상 PR의 생성·갱신·재개와 `main` push에서 문서 검사·타입·lint·테스트·빌드·E2E를 실행합니다. 바뀐 파일이 Markdown뿐이면 문서 검사만 돌리고 나머지 검사는 건너뛴 채 성공으로 표시합니다.
기능 브랜치 push만으로는 중복 실행하지 않고, 같은 PR의 오래된 실행은 취소합니다.
`main`의 필수 검사는 workflow의 `ci / …` job 전체이며, 실행 환경과 검사 이름은 workflow를 기준으로 합니다.
표준 GitHub-hosted runner를 쓰는 공개 저장소의 실행 시간은 무료입니다([GitHub 과금 문서](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
실패한 E2E의 trace 등 결과물만 3일 보관하며 artifact·cache 저장 공간 한도는 별도로 관리합니다.

조직 폴더(`organizations/<조직 ID>/`)에는 자기 조직 ID를 적은 `workspace-identity.json`이 있습니다. 다른 조직의 폴더가 그 자리에 놓이거나 이 파일이 없어지면 그 조직의 실행은 이유를 보이며 실패합니다. 데이터 폴더를 옮기거나 복원할 때는 이 파일을 함께 옮기면 그대로 동작합니다. 예전 조직은 첫 실행 때 현재 폴더를 믿고 한 번 적습니다.

데이터베이스는 `DATABASE_URL`이 있으면 그 외부 Postgres에 연결만 하고, 없으면 embedded Postgres를 `BABOJUBOT_HOME` 아래 `postgres`에 띄웁니다. `BABOJUBOT_HOME`을 지정하지 않으면 저장소의 Git 제외 로컬 데이터 폴더를 쓰며 기본값은 [`apps/server/src/main.ts`](apps/server/src/main.ts)에 있습니다. 둘 다 시작할 때 같은 migration을 적용합니다. 운영은 `pnpm build` 후 `DATABASE_URL=… pnpm start`로 서버가 빌드한 대시보드까지 제공합니다. 그 밖의 설정(`PORT`, `HOST`, `EMBEDDED_POSTGRES_PORT`, `BABOJUBOT_SHUTDOWN_TIMEOUT_MS`, `BABOJUBOT_FAKE_PROVIDERS`)은 [`apps/server/src/main.ts`](apps/server/src/main.ts) 머리에 있습니다. 서버를 Docker·Kubernetes·systemd로 돌리면 그 정지 시한을 `BABOJUBOT_SHUTDOWN_TIMEOUT_MS`(기본 30초)보다 길게 둡니다. 스택은 [ADR-0004](docs/adr/0004-paperclip-aligned-stack.md)를 따릅니다.

패키지별 책임은 [전체 구조](docs/architecture.md#패키지-구성), 수정할 코드와 테스트의 위치는 [코드 지도](docs/agents/code-map.md)에서 확인합니다.

## 검증 기준

검사 시점·완료 검사·결과 재사용은 [검증 기준](docs/agents/verification.md)을 따릅니다.

## 문서

[문서 지도](docs/README.md)에서 기능·구조·용어·개발 운영·인터뷰·조사 문서를 질문별로 찾습니다.

실제 실행 인스턴스의 파일·기억·실험 결과는 `BABOJUBOT_HOME`(기본값은 저장소의 Git 제외 로컬 데이터 폴더) 아래 또는 설정된 외부 저장소에 둡니다. 최종 저장 방식은 후속 이슈에서 결정합니다.

상위 프로젝트의 구조를 참고해 독립적으로 작성합니다. 코드 재사용 시 해당 버전·파일·의존성의 라이선스를 확인합니다. BaboJUBot 자체의 배포 라이선스는 아직 선택하지 않았습니다.


## 개발 규칙 및 참고 문서

- **개발 절차 및 오케스트레이션**: [AGENTS.md](AGENTS.md) 및 [docs/agents/dev-orchestration.md](docs/agents/dev-orchestration.md)
- **문서 지도 (SSOT)**: [docs/README.md](docs/README.md)
- **시스템 아키텍처 및 불변 조건**: [docs/architecture.md](docs/architecture.md)
- **구현 기능 기준선**: [docs/features.md](docs/features.md)
- **코드 지도 (디렉터리 및 코드 진입점)**: [docs/agents/code-map.md](docs/agents/code-map.md)
- **프로바이더 운영 및 어댑터 안내**: [docs/providers.md](docs/providers.md)
- **검증 기준**: [docs/agents/verification.md](docs/agents/verification.md)
- **커밋 메시지 규칙**: [docs/agents/commit-messages.md](docs/agents/commit-messages.md)
