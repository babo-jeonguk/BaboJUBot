# #144 구현 기록 — 승인·결과 검토의 결정 표시와 캐시 갱신 공통화

기준: `main` `1fa3a27`, 작업 브랜치 `feat/144-decision-display`, 2026-11-16. 요구는 [#144](https://github.com/babo-jeonguk/BaboJUBot/issues/144) 본문이고, 조사 권고(D01–D09·V01–V14)는 [issue-144-references.md](issue-144-references.md)에 있다. 지금 동작은 [현재 구현 현황](../current-implementation.md)이 기준이다.

조사 기준 `983dbc5` 이후 바뀐 웹 소스는 `chat.tsx`·`dashboard.tsx`·`index.css`·`shell.tsx`이고, 결정 관련 파일(`approvals.tsx`·`results.tsx`·`api.ts`·`inbox-detail.tsx`·`ui.tsx`)은 같아서 E13–E16을 그대로 썼다.

## 권고 적용과 원문 확인

| 권고 | 적용 | 원문 확인 |
|---|---|---|
| D01·D09 | `decision.tsx` `DecisionArea`가 decidedHere를 갖고, 로컬 성공 callback만 `DecisionRecord`의 focus를 켠다. 결정 명령은 폼이 아니라 영역을 감싼 `ApprovalDecision`·`ResultDecision`에 둔다. 폼에 두면 응답 전에 Event가 도착해 폼이 언마운트될 때 per-call callback이 실행되지 않기 때문이다(V14 실패를 E2E로 재현한 뒤 수정함). 기록 focus는 포커스가 사라졌을 때만 옮겨, 그사이 사용자가 다른 곳으로 옮긴 포커스는 빼앗지 않는다 | 설치된 query-core 5.104.3 `src/mutationObserver.ts` 258행 `if (mutateOptions && this.hasListeners())`. per-call 옵션은 구독 중인 observer에만 전달된다 |
| D02·D03 | `api.ts` `decisionCachePolicy`: 성공 시 단건 setQueryData 뒤 조직 prefix·Inbox를 void invalidate하고, `already_decided`도 같은 범위를 refresh한다. 경로·메서드·schema는 각 hook에 남긴다 | E12·E14 재사용 |
| D04 | 의견·확인은 폼 로컬로 두고, 작업자 초안 Map과 성공 시 정리, 상세·Inbox의 key는 그대로 둔다. 명령은 key가 걸린 영역 안에 있어 항목이 바뀌면 함께 사라진다 | E14 |
| D06·D08 | `useInlineConfirm`·`focusFirstChoiceProblem`·`ProviderChoiceFields`는 그대로 쓴다. 공통 외곽(`DecisionFormFrame`)은 폼 전체 안내만 맡고, 선택 거부 문구는 승인 폼의 `describeError`로 넘긴다 | E15 |
| D07 | 안내 문구와 결정 가능 여부는 각 폼이 정한다. 결과 폼의 일시정지 안내를 `수정 요청하면 재개 · 최종 완료하면 연구 종료`로 바꿨다(core `planResultDecision`: request_changes→researching, complete→completed). `ui.tsx` `Block`의 `detail`·`inbox` variant는 스타일만 고른다 | 현재 소스 |

## 검증

새 E2E [`decision-display.spec.ts`](../../apps/web/e2e/decision-display.spec.ts)와 보강한 기존 E2E가 다음 V 항목을 실행한다.

- V01·V14: 응답을 gate로 막은 채 Event가 먼저 도착하면 기록으로 바뀌지만 focus는 아직 옮기지 않는다. 응답을 풀면 기록으로 focus가 가고 주소는 그대로다. 승인(상세)과 결과(상세)에서 확인한다. 수정 전 코드에서는 승인 시나리오가 응답을 푼 뒤 기록 focus 단언에서 실패했다.
- V02·V03: 다른 화면(Inbox 상세·결과 상세)에 있던 링크 focus가 Event 뒤에도 그대로인지 확인한다. 오래된 화면의 409 뒤 기록에 focus가 가지 않는지는 결과(새 E2E)와 승인([inbox.spec.ts](../../apps/web/e2e/inbox.spec.ts)에 단언 추가)에서 확인한다.
- V05: 상세·Inbox 상세 × 1280·390px에서 최종 완료 확인을 Escape·취소로 닫으면 트리거로 focus가 돌아가고 POST가 없다. 보내는 중에는 취소가 잠기고, 성공하면 기록에 focus가 간다([shell-focus.spec.ts](../../apps/web/e2e/shell-focus.spec.ts) 보강).
- V08·V09: 일시정지 안내와 효과(초기 승인은 재개, 작업자 추가는 유지, 결과는 수정 요청 시 재개·최종 완료 시 완료), 중단된 조직의 초기 승인·결과 잠금(상세·Inbox), 작업자 추가 허용.
- V13: 작업자 추가 승인의 응답을 붙잡은 채 Inbox에서 다음 요청으로 옮겨 사유를 쓴다. 늦은 응답이 도착해도 그 칸의 focus·초안이 그대로다.

결과 폼의 항목 전환(의견·완료 확인이 다른 제출로 넘어가지 않음)은 별도 E2E 없이 기존 key 경계에 맡긴다. 승인 사유의 항목 전환은 기존 Inbox E2E가 확인한다.
