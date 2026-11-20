# BaboJUBot 개발 가이드

개발 환경 구성, 개발용·장시간 실행 방식, 데모 시나리오, 테스트·CI를 안내합니다. 제품 소개는 [README](README.md), 지금 구현된 동작은 [현재 구현 현황](docs/current-implementation.md)을 따릅니다.

## 개발 시작

Node.js 24.x, pnpm 10.33.0 및 Git을 사용합니다. GitHub 이슈 작업에는 인증된 `gh`가 필요합니다.

```bash
pnpm install
pnpm dev          # 개발용 hot reload. 서버(http://127.0.0.1:3100, 가짜 프로바이더 데모 시나리오)와 대시보드(http://127.0.0.1:5173)
pnpm test         # 패키지별 Vitest. 서버·DB 테스트는 실행마다 embedded Postgres 하나를 띄우고 테스트마다 DB를 복제합니다. 끝으로 테스트 실패가 실패 종료로 이어지는지 확인합니다.
pnpm test:e2e     # Playwright E2E(대시보드는 프로덕션 빌드로 띄움). 처음 한 번 `pnpm --filter @babojubot/web exec playwright install chromium`
pnpm typecheck
pnpm typecheck:src  # 제품 코드만 타입 검사
pnpm typecheck:test # 시험 코드를 시작점으로 타입 검사(가져다 쓰는 제품 코드도 함께 검사)
pnpm lint         # 시험 코드에는 시험 전용 규칙(폴더 지우기는 removeFolder로)을, 제품 코드에는 제품 규칙(바깥 데이터는 확인 뒤 사용, JSON·응답 본문을 읽자마자 타입 단정 금지, 비동기 실패 방치 금지, 폐기 예정 기능 금지, runtime의 프로그램 실행은 정해진 파일에서만)을 더 겁니다. lint 예외 주석에는 `-- 이유`를 씁니다.
pnpm check        # Markdown 로컬 링크 검사, lint 규칙 회귀(scripts/lint-rules.test.mjs, scripts/product-lint-rules.test.mjs, scripts/script-lint-rules.test.mjs)와 CI 회귀 검사(테스트 집계 scripts/ci-test-gate.test.mjs, 실패 이유 분류 scripts/ci-job-failures.test.mjs, 내려받기 재시도 scripts/ci-downloads.test.mjs, 실행 판정 scripts/ci-changes.test.mjs, 파일 경계 결과표 scripts/file-boundary-report.test.mjs, E2E 결과 판정 scripts/check-e2e-report.test.mjs, 시험 묶음의 실행·통과 수 판정 scripts/check-test-reports.test.mjs, 바뀐 파일 검사 범위 scripts/verify-changed.test.mjs, 실제 프로바이더 확인의 정리 scripts/live/check-server.test.mjs, 시험용 명령 찾기 scripts/live/processes.test.mjs, 장애 검사 실행 관문 scripts/live/chaos-budget.test.mjs, 장애 검사 장면 준비 scripts/live/chaos-run.test.mjs, 실제 프로바이더 점검의 장면 고르기·판정 scripts/live/provider-scenes.test.mjs, worker 실행 시간 한도·끄기 .agents/scripts/run-worker.test.mjs, worker 시도·멈춤 판정 .agents/scripts/worker-run.test.mjs). node:test 묶음은 `scripts/run-node-tests.mjs`로 돌려 CI에서 묶음마다 실행·통과 수를 판정합니다. 회귀 검사는 추가 Bash 없이 Node로 실행합니다.
pnpm verify:changed  # 바뀐 파일 기준으로 lint·타입 검사할 범위를 정해 돌리고 pnpm check까지 실행. --dry-run은 명령만 출력
```

### 개발용 실행과 장시간 연구 실행

`pnpm dev`는 서버를 `node --watch`로 띄워 서버가 불러온 소스·의존 패키지 파일(`node_modules` 포함)이 바뀔 때마다 서버를 다시 시작합니다. 다시 시작하면 진행 중인 실행 시도가 `server_restart`로 끝납니다. 깨우기는 다시 대기해 이어지지만, `git pull`·브랜치 전환·다른 세션의 편집이 반복되면 장시간 연구가 계속 끊길 수 있습니다. 코드를 고치며 확인할 때만 `pnpm dev`를 쓰고, 장시간 연구나 실제 모델 연구는 파일 감시 없이 띄웁니다.

```bash
pnpm build                                     # 대시보드를 apps/web/dist에 빌드
BABOJUBOT_PROVIDERS=opencode pnpm start   # 감시 없는 서버가 대시보드와 API를 함께 제공
```

대시보드와 API는 모두 `http://127.0.0.1:3100`(`PORT`를 정하면 그 포트)에서 열립니다. 서버는 시작할 때 `apps/web/dist`가 있어야 대시보드를 제공하므로 먼저 빌드합니다. 프로바이더 등 환경 변수는 `pnpm start` 앞에 둡니다. 코드 변경은 자동 반영되지 않으므로 `pnpm build`를 다시 하고 서버를 재시작합니다. 이 경로는 자동 재시작만 막습니다. 실행 중에 의존성을 갱신하거나 파일을 지우는 일까지 막는 배포 격리는 아닙니다.

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

