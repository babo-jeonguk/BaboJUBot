# #211 구현 기록 — 변경 응답을 덮는 늦은 조회와 Lead 대화 E2E 대상

기준: `main` `34ad3d8`, 작업 브랜치 `fix/211-stale-fetch-over-mutation`. 요구는 [#211](https://github.com/babo-jeonguk/BaboJUBot/issues/211)의 Agent Brief(2026-11-17 사용자 결정: 이전 조회 버리기, 이번 경우만, 변경 응답을 캐시에 쓰는 모든 곳), 조사는 [issue-211-references.md](issue-211-references.md)다.

## 원문으로 다시 확인한 근거

| 근거 | 확인한 곳 | 적용 | 배제·차이 |
|---|---|---|---|
| `cancelQueries`는 기본 `revert: true`로 찾은 조회마다 `Query.cancel`을 부르고 그 끝을 기다린다 | 설치된 `@tanstack/query-core` 5.104.3 `src/queryClient.ts` `cancelQueries`, `src/query.ts` `cancel` | 공통 규칙이 `exact` key로 취소를 기다린 뒤 쓴다 | 조사 문서의 고정 SHA 원문과 설치본이 같다는 비교는 조사 문서를 따른다 |
| 취소하면 retryer가 그 자리에서 reject하고, 뒤에 온 조회 결과의 resolve는 무시한다. 취소 때 시작 전 상태로 되돌리고 fetchStatus를 idle로 둔다 | 같은 설치본 `src/retryer.ts` `cancel`·`resolve`(`isResolved`), `src/query.ts` `fetch`의 `onCancel`·`catch` | 조회 함수가 signal을 쓰지 않아도 늦은 결과가 버려진다. 처음 불러오는 중이던 key도 취소 뒤 쓴 값으로 success가 된다 | 데이터 없이 취소된 첫 조회의 promise는 `CancelledError`로 reject된다. 웹에서 그 promise를 직접 기다리는 곳(`fetchQuery`·`ensureQueryData`·suspense)이 없음을 검색으로 확인했다 |
| 서버 snapshot을 `route.fetch`로 받아 두고 나중에 `fulfill`한다 | 저장소의 기존 held route(`lead-chat.spec.ts`)와 조사 E10 | 다른 탭 시험이 옛 목록을 붙잡고, 보내는 중 시험이 목록·메시지 조회를 붙잡는다 | Playwright 문서는 다시 열지 않았다. 로컬 실행으로 동작을 확인했다 |
| locator를 영역으로 좁히고 `first()`·`nth()`로 우회하지 않는다 | 조사 E12·E14 | 입력창 `form` 안의 `전송 중…` status 하나를 찾고 같은 locator의 소멸을 본다 | Playwright·Testing Library 문서는 다시 열지 않았다 |

## 결정과 구현

- **공통 규칙**: `apps/web/src/mutation-cache.ts`의 `writeMutationResult(queryClient, queryKey, updater)`. 그 key의 진행 중 조회만(`exact`) 취소를 기다린 뒤 `setQueryData`와 같은 두 형태(값·갱신 함수)로 쓴다. 쓴 뒤 다시 불러오지 않는다.
- **적용**: `api.ts`의 `useCreateOrganization`(조직 상세·목록 병합), `useMarkConversationRead`, `useUpdateApprovalPolicy`, `useUpdateNetworkPolicy`, `useControlOrganization`, `useControlAgent`, `useUpdateHeartbeat`, 프로바이더 설정 변경 hook 셋(`useProviderSettingsMutation`)과 `useRecheckProvider`, `useUpdateAgentProvider`, `useUpdateAgentProfile`, `decisionCachePolicy`(`useDecideApproval`·`useDecideResult`). 무효화가 있는 hook은 쓰기를 기다린 뒤 지금과 같은 무효화를 부른다. 무효화가 먼저 시작한 새 조회를 쓰기의 취소가 버리지 않게 하려는 순서다.
- **제외**: `transcript-window.ts`의 이어받기(조회 응답을 cursor 비교 뒤 붙임)와 창 줄이기(로컬 캐시 자르기)는 변경 응답이 아니다. 시험 fixture의 `setQueryData`도 대상이 아니다. 구현 뒤 `apps/web/src`에서 `setQueryData`·`setQueriesData`를 다시 검색해 이 둘과 공통 규칙 안의 한 곳만 남은 것을 확인했다.
- **바꾸지 않은 것**: 각 hook의 반환 타입·무효화 범위, 실패 때 동작(`onSuccess`가 불리지 않음), 조회 함수의 signal 미사용.

## 검증 경계와 결과

| 경계 | 검사 | 결과(로컬 Linux, 2026-11-17) |
|---|---|---|
| 조회 시작 → 변경 응답 쓰기 → 옛 조회 도착 | `mutation-cache.test.ts` 실제 `QueryClient`·`QueryObserver`, deferred 응답 | 통과. 취소를 뺀 규칙으로는 이 시험과 처음 불러오는 중 시험 2건이 실패 |
| 진행 중 조회 없음·갱신 함수, 처음 불러오는 중, 같은 조직 하위 key·다른 조직 같은 종류 key | 같은 파일 나머지 3건 | 통과 |
| 다른 탭에서 대화 열기 | `lead-conversations.spec.ts:12` — 읽지 않음인 옛 목록을 받아 붙잡고, 읽음 PUT은 그 뒤에 서버로 보내며, 점이 사라진 뒤 놓아준다. 브라우저가 받은 뒤 화면 처리 기회를 주고 점이 없음을 본다 | 통과. `useMarkConversationRead`만 직접 `setQueryData`로 되돌리면 놓아준 뒤 점이 다시 1로 실패 |
| 보내는 중 초안 유지 | `lead-chat.spec.ts:5` — 대화 목록·메시지 조회를 붙잡아 두 칸의 `불러오는 중…`이 있는 채로 진행 | 통과. 화면 전체 `getByRole("status")`로 되돌리면 status 3개 strict mode 위반으로 실패(CI 실패와 같은 모양) |

E2E의 마지막 확인은 "놓아준 응답을 화면이 처리한 뒤"를 직접 관찰하지 못한다(버려진 응답은 화면에 흔적이 없다). 응답이 브라우저에 도착한 것(`requestfinished`)과 그 뒤 프레임·task 경계로 대신하고, 정확한 최종 캐시는 단위 시험이 본다. 로컬에서는 수정 없는 대조가 이 경계 안에서 실패했다.

## 미실행·한계

- Windows CI 결과는 PR에 적는다. 실제 모델·프로바이더는 쓰지 않았다(가짜 프로바이더 E2E).
- 막는 것은 먼저 출발한 조회의 늦은 덮어쓰기뿐이다. 읽음 PUT 응답끼리의 역전, 새 Event로 출발한 조회를 변경 응답이 취소한 뒤 그 Event의 변경이 다음 Event까지 늦게 보이는 경우는 이슈 범위 밖이다.
- 적용한 hook 가운데 읽음 처리 말고는 실제 경쟁을 재현하지 않았다(사용자 결정: 공통 규칙 하나를 모두 거치게 함).
