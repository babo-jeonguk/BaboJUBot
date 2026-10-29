# 에이전트 조직도·이름·얼굴

통합 검증: [에이전트 이름·얼굴 API](../../../apps/server/test/agents.test.ts), [조직도 E2E](../../../apps/web/e2e/org-chart.spec.ts)(다른 탭·390px·움직임 줄이기).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 이름 규칙(trim·1~40자·제어 문자 거부)·얼굴 프리셋·ID에서 정한 기본 얼굴·변경 입력, Event `agent.profile_changed`, `Agent`·`AgentDetail`의 `appearance` | [contracts/agent-profile.ts](../../../packages/contracts/src/agent-profile.ts) `agentNameSchema`·`agentAppearanceSchema`·`defaultAgentAppearance`·`updateAgentProfileInputSchema`, event.ts, organization.ts `agentSchema` | [core](../../../packages/core/src/agent-profile.test.ts) `defaultAgentAppearance` |
| 바뀐 항목만 저장·Event, 같은 값 무변경, 같은 조직 이름 겹침(대소문자 무시, 자기 이름 대소문자 바꾸기는 허용) — 이름 바꾸기와 작업자 만들기(초기 팀 승인·작업자 추가)가 같은 규칙 | [core/agent-profile.ts](../../../packages/core/src/agent-profile.ts) `agentNameKey`·`isAgentNameTaken`·`planAgentProfileChange`, core/worker.ts `nextWorkerName`(db rows.ts `agentNamesOf`로 조직 모든 이름) | core, 이름·얼굴 API의 이름 바꾼 뒤 작업자 만들기 |
| 저장(조직 → 에이전트 잠금 아래 다른 이름 읽기, 작업자 추가·승인 결정과 직렬화, unique index 위반도 `name_taken`)·다른 조직 `not_found`, 저장 얼굴이 없거나 옛 값이면 기본 얼굴 | [db/agents.ts](../../../packages/db/src/agents.ts) `updateAgentProfile`, rows.ts `toAgent`·`violatesUnique`; schema `agents.appearance`(migration 0013)·`agents_organization_name_unique`(조직, `lower(name)`; migration 0017이 겹친 이름을 먼저 풂) | [DB](../../../packages/db/src/organizations.test.ts) `agent names`(동시 이름 바꾸기·잠금 밖 쓰기·migration 0017) |
| API(404·409 `name_taken`·422)·commit 뒤 Event, 조직 생성 응답의 기본 얼굴 | app.ts `PATCH …/agents/:agentId`·`POST /api/organizations`, db/agents.ts `updateAgentProfile`·db/organizations.ts `insertOrganizationCreation` | 이름·얼굴 API(다음 실행 시도 팀 맥락의 새 이름 포함) |
| 조직도 배치(넓으면 위→아래 나무·끌기·확대·한눈에 보기, 좁으면 들여 쌓기)·카드 링크·실행 중 연결 | [web/org-chart.tsx](../../../apps/web/src/org-chart.tsx)(agents.tsx `AgentsScreen`이 lazy로 불러옴), org-chart.css, api.ts `useRunningRuns` | 조직도 E2E |
| 얼굴 그리기·깜빡임·포인터 따라보기(창 listener 하나)·상태별 표정·움직임 줄이기 | [web/agent-face.tsx](../../../apps/web/src/agent-face.tsx) `AgentFace`·`faceMoodOf`, agent-face.css | 조직도 E2E(따라보기·움직임 줄이기) |
| 상세 머리의 이름 바꾸기(Enter·포커스 이동 저장, Esc 취소)·얼굴 꾸미기 창, 활동 문장 | [web/agent-profile.tsx](../../../apps/web/src/agent-profile.tsx) `AgentNameEditor`·`FaceCustomizer`, api.ts `useUpdateAgentProfile`, activity.tsx | 조직도 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
상세 머리(이름 입력·얼굴 꾸미기 창) → PATCH /api/organizations/:id/agents/:agentId(app)
  → updateAgentProfile(조직 → 에이전트 잠금·같은 조직 다른 이름, core planAgentProfileChange) → 이름·appearance·Event
  → EventHub → 다른 탭 조직 재조회(조직도·사이드바·이동 경로) / 다음 실행 시도의 runContext.team
```

이름 겹침은 `planAgentProfileChange`의 `otherNames`, 얼굴이 기본으로 돌아가는 증상은 rows.ts `toAgent`의 프리셋 검사에서 시작합니다.
