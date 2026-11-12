# 승인 정책·작업자 추가

통합 검증: [작업자 추가 API](../../../apps/server/test/workers.test.ts), [작업자 승인 정책 E2E](../../../apps/web/e2e/worker-approval-policy.spec.ts).

| 작업·증상                                                                                              | 진입점                                                                                                                                                                                                     | 테스트                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 정책·작업자 추가 입력과 결과, 종류별 결정, Event `organization.approval_policy_changed`·`worker.added` | [contracts/organization.ts](../../../packages/contracts/src/organization.ts) `approvalPolicyItems`, contracts/approval.ts `approvalKindDecisions`, event.ts                                                | 작업자 추가 API                                                                                     |
| 정책 분기·작업자 이름 번호·종류별 결정 효과                                                            | [core/worker.ts](../../../packages/core/src/worker.ts) `buildAddWorkerProposal`·`planAddWorker`·`nextWorkerName`, core/approval.ts `planApprovalDecision`, core/organization.ts `planApprovalPolicyChange` | [core](../../../packages/core/src/worker.test.ts)                                                   |
| 정책 저장·도구 쓰기 안의 최신 정책·Lead 실행 맥락의 정책                                               | db/organizations.ts `updateApprovalPolicy`, [db/workers.ts](../../../packages/db/src/workers.ts) `addWorker`, db/approvals.ts `decideApproval`, runs.ts `loadRunContext`                                   | 작업자 추가 API                                                                                     |
| 정책 API·도구 HTTP·`decision_not_allowed`                                                              | server/app.ts `/approval-policy`, server/tools.ts `add_worker`                                                                                                                                             | 작업자 추가 API                                                                                     |
| 가짜 Lead의 작업자 추가 부탁                                                                           | runtime/scripted.ts `demoLeadScript`·`addWorkerScript`                                                                                                                                                     | 가짜 프로바이더 테스트                                                                              |
| 정책 스위치·종류별 승인 상세·결정 폼                                                                   | [web/settings.tsx](../../../apps/web/src/settings.tsx), approvals.tsx, pages.tsx, api.ts `useUpdateApprovalPolicy`                                                                                         | 작업자 승인 정책 E2E, [작업자 프로바이더 E2E](../../../apps/web/e2e/worker-provider-choice.spec.ts) |
| `GitHub에 올리기`를 지키는 Lead 지침                                                                   | [harness/roles/lead/AGENTS.md](../../../harness/roles/lead/AGENTS.md)                                                                                                                                      | —                                                                                                   |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
설정 스위치 → PUT /api/organizations/:id/approval-policy(app) → updateApprovalPolicy(core planApprovalPolicyChange) → EventHub
scripted(Lead) → /api/tools/workers(server/tools) → addWorker(toolWrite, core buildAddWorkerProposal·planAddWorker)
  → 꺼짐: 작업자·사본·worker.added(201) / 켜짐: 승인 요청·approval.requested(202)
결정 폼 → decideApproval → 작업자·사본(승인만)·Lead 깨우기·approval.decided
```

정책 경합은 `addWorker`의 잠금 아래 정책 읽기, 승인 전 작업자 생성은 `planAddWorker`의 분기에서 시작합니다.