`pnpm install`은 `@embedded-postgres/*`의 postinstall만 실행합니다(`pnpm-workspace.yaml`의 `onlyBuiltDependencies`). 이 script가 Postgres native library의 symlink를 만들기 때문에 `--ignore-scripts`로 설치하면 embedded Postgres가 뜨지 않습니다. 내장 Postgres는 묶여 온 `pg_ctl`로 켜고 끄므로 Windows 관리자 계정에서도 뜹니다.

[CI](.github/workflows/scaffold.yml)는 `main` 대상 PR의 생성·갱신·재개와 `main` push에서 돕니다. 기능 브랜치 push만으로는 돌지 않고, 같은 PR의 오래된 실행은 취소합니다. job 목록·실행 환경·시한은 workflow가 기준입니다.

- 문서 검사·타입·lint·빌드·E2E(`ci / …`)와 독립 테스트 job(`tests / …`, macOS·Windows의 `runtime on …`, Windows E2E shard 둘)을 돌립니다. 바뀐 파일이 Markdown뿐이면 문서 검사만 돌리고 나머지는 건너뛴 채 성공으로 표시합니다.
- 조직 경계의 파일 읽기와 그 계약·시험·환경 준비·의존성·CI 설정이 바뀌면([판정](scripts/ci-changes.mjs)) 파일 시스템별 전체 검증 job(`files / …`)도 돌고, 볼륨별 결과표를 job 요약과 artifact로 남깁니다.
- `main`의 필수 검사는 `ci / …` job 전체이며, 그중 `ci / test`가 테스트 job 각각의 결과를 직접 판정합니다. 실패하면 실패한 job마다 이유(시험 실패·실행 컴퓨터 미배정·취소·알 수 없음)를 job 요약 표에 남깁니다. 실행 컴퓨터를 받지 못한 job도 실패이며 자동으로 다시 돌리지 않습니다.
- 실제 OpenCode 시험은 `BABOJUBOT_TEST_OPENCODE`로 실행 파일을, 링크를 만들 수 없는 디스크의 인증 중계 시험은 `BABOJUBOT_TEST_NO_LINK_DIR`로 그 디스크의 폴더를 정하면 돌고, 정하지 않으면 건너뜁니다. CI는 두 변수를 정해 돌립니다.
- 다른 변경에서도 `gh workflow run CI --ref <branch>`(특정 commit은 `-f sha=<40자 SHA>`)로 모든 검사를 직접 돌릴 수 있습니다.
- 표준 GitHub-hosted runner를 쓰는 공개 저장소라 실행 시간은 무료입니다([GitHub 과금 문서](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

CI 판정·결과 보고 스크립트의 위치는 [코드 지도](docs/agents/code-map/dev-environment.md)에 있습니다.

데이터베이스는 `DATABASE_URL`이 있으면 그 외부 Postgres에 연결만 하고, 없으면 embedded Postgres를 `BABOJUBOT_HOME` 아래 `postgres`에 띄웁니다. `BABOJUBOT_HOME`을 지정하지 않으면 저장소의 Git 제외 로컬 데이터 폴더를 쓰며 기본값은 [`apps/server/src/main.ts`](apps/server/src/main.ts)에 있습니다. 둘 다 시작할 때 같은 migration을 적용합니다. 운영은 `pnpm build` 후 `DATABASE_URL=… pnpm start`로 서버가 빌드한 대시보드까지 제공합니다. 그 밖의 설정(`PORT`, `HOST`, `EMBEDDED_POSTGRES_PORT`, `BABOJUBOT_SHUTDOWN_TIMEOUT_MS`, `BABOJUBOT_FAKE_PROVIDERS`)은 [`apps/server/src/main.ts`](apps/server/src/main.ts) 머리에 있습니다. 서버의 종료·데이터 폴더 동작은 [현재 구현 현황](docs/current-implementation.md#서버-종료와-데이터-폴더)에 있습니다. 스택은 [ADR-0004](docs/adr/0004-paperclip-aligned-stack.md)를 따릅니다.

패키지별 책임은 [전체 구조](docs/architecture.md#패키지-구성), 수정할 코드와 테스트의 위치는 [코드 지도](docs/agents/code-map.md)에서 확인합니다.

## 검증 기준

검사 시점·완료 검사·결과 재사용은 [검증 기준](docs/agents/verification.md)을, 제품 코드·시험·CI 작성은 [코드 작성 기준](CODING_STANDARDS.md)을 따릅니다.

## 문서

[문서 지도](docs/README.md)에서 기능·구조·용어·개발 운영·인터뷰·조사 문서를 질문별로 찾습니다.

실제 실행 인스턴스의 파일·기억·실험 결과는 `BABOJUBOT_HOME`(기본값은 저장소의 Git 제외 로컬 데이터 폴더) 아래 또는 설정된 외부 저장소에 둡니다. 최종 저장 방식은 후속 이슈에서 결정합니다.

상위 프로젝트의 구조를 참고해 독립적으로 작성합니다. 코드 재사용 시 해당 버전·파일·의존성의 라이선스를 확인합니다. BaboJUBot 자체의 배포 라이선스는 [MIT](LICENSE)입니다.
