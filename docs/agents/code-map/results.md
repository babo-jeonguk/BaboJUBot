# 결과 제출·최종 완료

통합 검증: [결과 API](../../../apps/server/test/results.test.ts), [결과 검토 E2E](../../../apps/web/e2e/result-review.spec.ts).

| 작업·증상 | 진입점 | 테스트 |
| --- | --- | --- |
| 제출·결정 입력, 제출 상세·목록, 깨우기 사유·Event `result.*` | [contracts/result.ts](../../../packages/contracts/src/result.ts), [inbox.ts](../../../packages/contracts/src/inbox.ts), run.ts, event.ts, tools.ts `submit_result` | 결과 API |
| 제출·결정 효과 | [core/result.ts](../../../packages/core/src/result.ts) `planResultSubmission`·`planResultDecision`; 도구 규칙은 contracts tools.ts `orgTools` | 결과 API |
| 최종 완료·일시정지·중단 뒤 실행 시도가 생김 | core/run.ts `admitsRuns`·`runBlockingStages`, db/runs.ts `claimNextRun`·`listAgentsWithPendingWakes` | [DB](../../../packages/db/src/runs.test.ts) `admission and organization stage` |
| 제출·결정 저장, 옛 제출 409 | [db/results.ts](../../../packages/db/src/results.ts) `submitResult`·`decideResult` | 결과 API |
| Inbox 조회 | [db/inbox.ts](../../../packages/db/src/inbox.ts) `listInbox` | 결과 API, 알림 API |
| 결정 API | server/app.ts `/results`; 도구 handler는 server/tools.ts | 결과 API |
| 가짜 Lead 제출·재제출 | runtime/scripted.ts `demoLeadScript`·`submitResultScript` | 결과 API `demo Lead result submission` |
| 결과 검토 목록·상세·결정 폼 | [web/results.tsx](../../../apps/web/src/results.tsx), inbox.tsx `InboxPanel`, pages.tsx, api.ts `useDecideResult` | 결과 검토 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
scripted(Lead) → /api/tools/results(server/tools) → submitResult(toolWrite, core planResultSubmission) → result.submitted
결정 폼 → POST /api/organizations/:id/results/:submissionId/decision(app)
  → decideResult(core planResultDecision) → result.decided → EventHub → kick(Lead)
최종 완료 뒤 깨우기 → claimNextRun(admitsRuns) → 실행 시도 없음
```

완료 뒤 실행 시도가 생기면 `admitsRuns`와 claim의 잠금 순서, 중복 결정은 `decideResult`의 pending 조건에서 시작합니다.
