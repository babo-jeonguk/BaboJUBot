# Heartbeat·기억·서버 재시작 복구

통합 검증: [heartbeat API](../../../apps/server/test/heartbeat.test.ts), [기억 API](../../../apps/server/test/memory.test.ts), [재시작 복구 API](../../../apps/server/test/recovery.test.ts)(자식 서버 프로세스 SIGKILL, 단계를 바꾸는 쓰기 직후 재시작 포함), [heartbeat E2E](../../../apps/web/e2e/heartbeat.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| heartbeat 설정·간격 범위·다음 예정, 깨우기 사유 `heartbeat`, Event `agent.heartbeat_changed`·`agent.heartbeat`, 실행 시도 상태 `server_restart`·`run.finished.requeuedWakeIds` | [contracts/heartbeat.ts](../../../packages/contracts/src/heartbeat.ts), run.ts `agentDetailSchema`·`runEndReasonSchema`, event.ts | heartbeat API |
| 설정 변경 계획(끝난 조직 거부·같은 값 무변경·다음 예정), 지난 heartbeat 처리(쌓지 않음·downtime 합침·일시정지 중 보류) | [core/heartbeat.ts](../../../packages/core/src/heartbeat.ts) `planHeartbeatChange`·`planHeartbeat` | [core](../../../packages/core/src/heartbeat.test.ts) |
| 설정 저장(조직 → 에이전트 잠금), scheduler의 에이전트별 깨우기·다음 예정·Event 한 transaction, 대기 heartbeat 하나(부분 unique) | [db/heartbeat.ts](../../../packages/db/src/heartbeat.ts) `updateHeartbeat`·`runDueHeartbeats`; schema `agents.heartbeat_*`·`wakes_one_pending_heartbeat_per_agent` | heartbeat API |
| Role 기본 간격 | 하네스 `role.json` `heartbeatMinutes` → server/harness.ts `loadHarnessLibrary`·`leadRoleOf` → core `planOrganizationCreation`·`planWorker`(승인 snapshot의 `heartbeatMinutes`) → db rows.ts `agentRow` | heartbeat API |
| scheduler 수명(복구 뒤 시작·종료)·주기 확인·설정 API | [server/heartbeat.ts](../../../apps/server/src/heartbeat.ts) `HeartbeatScheduler`·`updateHeartbeat`, app.ts `PUT …/agents/:agentId/heartbeat`·`tickHeartbeats` | heartbeat API |
| 에이전트 상세 heartbeat 폼(고치는 동안 입력 유지·저장 실패·다음 heartbeat·일시정지 안내), 실행 시도 상세의 heartbeat 사유 | agents.tsx `HeartbeatSettings`·`WakeReasonRow`, api.ts `useUpdateHeartbeat`, activity.tsx | heartbeat E2E(다른 탭·390px·실패 시 입력 유지) |
| 기억 범위·출처를 실행 시도 신원에서 정함, Memory port | [contracts/memory.ts](../../../packages/contracts/src/memory.ts), [core/memory.ts](../../../packages/core/src/memory.ts) `MemoryPort`·`memoryScopeOf` | 기억 API |
| 기억 저장·최근순·글자 그대로의 회수, 같은 조직 범위·출처(복합 FK) | [db/memories.ts](../../../packages/db/src/memories.ts) `dbMemory`·`writeMemory`; schema `memories` | 기억 API |
| 모든 쓰기 도구의 같은 호출 키(`Idempotency-Key`)·한 번만 남는 효과 | contracts tools.ts `idempotencyKeyHeader`, db/tool-calls.ts `toolWrite`(`ToolCall.operation`)·schema `tool_operations`, server/tools.ts `operationOf`·`callOf`, runtime/scripted.ts 키 정하기 | [같은 호출 키 API](../../../apps/server/test/idempotency.test.ts), 기억 API, 재시작 복구 API |
| 서버 재시작 복구(종료·깨우기 복원·Event 한 transaction, 기존 취소 사유 보존), 정상 종료 때 같은 처리, 단계를 바꾼 쓰기 뒤 가짜 Lead의 이어 가기 | core/run.ts `planRunInterruption`, db/runs.ts `interruptRun`·`recoverInterruptedRuns`, server/dispatcher.ts `start`·`#execute`, runtime/scripted.ts `demoLeadScript` | [DB](../../../packages/db/src/runs.test.ts) `run termination`, 재시작 복구 API |
| 실행 시도가 받은 깨우기 기록(재전달 뒤에도 옛 상세·개수 유지) | schema `run_wakes`·migration 0008 backfill, db/runs.ts `claimNextRun`, run-reads.ts `selectRunWakes`, run-views.ts `wakeCount`(`runSummaryColumns`) | 재시작 복구 API |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
에이전트 상세 폼 → PUT /api/organizations/:id/agents/:agentId/heartbeat(app) → server/heartbeat
  → updateHeartbeat(조직 → 에이전트 잠금, core planHeartbeatChange) → 설정·다음 예정·Event → EventHub
HeartbeatScheduler.tick(주입 시계) → runDueHeartbeats(에이전트마다: 조직 FOR SHARE → 에이전트, core planHeartbeat)
  → heartbeat 깨우기·다음 예정·agent.heartbeat → EventHub → dispatcher.kick → claimNextRun(다른 깨우기와 합침)
서버 시작 → dispatcher.start → recoverInterruptedRuns → interruptRun(실행 시도마다 core planRunInterruption)
  → server_restart·깨우기 복원·run.finished → 대기 깨우기 kick → scheduler 시작
```

중복 heartbeat는 `wakes_one_pending_heartbeat_per_agent`와 planHeartbeat의 대기 확인, 재전달된 입력의 옛 상세는 `run_wakes`, 되풀이된 쓰기는 `toolWrite`의 호출 키 확인에서 시작합니다.
