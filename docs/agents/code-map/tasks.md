# 작업·작업자 실행 시도·산출물

통합 검증: [작업 API](../../../apps/server/test/tasks.test.ts), [작업 화면 E2E](../../../apps/web/e2e/tasks.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 작업·댓글·산출물·에이전트 간 메시지 입력과 조회 모양, 깨우기 사유·Event | [contracts/task.ts](../../../packages/contracts/src/task.ts), run.ts `wakeReasonSchema`, event.ts, 도구 이름·경로·오류 코드는 tools.ts | 작업 API |
| 깨울 에이전트(부모 담당자·생성자·담당자·수신자, 자기 자신 제외)·착수/완료 권한·중복 완료 | [core/task.ts](../../../packages/core/src/task.ts); 단계 규칙은 contracts tools.ts `orgTools` | [core](../../../packages/core/src/task.test.ts), 작업 API |
| 같은 조직 참조 확인·기록과 깨우기·Event의 한 transaction·조건부 완료 | [db/tasks.ts](../../../packages/db/src/tasks.ts), [db/tool-calls.ts](../../../packages/db/src/tool-calls.ts) `toolWrite`(조직→실행 시도 잠금·취소·단계 재확인); 복합 FK는 schema·migrations | 작업 API의 교차 조직·중복 완료 |
| 깨우기 사유 읽기·실행 맥락의 팀 | db/run-reads.ts `selectWakes`, runs.ts `loadRunContext` | 작업 API, 실행 API |
| 작업 도구 HTTP·거부 코드·commit 뒤 깨운 에이전트 촉진 | server/tools.ts `respondWrite`; 사용자 댓글은 app.ts·db/tasks.ts `insertOwnerTaskComment` | 작업 API |
| 가짜 Lead 분담·가짜 작업자 착수→산출물→완료·댓글 답장 | runtime/scripted.ts `demoLeadScript`·`demoWorkerScript` | 가짜 프로바이더 테스트, 작업 화면 E2E |
| 작업 목록·상세·댓글 입력·산출물 단건·이동 경로 | [web/tasks.tsx](../../../apps/web/src/tasks.tsx), main.tsx routes, shell.tsx 경로 표시; api.ts query key | 작업 화면 E2E(390px·댓글 실패 시 입력 유지 포함) |
| 파일 산출물 등록·내용 고정·경로 경계·거부 이유 | server/workspace.ts `Workspaces.readArtifact`·`pinnedReader`(별도 프로세스가 폴더를 고정하고 조직 표식을 대조한 뒤 읽음, 거부마다 종료 코드 `readerExit`), contracts/task.ts `recordArtifactInputSchema`·`ArtifactFileRead`·`artifactFileRefusals`, contracts/tools.ts `orgToolErrorMessages`, db/tasks.ts `recordArtifact`(거부를 `invalid`로), server/problems.ts, migration 0024 | [파일 통합](../../../apps/server/test/file-artifacts.test.ts): 변경·삭제·재호출·경계·빈 파일·재시작·이유별 거부 코드·절대 경로. [경로 경계](../../../apps/server/test/workspace.test.ts)·[단계별 바꿔치기](../../../apps/server/test/workspace-race.test.ts)는 macOS·Windows CI에서도 돈다 |
| 조직 산출물 목록·파일명 tooltip·파일 메타데이터 | db/tasks.ts `listArtifacts`, server/app.ts `/artifacts`, web/tasks.tsx `ArtifactsScreen`·`ArtifactList`, web/artifact-file.tsx | [파일 E2E](../../../apps/web/e2e/file-artifacts.spec.ts): 화면 응답 fixture, 390px·키보드 tooltip·단건 |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
scripted(Lead) → /api/tools/tasks(server/tools) → toolWrite(조직→실행 시도 잠금·취소·단계 재확인)
  → db createTask(담당·부모 같은 조직 확인, core planTaskCreation) → 작업·담당자 깨우기·Event 함께 저장
  → EventHub → dispatcher.kick(담당자) → claimNextRun → scripted(작업자)
      → /tasks/:id/start → /artifacts → /tasks/:id/complete(core planTaskCompletion·조건부 완료)
      → 부모 담당자 또는 생성자 깨우기 → kick → 그 에이전트의 실행 시도
작업 상세 댓글 → POST /api/organizations/:id/tasks/:taskId/comments(app)
  → insertOwnerTaskComment(댓글·담당자 깨우기·Event) → kick(담당자)
```

깨우지 않은 할당·완료는 core/task.ts의 대상 선택, 다른 조직 참조는 db/tasks.ts의 확인과 복합 FK에서 시작합니다.
