# 초기 연구 승인·하네스

통합 검증: [승인 API](../../../apps/server/test/approvals.test.ts), [승인 프로바이더 API](../../../apps/server/test/approval-providers.test.ts), [초기 승인 E2E](../../../apps/web/e2e/initial-approval.spec.ts).

| 작업·증상                                          | 진입점                                                                                                                                                                                                                           | 테스트                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 목표·승인 요청·결정·사본 계약                      | [contracts/approval.ts](../../../packages/contracts/src/approval.ts), [harness.ts](../../../packages/contracts/src/harness.ts), event.ts, tools.ts `orgTools`                                                                    | 승인 API                                                                                     |
| Role·단계 도구 판정, 승인 요청 snapshot, 결정 효과 | [core/approval.ts](../../../packages/core/src/approval.ts) `checkToolCall`·`buildInitialResearchProposal`·`planApprovalDecision`; 응답 코드는 server/problems.ts                                                                 | [core](../../../packages/core/src/approval.test.ts), 승인 API                                |
| bundle 버전·frontmatter                            | [core/harness.ts](../../../packages/core/src/harness.ts)                                                                                                                                                                         | [core](../../../packages/core/src/harness.test.ts)                                           |
| 하네스 라이브러리 읽기·Lead Role                   | [harness 안내](../../../harness/README.md), [server/harness.ts](../../../apps/server/src/harness.ts) `loadHarnessLibrary`                                                                                                        | 승인 API                                                                                     |
| 승인 요청 전 Lead 환경 점검 지침                   | harness/roles/lead/role.json, harness/skills/check-research-environment                                                                                                                                                          | 승인 API(Lead 사본), 초기 승인 E2E(환경 명세 표)                                             |
| 거부 Event·전이 경합·결정 단일 적용                | [db/tool-calls.ts](../../../packages/db/src/tool-calls.ts) `gateToolCall`·`toolWrite`, [db/approvals.ts](../../../packages/db/src/approvals.ts) `decideApproval`, [rows.ts](../../../packages/db/src/rows.ts) `lockOrganization` | 승인 API                                                                                     |
| 에이전트·조직 템플릿 사본, admission bundle 버전   | [db/harness.ts](../../../packages/db/src/harness.ts), db/runs.ts `claimNextRun`, run-reads.ts `selectWakes`                                                                                                                      | 승인 API                                                                                     |
| 결정 API·작업자별 모델 확인                        | server/app.ts, server/user-actions.ts `decideApproval`, server/providers.ts `modelsFor`, server/tools.ts                                                                                                                                                                  | 승인 API, 승인 프로바이더 API                                                                |
| 가짜 Lead의 승인 요청·재제출                       | runtime/scripted.ts `demoLeadScript`·`demoProposal`                                                                                                                                                                              | 가짜 프로바이더 테스트                                                                       |
| 결정 폼·작업자 표·완료 기준 제안                   | [web/approvals.tsx](../../../apps/web/src/approvals.tsx) `WorkerChoiceTable`·`DecidedWorkerTable`·`ProposedCriteria`, [worker-choices.ts](../../../apps/web/src/worker-choices.ts), pages.tsx `OrganizationDashboard`            | 초기 승인 E2E, [작업자 프로바이더 E2E](../../../apps/web/e2e/worker-provider-choice.spec.ts) |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
scripted(생성 깨우기) → /api/tools/initial-approval(server/tools; 예전 조직은 먼저 /api/tools/goal)
  → gateToolCall(core checkToolCall; 거부 시 tool.refused) → toolWrite → 승인 요청
결정 폼·채널 답 → POST /api/organizations/:id/approvals/:approvalId/decision(app)·channelInlet → user-actions decideApproval(작업자별 모델이 있으면 modelsFor)
  → decideApproval(core planApprovalDecision) → 작업자·사본·단계·Lead 깨우기·approval.decided
  → EventHub → kick → claim 때 사본의 bundle 버전
```

중복 결정·부분 팀 생성은 `decideApproval`, 승인 전 도구 노출은 contracts `orgTools`와 core `checkToolCall`에서 시작합니다.
