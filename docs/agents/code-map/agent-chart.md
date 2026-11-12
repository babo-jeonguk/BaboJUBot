# 에이전트 조직도·이름·얼굴

통합 검증: [에이전트 이름·얼굴 API](../../../apps/server/test/agents.test.ts), [조직도 E2E](../../../apps/web/e2e/org-chart.spec.ts).

| 작업·증상 | 진입점 | 테스트 |
| --- | --- | --- |
| 이름 규칙·얼굴 프리셋·기본 얼굴·변경 입력, Event `agent.profile_changed` | [contracts/agent-profile.ts](../../../packages/contracts/src/agent-profile.ts) `agentNameSchema`·`agentAppearanceSchema`·`defaultAgentAppearance`, event.ts | [core](../../../packages/core/src/agent-profile.test.ts) |
| 이름 겹침·변경 계획(작업자 만들기와 같은 규칙) | [core/agent-profile.ts](../../../packages/core/src/agent-profile.ts) `isAgentNameTaken`·`planAgentProfileChange`, core/worker.ts `nextWorkerName` | core |
| 저장·기본 얼굴로 되돌아감 | [db/agents.ts](../../../packages/db/src/agents.ts) `updateAgentProfile`, rows.ts `toAgent`·`agentNamesOf`; migration 0013·0017 | [DB](../../../packages/db/src/organizations.test.ts) `agent names` |
| 이름·얼굴 API | app.ts `PATCH …/agents/:agentId` | 이름·얼굴 API |
| 조직도 배치·카드·실행 중 연결 | [web/org-chart.tsx](../../../apps/web/src/org-chart.tsx), org-chart.css, agents.tsx `AgentsScreen` | 조직도 E2E |
| 조직도 접근 이름·안내 | org-chart.tsx `chartHelp` | [접근성 E2E](../../../apps/web/e2e/keyboard-a11y.spec.ts) |
| 조직도의 글 대체 | agents.tsx `OrgChartText` | [접근성 E2E](../../../apps/web/e2e/keyboard-a11y.spec.ts) |
| 얼굴 그리기·표정·움직임 줄이기 | [web/agent-face.tsx](../../../apps/web/src/agent-face.tsx) `AgentFace`·`faceMoodOf`, agent-face.css | 조직도 E2E |
| 이름 바꾸기·얼굴 꾸미기 창 | [web/agent-profile.tsx](../../../apps/web/src/agent-profile.tsx) `AgentNameEditor`·`FaceCustomizer`, api.ts `useUpdateAgentProfile` | 조직도 E2E, 이름 칸 오류는 접근성 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
상세 머리 → PATCH /api/organizations/:id/agents/:agentId(app)
  → updateAgentProfile(core planAgentProfileChange) → EventHub → 다른 탭 재조회 / 다음 실행 시도의 runContext.team
```

이름 겹침은 `planAgentProfileChange`, 얼굴이 기본으로 돌아가는 증상은 rows.ts `toAgent`에서 시작합니다.
