# Role·Soul·Skill 사본 편집

통합 검증: [사본 편집 API](../../../apps/server/test/instructions.test.ts), [사본 편집 E2E](../../../apps/web/e2e/instructions.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 사본 revision 번호·revision 모양·편집 입력·크기 상한, 깨우기 사유·Event | contracts/harness.ts `instructionCopySchema`·`instructionRevisionSchema`·`editInstructionCopyInputSchema`, run.ts `instruction_edit`, event.ts `instruction_copy.edited` | 사본 편집 API |
| 종료 조직·오래된 기준 revision·Skill frontmatter 거부, revision·Lead 깨우기·Event 계획 | core/harness.ts `planInstructionEdit` | [core](../../../packages/core/src/harness.test.ts) |
| 조직 잠금 아래 사본·revision·깨우기·Event 한 transaction, 교차 조직 404, 처음 사본의 revision 1 | db/harness.ts `editInstructionCopy`·`insertInstructionCopies`·`listInstructionRevisions`·`findInstructionRevision`; schema `instructionRevisions`(복합 FK)·migration 0009 | 사본 편집 API의 동시 저장·종료 조직 |
| 편집 API·거부 코드·commit 뒤 Lead 촉진·본문 크기 상한 | server/app.ts `/agents/:agentId/instructions/:copyId`, db/harness.ts `editInstructionCopy`, app.ts `jsonBodyLimitBytes` | 사본 편집 API |
| 편집 뒤 다음 실행 시도의 bundle·새 세션 | db/runs.ts `claimNextRun`(사본 내용으로 bundle) → core/run.ts `planRunStart`(세션을 만든 버전과 다르면 이어 가지 않음) | 사본 편집 API의 진행 중·다음 실행 시도 |
| 에이전트 상세 탭·사본 편집기·draft/충돌·이동 차단·revision 목록·예전 revision 보기 | agents.tsx `AgentDetailPage`·`InstructionCopies`·`RevisionList`·`RevisionView`, api.ts `useEditInstructionCopy`·`useInstructionRevisions`·`useInstructionRevision`; 이동 차단은 main.tsx data router의 `useBlocker` | 사본 편집 E2E(390px 다른 탭 포함), 초기 승인 E2E의 사본 독립 |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
사본 편집기(base revision·draft) → PUT /api/organizations/:id/agents/:agentId/instructions/:copyId(app)
  → editInstructionCopy(조직 잠금·조직/에이전트/사본 범위·core planInstructionEdit)
  → 사본·revision·Lead 깨우기·instruction_copy.edited 함께 저장 → EventHub → kick(Lead)
  → 다른 탭: 조직 Event → 사본·revision 목록 재조회(편집 중 draft는 그대로)
다음 claimNextRun(조직 FOR SHARE 뒤 사본 읽기) → 내용 bundle 버전 → 세션 자리의 세션을 만든 버전과 다르면 새 세션
```

충돌·종료 거부는 core/harness.ts `planInstructionEdit`, 다른 조직 404는 db/harness.ts의 범위 조건과 복합 FK에서 시작합니다.
