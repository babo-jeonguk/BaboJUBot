# 결과 제출·최종 완료

통합 검증: [결과 API](../../../apps/server/test/results.test.ts), [결과 검토 E2E](../../../apps/web/e2e/result-review.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 제출 입력·결정 입력·제출 상세/목록 모양, Inbox 항목 종류, 깨우기 사유 `result_changes_requested`·Event `result.*` | [contracts/result.ts](../../../packages/contracts/src/result.ts), [inbox.ts](../../../packages/contracts/src/inbox.ts), run.ts, event.ts, 도구 `submit_result`는 tools.ts | 결과 API |
| 제출(검토 기준 고정)·결정 효과(단계·Lead 깨우기)·Lead만 `연구 진행`에서 제출 | [core/result.ts](../../../packages/core/src/result.ts); 도구 규칙은 contracts tools.ts `orgTools` | 결과 API |
| admission을 막는 단계(최종 완료·일시정지·중단) | core/run.ts `admitsRuns`·`runBlockingStages` → db/runs.ts `claimNextRun`(조직 `FOR SHARE` → 에이전트 잠금)·`listAgentsWithPendingWakes` | [DB 잠금 순서](../../../packages/db/src/runs.test.ts) `admission and organization stage`, 결과 API 재시작 |
| 같은 조직 근거 확인·제출과 단계·Event 한 transaction, 결정 단일 적용·옛 제출 409 | [db/results.ts](../../../packages/db/src/results.ts) `submitResult`(toolWrite)·`decideResult`(조직 잠금·pending 조건부); 복합 FK는 schema·migrations | 결과 API 동시 결정·교차 조직 |
| Inbox 조회(승인 요청·결과 제출·실패한 실행 시도) | [db/inbox.ts](../../../packages/db/src/inbox.ts) `listInbox` | 결과 API, 승인 API, 알림 API |
| 결정 명령·조회 API·commit 뒤 Lead 촉진 | server/app.ts `/results`, db/results.ts `decideResult`; 도구 handler는 server/tools.ts | 결과 API |
| 가짜 Lead의 `결과 제출` 부탁 → 제출, 수정 요청 → 재제출 | runtime/scripted.ts `demoLeadScript`·`submitResultScript`(`then` 단계) | 결과 API `demo Lead result submission` |
| 결과 검토 목록·상세·결정 폼/기록·Inbox 항목·대시보드 안내 | [web/results.tsx](../../../apps/web/src/results.tsx), inbox.tsx `InboxPanel`, pages.tsx, api.ts `useDecideResult` | 결과 검토 E2E(390px·실패 시 의견 유지·다른 탭 결정 포함) |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
scripted(Lead) → /api/tools/results(server/tools) → submitResult(toolWrite: 조직→실행 시도 잠금·취소·단계 재확인)
  → 같은 조직 산출물 확인 → core planResultSubmission → 제출·근거·결과 검토 중·result.submitted 함께 저장
결정 폼 → POST /api/organizations/:id/results/:submissionId/decision(app)
  → decideResult(조직 잠금·pending·core planResultDecision·조건부 결정)
  → 단계·(수정 요청이면) Lead 깨우기·result.decided 함께 저장 → EventHub → kick(Lead)
최종 완료 뒤 깨우기 → claimNextRun(조직 FOR SHARE·admitsRuns) → 실행 시도 없음, 깨우기는 남음
```

완료 뒤 실행 시도가 생기면 `admitsRuns`와 claim의 잠금 순서, 중복 결정은 decideResult의 pending 조건에서 시작합니다.
