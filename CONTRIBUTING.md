# BaboJUBot 개발 및 기여 가이드

BaboJUBot 프로젝트의 개발 환경 구성, 테스트, 데모 시나리오 실행 및 기여 절차를 안내합니다. 제품 기능과 사용자 안내는 [README.md](README.md)를 참고하세요.

## 개발 시작

### 요구사항
- **Node.js**: 24.x
- **pnpm**: 10.33.0
- **Git**
- **GitHub CLI (`gh`)**: GitHub 이슈 작업 및 PR 관리에 필요

### 설치 및 로컬 서버 실행

```bash
pnpm install
pnpm dev          # 서버(http://127.0.0.1:3100)와 대시보드(http://127.0.0.1:5173) 실행
```

> [!IMPORTANT]
> `pnpm install`은 `@embedded-postgres/*`의 postinstall을 실행하여 Postgres native library의 symlink를 생성합니다(`pnpm-workspace.yaml`의 `onlyBuiltDependencies`). `--ignore-scripts` 옵션으로 설치하면 내장 Postgres가 정상 작동하지 않습니다.

### 주요 개발 명령어

```bash
pnpm dev          # 로컬 개발 서버 및 대시보드 (기본 가짜 프로바이더)
pnpm test         # Vitest 단위/통합 테스트 (실행 시 임베디드 Postgres 복제본 사용)
pnpm test:e2e     # Playwright E2E 테스트 (대시보드는 프로덕션 빌드로 실행)
                  # 최초 실행 전: pnpm --filter @babojubot/web exec playwright install chromium
pnpm typecheck    # TypeScript 전체 타입 검사
pnpm lint         # 코드 린트 검사
pnpm check        # Markdown 로컬 링크 무결성 검사
pnpm build        # 프로덕션 빌드
```

---

## 데모 시나리오 (가짜 프로바이더)

