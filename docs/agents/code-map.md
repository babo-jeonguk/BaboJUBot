# 코드 지도

작업·증상에서 시작해 아래 표의 진입점과 검증 위치부터 읽고, 관련 호출·계약을 따라 탐색을 넓힙니다.
경로 안에서 함수를 찾을 때는 `rg`를 사용합니다. 표에 없는 작업은 가까운 진입점에서 검색합니다.
이 문서는 현재 구현의 탐색 지도입니다. module 책임과 seam은 [전체 구조](../architecture.md), 용어와 결정은 [도메인 문서 규칙](domain.md)을 따릅니다.
현재 실행 가능한 범위의 요약은 [README](../../README.md), 후속 기능의 요구는 [features.md](../features.md)와 해당 이슈에서 확인합니다.

## 작업 → 코드·검증

| 작업·증상 | 진입점과 함께 볼 코드 | 검증 위치 |
| --- | --- | --- |
| 조직 생성 입력·응답, 생애주기 값의 계약 변경 | [contracts/organization.ts](../../packages/contracts/src/organization.ts); 사용하는 core·DB schema·웹 표시도 확인 | [입력 계약 테스트](../../packages/contracts/src/organization.test.ts) |
| 새 조직의 초기 상태·전용 Lead·생성 Event 변경 | [core/organization.ts](../../packages/core/src/organization.ts)의 `planOrganizationCreation`; [서버 생성 서비스](../../apps/server/src/organizations.ts) | [core 테스트](../../packages/core/src/organization.test.ts) |
| 조직·Lead·Event 저장 또는 rollback 문제 | [db/organizations.ts](../../packages/db/src/organizations.ts)의 `insertOrganizationCreation`; [schema](../../packages/db/src/schema.ts), [migration](../../packages/db/migrations/), 서버 생성 서비스 | [DB 저장·제약 테스트](../../packages/db/src/organizations.test.ts) |
| 조직 생성·조회 API, 입력 오류·404 처리 | [server/app.ts](../../apps/server/src/app.ts)의 `startServer`; 서버 생성 서비스, DB 조회, contracts | [API 통합 테스트](../../apps/server/test/organizations.test.ts) |
| 조직별 Event 구독·다른 조직 Event 혼입 | [server/app.ts](../../apps/server/src/app.ts)의 upgrade·attach; [EventHub](../../apps/server/src/event-hub.ts), [Event 계약](../../packages/contracts/src/event.ts) | [구독자 라우팅 테스트](../../apps/server/src/event-hub.test.ts), API 통합 테스트의 `Event stream scopes` |
| 조직 생성 후 다른 탭·홈·사이드바 갱신 누락 | [web/live-events.ts](../../apps/web/src/live-events.ts)의 `useLiveEvents`; [web/api.ts](../../apps/web/src/api.ts)의 query key·캐시, 서버 Event 발행 | [조직 생성·다른 탭 갱신 E2E](../../apps/web/e2e/create-organization.spec.ts) |
| 조직 생성 dialog·성공 후 이동·실패 안내 | [web/create-organization.tsx](../../apps/web/src/create-organization.tsx); web/api.ts의 `useCreateOrganization`, contracts의 입력 기준 | 조직 생성 E2E |
| 홈·조직 화면·주소·메뉴·빈 상태 | [web/pages.tsx](../../apps/web/src/pages.tsx), [shell.tsx](../../apps/web/src/shell.tsx), [main.tsx](../../apps/web/src/main.tsx)의 routes | 조직 생성 E2E가 홈·조직 메뉴·Lead 빈 화면을 확인 |
| 공용 UI·상태 표시·반응형 스타일 | [web/ui.tsx](../../apps/web/src/ui.tsx), [index.css](../../apps/web/src/index.css); 해당 화면 component | 현재 자동화 범위는 조직 생성 E2E; 모든 화면·폭을 검증하는 전용 테스트는 없음 |
| 서버 시작·종료, embedded/외부 DB, 정적 웹 제공 | [server/main.ts](../../apps/server/src/main.ts), server/app.ts; [db/client.ts](../../packages/db/src/client.ts) | [외부 DB 시작·종료 테스트](../../apps/server/test/main.test.ts), DB 테스트, 관련 실행 확인 |
| DB 테스트 환경·임시 Postgres 수명 | [db/testing.ts](../../packages/db/src/testing.ts), db/client.ts; [서버 테스트 지원](../../apps/server/test/support.ts) | DB·서버 테스트. 브라우저의 임시 서버는 [Playwright 설정](../../apps/web/playwright.config.ts) |
| 실행·빌드·검사·CI·commit hook | [루트 scripts](../../package.json), 각 workspace의 package.json, [CI](../../.github/workflows/scaffold.yml), [pre-commit](../../.husky/pre-commit) | 명령 사용법은 [README](../../README.md#개발-시작); 문서 링크는 [check-project.mjs](../../scripts/check-project.mjs) |
| 실행 시도 계약(요청·공개 활동·종료·취소), 조직 도구·Lead 대화 메시지 계약 | [contracts/run.ts](../../packages/contracts/src/run.ts), [tools.ts](../../packages/contracts/src/tools.ts), [message.ts](../../packages/contracts/src/message.ts), [event.ts](../../packages/contracts/src/event.ts) | [계약 테스트](../../packages/contracts/src/run.test.ts) |
| 사용자 메시지·깨우기·실행 시도 묶음·세션 이어 가기·토큰 허용 규칙 | [core/run.ts](../../packages/core/src/run.ts) | [API 통합 테스트](../../apps/server/test/runs.test.ts); API로 재현하기 어려운 bundle 버전별 세션 규칙만 [core 테스트](../../packages/core/src/run.test.ts) |
| 깨우기 대기열, 에이전트당 실행 시도 하나, 묶음 고정, 종료·도구 쓰기 직렬화 | [db/runs.ts](../../packages/db/src/runs.ts)의 `claimNextRun`·`finishRun`·`insertAgentMessage`; [schema](../../packages/db/src/schema.ts), [migration](../../packages/db/migrations/) | [DB admission·동시성 테스트](../../packages/db/src/runs.test.ts) |
| 깨우기 처리·DB 오류 후 admission/종료 저장 재시도·실행기 호출·공개 활동 필터·서버 종료 시 취소 | [server/dispatcher.ts](../../apps/server/src/dispatcher.ts)의 `RunDispatcher`; [run-token.ts](../../apps/server/src/run-token.ts) | [API 통합 테스트](../../apps/server/test/runs.test.ts) |
| 조직 도구 HTTP의 토큰 인증·교차 조직 404·종료 토큰 거부 | [server/tools.ts](../../apps/server/src/tools.ts); db/runs.ts의 `authenticateRun` | API 통합 테스트의 `organization tools` |
| Lead 대화·실행 시도·에이전트 조회 API | [server/app.ts](../../apps/server/src/app.ts), [conversation.ts](../../apps/server/src/conversation.ts) | API 통합 테스트 |
| 가짜 실행기 시나리오·조직 도구 client·테스트 gate | [runtime/scripted.ts](../../packages/runtime/src/scripted.ts), [tools-client.ts](../../packages/runtime/src/tools-client.ts), [testing.ts](../../packages/runtime/src/testing.ts) | [가짜 실행기 테스트](../../packages/runtime/src/scripted.test.ts) |
| Lead 대화·활동·실행 시도 상세·에이전트 화면 | [web/chat.tsx](../../apps/web/src/chat.tsx), [activity.tsx](../../apps/web/src/activity.tsx), [agents.tsx](../../apps/web/src/agents.tsx); web/api.ts의 query key | [Lead 대화 E2E](../../apps/web/e2e/lead-chat.spec.ts) |
| 목표 기록·승인 요청·결정·하네스 사본·Inbox 계약 | [contracts/approval.ts](../../packages/contracts/src/approval.ts), [harness.ts](../../packages/contracts/src/harness.ts); 새 Event는 event.ts, 도구 이름·경로·method는 tools.ts | API 통합 테스트 |
| Role·생애주기 단계별 조직 도구 규칙, 승인 대상 snapshot, 결정의 효과(단계·작업자·사본·템플릿·깨우기) | [core/approval.ts](../../packages/core/src/approval.ts)의 `toolRules`·`checkToolCall`·`buildInitialResearchProposal`·`planApprovalDecision` | [core 테스트](../../packages/core/src/approval.test.ts), [승인 API 통합 테스트](../../apps/server/test/approvals.test.ts) |
| 지침 bundle 버전 직렬화, SKILL.md frontmatter·UTF-8 검증 | [core/harness.ts](../../packages/core/src/harness.ts) | [core 테스트](../../packages/core/src/harness.test.ts) |
| 하네스 라이브러리 구조·읽기 실패, Lead Role 찾기 | [harness/README.md](../../harness/README.md), [server/harness.ts](../../apps/server/src/harness.ts)의 `loadHarnessLibrary` | 승인 API 통합 테스트가 사본 내용을 라이브러리 파일과 비교 |
| 거부한 도구 호출의 Event, 단계 전이 경합, 결정 한 번만 적용·rollback | [db/approvals.ts](../../packages/db/src/approvals.ts)의 `gateToolCall`·`toolWrite`·`decideApproval`; 조직 행 잠금은 [db/rows.ts](../../packages/db/src/rows.ts)의 `lockOrganization` | 승인 API 통합 테스트의 동시 결정·거부 기록 |
| 에이전트 사본·조직 템플릿 사본 조회, admission의 bundle 버전 | [db/harness.ts](../../packages/db/src/harness.ts); db/runs.ts의 `claimNextRun`·`selectWakes` | [DB 저장 테스트](../../packages/db/src/organizations.test.ts), 승인 API 통합 테스트 |
| 승인 결정 명령·Inbox·승인 요청·사본 조회 API | [server/app.ts](../../apps/server/src/app.ts), [server/approvals.ts](../../apps/server/src/approvals.ts); 조직 도구 handler는 server/tools.ts | 승인 API 통합 테스트 |
| 가짜 Lead의 데모 흐름(목표 기록 → 승인 요청 → 재제출) | [runtime/scripted.ts](../../packages/runtime/src/scripted.ts)의 `demoLeadScript` | [가짜 실행기 테스트](../../packages/runtime/src/scripted.test.ts) |
| Inbox·승인 요청 상세·결정 폼, 조직 대시보드, 에이전트 팀·사본 보기 | [web/approvals.tsx](../../apps/web/src/approvals.tsx), [pages.tsx](../../apps/web/src/pages.tsx)의 `OrganizationDashboard`, [agents.tsx](../../apps/web/src/agents.tsx)의 `InstructionCopies` | [초기 연구 승인 E2E](../../apps/web/e2e/initial-approval.spec.ts) |
| 후속 실제 실행기 adapter의 구현 위치 탐색 | [packages/runtime](../../packages/runtime/src/index.ts)에 adapter를 더하고, 요청의 `instructions`(사본 내용)를 실행기 방식으로 주입 | 실제 adapter 테스트 없음; 요구와 계약은 해당 후속 이슈 |

## 조직 생성의 연결 경로

```text
create-organization.tsx → api.ts → POST /api/organizations (server/app.ts)
  → server/organizations.ts
    → core/organization.ts: 생성할 조직·Lead·Event 조립
    → db/organizations.ts: transaction 저장
    → EventHub.publish: commit 뒤 알림
  → HTTP 응답으로 웹 캐시 갱신

EventHub → WebSocket /api/events → live-events.ts → 관련 query 재조회
```

생성·저장·알림 순서 문제는 [서버 생성 서비스](../../apps/server/src/organizations.ts)에서 시작합니다.
Event stream 재연결 시 화면 복구는 [useLiveEvents](../../apps/web/src/live-events.ts)에서 확인합니다.
DB schema·contracts·웹 응답 검증을 가로지르는 변경은 위 경로의 각 경계를 함께 확인합니다.

## Lead 대화에서 실행 시도까지의 연결 경로

```text
chat.tsx → POST /api/organizations/:id/messages (server/app.ts)
  → conversation.ts → core/run.ts planOwnerMessage → db/runs.ts insertOwnerMessage(메시지·깨우기·Event)
  → RunDispatcher.kick(Lead)
    → db/runs.ts claimNextRun: 에이전트 행 잠금 → 실행 중 확인 → 대기 깨우기 전부를 실행 시도에 고정
    → RuntimeAdapter.execute(요청: 신원·토큰·깨우기 사유·맥락 …)
        가짜 실행기 → /api/tools/* (server/tools.ts, Bearer 토큰) → 메시지·도구 요약 Event
        emit(공개 활동) → 허용 종류만 run.activity Event
    → db/runs.ts finishRun → run.finished Event → 쌓인 깨우기가 있으면 다음 실행 시도
```

깨우기가 실행 시도로 이어지지 않거나 같은 에이전트가 겹쳐 실행되면 `claimNextRun`과 `RunDispatcher.kick`에서, 조직 도구 거부는 `server/tools.ts`에서 시작합니다.

## 초기 연구 승인의 연결 경로

```text
가짜 Lead(runtime/scripted.ts) → /api/tools/goal, /api/tools/initial-approval (server/tools.ts)
  → db/approvals.ts gateToolCall: core checkToolCall(Role·단계), 거부면 tool.refused Event
  → toolWrite: 실행 시도 잠금 → 조직 행 잠금 → 단계 재확인 → 목표 기록 / 하네스 라이브러리로 snapshot 고정한 승인 요청

approvals.tsx 결정 폼 → POST /api/organizations/:id/approvals/:approvalId/decision (server/app.ts)
  → server/approvals.ts → db/approvals.ts decideApproval
      조직 행 잠금 → pending 확인 → core planApprovalDecision → 조건부 결정
      → 작업자·사본·템플릿 사본·단계·Lead 깨우기·approval.decided Event (한 transaction)
  → EventHub.publish → RunDispatcher.kick(Lead) → claimNextRun이 사본으로 bundle 버전을 정함
```

결정이 두 번 적용되거나 팀이 일부만 생기면 `decideApproval`에서, 승인 전 도구가 열리면 core `toolRules`에서 시작합니다.

## 지도 갱신

- 작업의 진입점·책임 위치·검증 위치가 바뀌거나 새 기능이 구현되면 해당 행과 연결 경로를 같은 PR에서 갱신합니다.
- 검증 위치에는 존재하는 테스트와 확인하는 범위를 적습니다. 계획만 있는 테스트는 완료된 검증과 구분합니다.
- 큰 영역 때문에 한 작업을 찾는 데 무관한 내용을 많이 읽게 되면 그 영역을 별도 문서로 옮기고 이 표에서 연결합니다.
  아직 구현되지 않은 영역의 빈 문서를 미리 만들지는 않습니다.
