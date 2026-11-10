# Heartbeat·기억·서버 재시작 복구

통합 검증: [heartbeat API](../../../apps/server/test/heartbeat.test.ts), [기억 API](../../../apps/server/test/memory.test.ts), [재시작 복구 API](../../../apps/server/test/recovery.test.ts), [heartbeat E2E](../../../apps/web/e2e/heartbeat.spec.ts).

| 작업·증상 | 진입점 | 테스트 |
| --- | --- | --- |
| heartbeat 설정·깨우기 사유·Event, 종료 사유 `server_restart` | [contracts/heartbeat.ts](../../../packages/contracts/src/heartbeat.ts), run.ts `runEndReasonSchema`, event.ts | heartbeat API |
| 설정 변경 계획·지난 heartbeat 처리 | [core/heartbeat.ts](../../../packages/core/src/heartbeat.ts) `planHeartbeatChange`·`planHeartbeat` | [core](../../../packages/core/src/heartbeat.test.ts) |
| 설정 저장·예정된 heartbeat 깨우기 | [db/heartbeat.ts](../../../packages/db/src/heartbeat.ts) `updateHeartbeat`·`runDueHeartbeats` | heartbeat API |
| Role 기본 간격 | 하네스 `role.json` `heartbeatMinutes` → server/harness.ts `loadHarnessLibrary` → core `planOrganizationCreation`·`planWorker` | heartbeat API |
| scheduler 수명·설정 API | [server/heartbeat.ts](../../../apps/server/src/heartbeat.ts) `HeartbeatScheduler`, app.ts `PUT …/agents/:agentId/heartbeat` | heartbeat API |
| heartbeat 폼·깨우기 사유 표시 | agents.tsx `HeartbeatSettings`·`WakeReasonRow`, api.ts `useUpdateHeartbeat` | heartbeat E2E |
| 기억 범위·출처 | [contracts/memory.ts](../../../packages/contracts/src/memory.ts), [core/memory.ts](../../../packages/core/src/memory.ts) `MemoryPort`·`memoryScopeOf` | 기억 API |
| 기억 저장·회수 | [db/memories.ts](../../../packages/db/src/memories.ts) `writeMemory` | 기억 API |
| 쓰기 도구의 같은 호출 키 | contracts tools.ts `idempotencyKeyHeader`, db/tool-calls.ts `toolWrite`, server/tools.ts `operationOf` | [같은 호출 키 API](../../../apps/server/test/idempotency.test.ts) |
| 서버 재시작·정상 종료 때 실행 시도 정리 | core/run.ts `planRunInterruption`, db/runs.ts `interruptRun`·`recoverInterruptedRuns`, conversations.ts `recoverInterruptedSteers`, dispatcher.ts `start` | [DB](../../../packages/db/src/runs.test.ts) `run termination`, 재시작 복구 API |
| 실행 시도가 받은 깨우기 기록 | db/run-reads.ts `selectRunWakes`, run-views.ts `wakeCount`; migration 0008 | 재시작 복구 API |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
에이전트 상세 폼 → PUT …/agents/:agentId/heartbeat(app) → updateHeartbeat(core planHeartbeatChange) → EventHub
HeartbeatScheduler.tick → runDueHeartbeats(core planHeartbeat) → EventHub → dispatcher.kick → claimNextRun
서버 시작 → dispatcher.start → recoverInterruptedRuns → interruptRun(core planRunInterruption) → kick → scheduler 시작
```

중복 heartbeat는 `wakes_one_pending_heartbeat_per_agent`와 `planHeartbeat`, 재전달된 입력의 옛 상세는 `run_wakes`, 되풀이된 쓰기는 `toolWrite`의 호출 키 확인에서 시작합니다.
