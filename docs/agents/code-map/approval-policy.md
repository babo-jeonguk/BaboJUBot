# 승인 정책·작업자 추가

통합 검증: [작업자 추가 API](../../../apps/server/test/workers.test.ts), [작업자 승인 정책 E2E](../../../apps/web/e2e/worker-approval-policy.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 정책 모양·기본값·변경 입력, 작업자 추가 입력·결과(`added`/`pending_approval`)·snapshot, 종류별 결정(`approvalKindDecisions`)·Event `organization.approval_policy_changed`·`worker.added` | [contracts/organization.ts](../../../packages/contracts/src/organization.ts), contracts/approval.ts, event.ts, run.ts `approval_decision.approvalKind` | 작업자 추가 API |
| 정책 분기·작업자 이름 번호(조직 모든 이름을 피함, `nextWorkerName`)·사본 계획, 종류별 결정 효과(작업자 추가는 단계 유지·수정 요청 없음) | [core/worker.ts](../../../packages/core/src/worker.ts), core/approval.ts `planApprovalDecision`, core/organization.ts `planApprovalPolicyChange` | [core](../../../packages/core/src/worker.test.ts) |
| 정책 저장(조직 잠금·같은 값 무변경)·도구 쓰기 안 최신 정책 읽기·결정 단일 적용 | db/organizations.ts `updateApprovalPolicy`, [db/workers.ts](../../../packages/db/src/workers.ts) `addWorker`(toolWrite), db/approvals.ts `decideApproval`; 초기 승인만 pending 하나(부분 unique)는 schema·migrations | 작업자 추가 API의 정책 경합·동시 결정 |
| 사용자 정책 명령·도구 HTTP(201/202)·결정 422 `decision_not_allowed` | server/app.ts `/approval-policy`, db/organizations.ts `updateApprovalPolicy`, server/tools.ts `add_worker` | 작업자 추가 API |
| 가짜 Lead의 `작업자 추가: <Role>` 부탁·작업자 추가 결정 답장 | runtime/scripted.ts `demoLeadScript`·`addWorkerScript` | 가짜 프로바이더 테스트, 작업자 추가 API |
| 설정 스위치(저장 중·실패·서버 값, 끌 수 없는 초기 연구 승인·최종 완료는 잠긴 스위치)·종류별 승인 상세·결정 폼·대시보드 대기 요청 | [web/settings.tsx](../../../apps/web/src/settings.tsx), approvals.tsx, pages.tsx, api.ts `useUpdateApprovalPolicy` | 작업자 승인 정책 E2E(다른 탭·390px 반영 포함) |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
설정 스위치 → PUT /api/organizations/:id/approval-policy(app)
  → updateApprovalPolicy(조직 잠금·core planApprovalPolicyChange) → 정책·Event → EventHub → 다른 탭 재조회
scripted(Lead) → /api/tools/workers(server/tools) → addWorker(toolWrite: 조직→실행 시도 잠금·취소·단계 재확인)
  → core buildAddWorkerProposal(라이브러리 snapshot) → planAddWorker(잠금 아래 최신 정책)
  → 꺼짐: 작업자·사본·worker.added(201) / 켜짐: 승인 요청·approval.requested(202, 단계 유지)
결정 폼 → decideApproval(조직 잠금·pending·종류별 결정) → 작업자·사본(승인만)·Lead 깨우기·approval.decided
```

정책 경합은 addWorker의 잠금 아래 정책 읽기, 승인 전 작업자 생성은 planAddWorker의 분기에서 시작합니다.
