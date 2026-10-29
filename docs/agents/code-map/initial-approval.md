# 초기 연구 승인·하네스

통합 검증: [승인 API](../../../apps/server/test/approvals.test.ts), [초기 승인 E2E](../../../apps/web/e2e/initial-approval.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 목표(예전 조직)·승인 요청(Lead 제안 완료 기준)/결정·사본·Inbox | [contracts/approval.ts](../../../packages/contracts/src/approval.ts), [harness.ts](../../../packages/contracts/src/harness.ts); event.ts, 도구 한 줄은 tools.ts `orgTools` | 승인 API |
| Role/단계 도구 판정·snapshot(완료 기준 제안 필수·사용자 기준 변경 거부)·결정 효과(승인한 제안을 조직 완료 기준으로) | [core/approval.ts](../../../packages/core/src/approval.ts) `checkToolCall`(Role·단계 데이터는 contracts `orgTools`)·`buildInitialResearchProposal`·`planApprovalDecision`; 응답 코드는 server/problems.ts | [core](../../../packages/core/src/approval.test.ts), 승인 API |
| bundle 버전 직렬화·frontmatter·UTF-8 | [core/harness.ts](../../../packages/core/src/harness.ts) | [core](../../../packages/core/src/harness.test.ts) |
| 라이브러리 구조·읽기 실패·Lead Role | [harness 안내](../../../harness/README.md), [server/harness.ts](../../../apps/server/src/harness.ts) `loadHarnessLibrary` | 승인 API에서 라이브러리와 사본 비교 |
| 거부 Event·전이 경합·결정 단일 적용/rollback | [db/tool-calls.ts](../../../packages/db/src/tool-calls.ts) `gateToolCall`·`toolWrite`, [db/approvals.ts](../../../packages/db/src/approvals.ts) `decideApproval`; [rows.ts](../../../packages/db/src/rows.ts) `lockOrganization` | 승인 API 동시 결정·거부 기록 |
| 에이전트/조직 템플릿 사본·admission bundle 버전 | [db/harness.ts](../../../packages/db/src/harness.ts), db/runs.ts `claimNextRun`, run-reads.ts `selectWakes` | DB 조직 저장 테스트, 승인 API |
| 결정 명령·Inbox·요청/사본 조회 API | server/app.ts, db/approvals.ts `decideApproval`; 도구 handler는 server/tools.ts | 승인 API |
| 가짜 Lead 생성 깨우기→승인 요청(완료 기준이 없으면 `demoCompletionCriteria` 제안)→재제출, 예전 조직의 목표 메시지 | runtime/scripted.ts `demoLeadScript`·`demoProposal` | 가짜 실행기 테스트 |
| 결정 폼·`Lead 제안` 완료 기준(`ProposedCriteria`, Inbox 상세와 공유)·조직 대시보드·팀 | [web/approvals.tsx](../../../apps/web/src/approvals.tsx), pages.tsx `OrganizationDashboard`; Inbox 패널은 [알림 outbox·가짜 채널·Inbox](notifications.md) | 초기 승인 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
scripted(생성 깨우기) → /api/tools/initial-approval(server/tools; 예전 조직은 먼저 /api/tools/goal)
  → gateToolCall(core checkToolCall; 거부 시 tool.refused)
  → toolWrite(조직→실행 시도 잠금·취소·단계 재확인) → 완료 기준 규칙·라이브러리 snapshot 승인 요청
결정 폼 → POST /api/organizations/:id/approvals/:approvalId/decision(app)
  → decideApproval(조직 잠금·pending·core planApprovalDecision·조건부 결정)
  → 작업자·사본·템플릿·단계·승인한 Lead 제안 완료 기준·Lead 깨우기·approval.decided 함께 저장
  → EventHub → kick → claim 시 사본의 bundle 버전
```

중복 결정·부분 팀 생성은 decideApproval, 승인 전 도구 노출은 contracts `orgTools`의 Role·단계 데이터와 core `checkToolCall`에서 시작합니다.
