# Role·Soul·Skill 사본 편집

통합 검증: [사본 편집 API](../../../apps/server/test/instructions.test.ts), [사본 편집 E2E](../../../apps/web/e2e/instructions.spec.ts).

| 작업·증상 | 진입점 | 테스트 |
| --- | --- | --- |
| 사본·revision·편집 입력, 깨우기 사유·Event | contracts/harness.ts `instructionCopySchema`·`instructionRevisionSchema`·`editInstructionCopyInputSchema`, run.ts `instruction_edit`, event.ts `instruction_copy.edited` | 사본 편집 API |
| 편집 거부·revision·Lead 깨우기 계획 | core/harness.ts `planInstructionEdit` | [core](../../../packages/core/src/harness.test.ts) |
| 사본·revision 저장과 조회 | db/harness.ts `editInstructionCopy`·`insertInstructionCopies`·`listInstructionRevisions`·`findInstructionRevision`; migration 0009 | 사본 편집 API |
| 편집 API·본문 크기 상한 | server/app.ts `/agents/:agentId/instructions/:copyId`·`jsonBodyLimitBytes` | 사본 편집 API |
| 편집 뒤 다음 실행 시도의 bundle·새 세션 | db/runs.ts `claimNextRun`, core/run.ts `planRunStart` | 사본 편집 API |
| 사본 편집기·revision 목록·이동 차단 | agents.tsx `InstructionCopies`·`RevisionList`·`RevisionView`, api.ts `useEditInstructionCopy`·`useInstructionRevisions`, main.tsx `useBlocker` | 사본 편집 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
사본 편집기 → PUT /api/organizations/:id/agents/:agentId/instructions/:copyId(app)
  → editInstructionCopy(core planInstructionEdit) → instruction_copy.edited → EventHub → kick(Lead)
다음 claimNextRun → 사본 내용 bundle 버전 → core planRunStart가 세션 이어 가기 판정
```

충돌·종료 거부는 core/harness.ts `planInstructionEdit`, 다른 조직 404는 db/harness.ts의 범위 조건과 복합 FK에서 시작합니다.