`pnpm dev`의 서버는 기본으로 가짜 프로바이더(Fake Provider)를 사용합니다. 실제 모델 API 키나 과금 없이 대시보드(http://127.0.0.1:5173)에서 판 1의 전체 연구 운영 흐름을 처음부터 끝까지 체험해 볼 수 있습니다.

개발 데이터베이스(`.babojubot/postgres`)는 재시작 시에도 유지되므로 이전에 생성한 조직이 그대로 보존됩니다.

### 7단계 데모 진행 순서
1. **조직 생성**: 사이드바 레일의 `＋`(새 연구 조직)를 누르고, 조직 이름, 연구 목표(`공개 자료로 오류 유형을 정리한다`), 완료 기준(`유형 목록과 근거 메모`)을 적어 만듭니다.
2. **초기 계획 수립**: Lead 대화가 열리고, 생성으로 깨어난 Lead가 초기 연구 승인을 요청했다고 답합니다. (완료 기준을 비워 두면 Lead가 목표에서 만든 기준을 같은 요청에 제안합니다.)
3. **Inbox 승인**: Inbox에서 초기 연구 승인 요청을 열어 계획·팀·연구 환경 명세를 검토하고 승인합니다. 승인 즉시 작업자 2명이 생성되고 Lead가 작업 하나씩을 배정합니다.
4. **작업 및 연구 지도 확인**: 조직 › 작업에서 완료된 작업의 보고서·산출물과 연결된 연구 노드를 확인합니다. (노드를 누르면 연구 지도로 이동)
5. **조직도 및 설정 조정**: 조직 › 에이전트 조직도에서 Lead와 작업자를 확인하고, 에이전트 상세에서 이름/얼굴 꾸미기 및 heartbeat 설정을 테스트합니다. 조직 › 설정에서 `작업자 추가` 승인 정책을 켭니다.
6. **일시정지 및 작업자 추가 승인**: 조직 대시보드에서 조직을 일시정지한 뒤 Lead 대화에 `작업자 추가: researcher`를 보냅니다. 메시지는 입력창 위 `줄 세운 메시지`에 대기합니다. 조직을 재개하면 Lead가 승인을 요청하고, Inbox에서 승인하면 작업자가 3명으로 늘어납니다.
7. **결과 제출 및 최종 완료**: Lead 대화에 `결과 제출 부탁해요`를 보내면 Lead가 산출물을 근거로 결과를 제출합니다. Inbox에서 결과 제출을 열어 검토한 뒤 `최종 완료`를 확정합니다.

이 전체 흐름은 [Playwright E2E 테스트](apps/web/e2e/demo-flow.spec.ts)(`pnpm test:e2e demo-flow`)로 상시 검증됩니다.

### 대화 연습 명령어 (가짜 Lead 인터랙션)
- `실패 연습` / `실행 유지 연습`: 실패한 실행 시도(Inbox 주의 항목) 및 실행 중 애니메이션(홈 로비) 확인.
- `끼워 넣기 연습`: 실행 도중 끼워 넣은 메시지 반영 확인.
- `메모해 주세요: <내용>` / `세션 메모를 알려 주세요`: 세션 이어가기 메모 동작 확인.

---

## 데이터베이스 및 런타임 환경 설정

- **PostgreSQL**:
  - `DATABASE_URL` 환경변수가 설정되어 있으면 해당 외부 Postgres에 연결합니다.
  - 설정되지 않은 경우, 내장(embedded) Postgres를 `.babojubot/postgres`(`BABOJUBOT_HOME` 경로 기준)에 자동으로 구동합니다.
  - 내장 Postgres는 묶여 온 `pg_ctl`을 사용하여 정상 제어되며, 비정상 종료 시 다음 서버 기동 시 자동으로 프로세스를 정리하고 재시작합니다.
- **주요 환경 변수** ([apps/server/src/main.ts](apps/server/src/main.ts)):
  - `PORT`: 서버 포트 (기본 `3100`)
  - `HOST`: 바인딩 호스트 (기본 `127.0.0.1`)
  - `EMBEDDED_POSTGRES_PORT`: 임베디드 Postgres 포트
  - `BABOJUBOT_SHUTDOWN_TIMEOUT_MS`: 서버 정상 종료 대기 한도 (기본 `30000`ms)
  - `BABOJUBOT_PROVIDERS`: 실제 프로바이더 연결 설정 ([docs/providers.md](docs/providers.md))
- **조직 작업 폴더 격리**:
  - `organizations/<조직 ID>/` 폴더에는 `workspace-identity.json`이 있어 조직 ID 무결성을 검증합니다.

---

## 지속적 통합 (CI) 및 품질 정책

[GitHub Actions 워크플로우](.github/workflows/scaffold.yml)는 `main` 브랜치 대상 PR 및 push에서 실행됩니다:
- **Markdown-only 최적화**: 변경 파일이 Markdown뿐인 경우 문서 링크 검사(`pnpm check`)만 실행하고 무거운 빌드/테스트를 건너뜁니다.
- **필수 검사**: `main` 병합을 위해 `ci / ...` job(타입 검사, 린트, 단위 테스트, 빌드, E2E) 전체가 통과해야 합니다.
- **아티팩트 정책**: 실패한 E2E의 trace 등 결과물만 3일간 보관합니다.

---

## 개발 규칙 및 참고 문서

- **개발 절차 및 오케스트레이션**: [AGENTS.md](AGENTS.md) 및 [docs/agents/dev-orchestration.md](docs/agents/dev-orchestration.md)
- **문서 지도 (SSOT)**: [docs/README.md](docs/README.md)
- **시스템 아키텍처 및 불변 조건**: [docs/architecture.md](docs/architecture.md)
- **구현 기능 기준선**: [docs/features.md](docs/features.md)
- **코드 지도 (디렉터리 및 코드 진입점)**: [docs/agents/code-map.md](docs/agents/code-map.md)
- **프로바이더 운영 및 어댑터 안내**: [docs/providers.md](docs/providers.md)
- **검증 기준**: [docs/agents/verification.md](docs/agents/verification.md)
- **커밋 메시지 규칙**: [docs/agents/commit-messages.md](docs/agents/commit-messages.md)
