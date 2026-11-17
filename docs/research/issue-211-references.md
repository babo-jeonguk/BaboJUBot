# issue-211 레퍼런스 조사: Lead 대화의 늦은 조회 덮어쓰기와 E2E 대상 식별

이 문서는 #211의 구현 전 근거와 선택지를 다룬다. 제품 범위는 [features](../features.md), 책임·불변 조건은 [architecture](../architecture.md)가 기준이다.

조사일: 2026-11-17. 대상: [#211](https://github.com/babo-jeonguk/BaboJUBot/issues/211). 기준 SHA: `34ad3d8afebddba279114e85c1a58a61ab3459b5`. 확정 계약이나 구현 결과가 아니다. 제품 코드·테스트·설정은 변경하지 않았고 커밋하지 않았다.

## Brief

- 문제: 읽음 PUT의 목록 응답을 캐시에 쓴 뒤, 먼저 출발한 GET이 늦게 도착해 unread를 되돌림. 별도로 전송 시험이 화면 전체의 status 세 개를 하나로 가정함.
- 동종 문제: 동일 캐시 key에 대한 조회와 변경의 완료 순서가 데이터의 논리 순서와 다른 경우, 오래된 결과의 적용을 막거나 후속 조회로 수렴시키는 메커니즘.
- 고정: triage가 제공한 trace 분석을 출발점으로 사용했다. 목록 GET 155354.1→155376.2(unread true), PUT 155366.3→155374.7(false). trace를 다시 분석하지 않았다. history 시험은 1d65df0/#198에서 해결되어 제외한다. 가짜 프로바이더 문제가 아닌 화면 경쟁이다.
- 승인·조직 경계·최종 완료 규칙은 변경 대상이 아니다. 실제 모델·계정·비용을 쓰지 않는다. 수정 방향은 사용자 결정으로 남긴다.
- 이슈 본문·댓글 조회 완료(댓글 없음). parent API 404(no parent), blocker 빈 배열. 제품 정의는 GLOSSARY의 대화·받은 순서·Event에 따른다.

| ID | 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 변경보다 먼저 시작한 GET의 늦은 덮어쓰기를 어떻게 막는가? 설치 TanStack 판의 취소/재조회 동작은? | triage 전달 Q1, #211 unread 실패 | Source Recon + runtime/failure, 라이브러리·채팅 제품 비교 |
| Q2 | 시간에 기대지 않고 순서 경쟁을 재현하는 시험은? | triage Q2 | 공식 route 문서 + 기존 gate 소스 + deferred QueryClient 실행 |
| Q3 | 여러 로딩/status 중 시험 대상을 하나로 정하는 방법은? | triage Q3, #211 strict mode | 공식 locator/role/within 문서 + 현재 DOM 소스 |
| Q4 | 같은 형태의 다른 캐시 쓰기 후보는? | triage Q4 | apps/web/src 전체 setQueryData 검색, 조회 key·후속 invalidate 추적 |

| 기존 조사 | 재사용 범위 | 재확인 |
|---|---|---|
| [#144 캐시 정책 조사](issue-144-references.md#근거) | TanStack 5.104.3 고정 SHA 탐색·void invalidate 정책 맥락 | queryClient.ts/query.ts/retryer.ts 원문 재열람. 각 파일의 설치 src와 그 SHA를 byte 비교하여 모두 동일. upstream 최신과 같다는 뜻은 아님. 과거 probe는 신규 실행으로 세지 않음 |
| [#189 조사](issue-189-references.md) | Windows E2E 환경 후보 | 서버 종료 문제로 이번 응답 순서/locator 판단에는 재사용하지 않음 |
| 57746db 읽기 순서 시험 | gate/reached/release, 완료 여부와 사건 순서 assertion | 고정 commit 소스 확인; 실행은 안 함 |

- [x] 1 Brief
- [x] 2 Discovery
- [x] 3 Recon
- [x] 4 Synthesis
- [x] 5 Receipt — [댓글 게시](https://github.com/babo-jeonguk/BaboJUBot/issues/211#issuecomment-6940608354) 후 원문과 일치 확인.

## 레퍼런스

설계 참고만 하며 외부 코드를 복사하지 않는다. SHA는 조사 시점 고정본이며 안정판·최신 전체와 동일하다고 확대하지 않는다.

| 레퍼런스 | 버전·SHA | 라이선스 | 깊이·선정 이유 | 실행 경로(이번 실행 여부) |
|---|---|---|---|---|
| TanStack Query | 5.104.3, `ee47993724e5b71e65d9f38ae416367d2dd18395` | MIT | 소스·실행; 현재 의존성 | 기존 query-core + 합성 Promise(실행) |
| SWR | 2.6.0-beta.0, `8148ef012fd5b317d1e8ec2da4b2ca0673f63c0f` | MIT | 소스; 정확히 같은 GET/mutation guard | mock fetcher hook 시험(미실행) |
| RTK Query | 조사일 공식 createApi 문서 | MIT | 문서; delayed invalidation 비교 | mock baseQuery 시험(미실행) |
| Apollo Client·Relay | v4·v21.0.1 공식 문서 | MIT | 문서; 낙관 계층의 보장 한계 | MockLink·relay-test-utils(미실행) |
| Matrix JS SDK | `6c8b1b418189919bc69fd9df5e57354e7b3c39cb` | Apache-2.0 | 소스; 읽음 위치 역행 거부 | SDK 단위 시험(미실행) |
| Mattermost | `7a143a586c71eedf3575208d49386342745f1b20` | root mixed, webapp Apache-2.0 | 소스; REST/WS 읽음 경합 guard | reducer 시험(미실행) |
| Zulip | `afcd0cae679ed84eecd3570d072c93e50a71d865` | Apache-2.0 | 소스; 초기 snapshot/event 순서 | web 단위 시험(미실행) |
| Rocket.Chat | `ea30eb21dba8e27ed7b2899190942095506d35b4` | 조사 경로 MIT, EE 예외 | 소스; 읽음 후 subscription 알림 | Meteor self-host 필요(미실행) |
| Playwright | docs `354e6fa33a899f8e0ee1ef5428eaf9a934378615` | Apache-2.0 | 문서; route·strictness·actionability | 현재 앱 E2E(미실행) |
| Testing Library | docs `7c49d046b100e657c64bae78270a5813c1c02eb6` | MIT | 문서; role/name·within | DOM fixture(미실행) |
| BaboJUBot | 기준 SHA 및 `57746db231227e81413faac8df142ef2445def03` | MIT | 소스; 기존 시험·현재 캐시 | 기존 Vitest/E2E(미실행) |

후보는 13개다(Playwright 두 주제 별도, Apollo/Relay 별도, 현 저장소 포함). 관점별 포화는 전수조사의 뜻이 아니다.

- 라이브러리: 공식 mutation 문서 → invalidation 실패 경계 → SWR guard/시험으로 확장. 마지막 라운드는 결과 폐기·후속 수렴·낙관 계층의 반복이며 새 메커니즘을 더하지 않았다.
- 채팅: 읽음 receipt → REST/WS merge → 초기 snapshot/event buffering과 subscription 알림으로 확장. 마지막 후보는 알림이라는 기존 수렴 축만 더했다.
- 시험/질의: mock/locator → actionability/strictness → 기존 읽기 gate 시험으로 확장. 마지막 라운드는 순서 제어·대상 범위 제한의 반복이었다.

## 근거

수준은 실행 확인 / 소스 확인 / 문서 주장 / 추론으로 구분한다. 근거 행 16개: 실행 1, 소스 8, 문서 7. 실행 1행 안에 합성 사례 6개가 있다.

| ID | 관찰 | 원본 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | setQueryData는 manual setData이며 취소하지 않음. cancelQueries는 revert 기본 true로 Query.cancel 호출 | [QueryClient](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/queryClient.ts#L285-L317), [cancelQueries](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/queryClient.ts#L461-L474) | 소스 확인 |
| <a id="E02"></a>E02 | retryer 취소는 reject하고 이미 완료된 결과 resolve를 무시. Query는 취소 시 abort도 호출하지만 signal 미소비여도 결과 폐기는 작동 | [retryer](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/retryer.ts#L165-L204), [Query.fetch](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/query.ts#L837-L908) | 소스 확인 |
| <a id="E03"></a>E03 | invalidate는 기본 active만 refetch. cancelRefetch 기본 true지만 진행 중 fetch의 data가 undefined면 기존 promise에 합류. inactive는 기본 재조회 대상 아님 | [invalidate/refetch](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/queryClient.ts#L494-L560), [fetch 분기](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/query.ts#L706-L726) | 소스 확인 |
| <a id="E04"></a>E04 | 설치 query-core 5.104.3, Node v24.21.0, signal을 사용하지 않는 deferred queryFn: plain은 stale, cancel→set은 read, active set→invalidate는 fresh(2요청), cancelRefetch=false는 stale, no-data 초기 invalidate는 stale, inactive set→invalidate는 stale. 6 PASS | 키 없는 셸, 기존 설치, 정상/음성 대조 실행. 네트워크·React 시험 아님. E01–03의 API 조합을 직접 검증 | 실행 확인 |
| <a id="E05"></a>E05 | SWR은 mutation 시작/종료 이전 시작한 GET 또는 진행 중 mutation과 겹친 GET 결과를 버리고 재검증. marker는 클라이언트 증가 카운터이며 서버 벽시계가 아님 | [GET guard](https://github.com/vercel/swr/blob/8148ef012fd5b317d1e8ec2da4b2ca0673f63c0f/src/index/use-swr.ts#L627-L655), [mutation](https://github.com/vercel/swr/blob/8148ef012fd5b317d1e8ec2da4b2ca0673f63c0f/src/_internal/utils/mutate.ts#L128-L209), [counter](https://github.com/vercel/swr/blob/8148ef012fd5b317d1e8ec2da4b2ca0673f63c0f/src/_internal/utils/timestamp.ts#L1-L4) | 소스 확인 |
| <a id="E06"></a>E06 | RTK 기본 delayed는 query/mutation 모두 settled 뒤 invalidation. 계속 pending이면 무기한 연기 가능. 이 계약은 stale 값의 일시 반영 자체를 금지하지 않음 | [createApi invalidationBehavior](https://redux.js.org/toolkit/rtk-query/api/createApi#invalidationbehavior) | 문서 주장 |
| <a id="E07"></a>E07 | Apollo는 canonical과 별도 optimistic 객체, Relay는 optimistic rollback 후 실제 payload/updater. 읽은 문서에서 완료 뒤 늦은 GET 자동 폐기 보장은 확인 못 함 | [Apollo](https://www.apollographql.com/docs/react/performance/optimistic-ui), [Relay](https://relay.dev/docs/api-reference/use-mutation/) | 문서 주장 |
| <a id="E08"></a>E08 | Matrix는 기존보다 뒤인 receipt만 반영(timeline order 우선, ts fallback). Mattermost는 last_viewed_at/last_update_at 비교 및 count별 max/min 병합으로 REST/WS 역전을 방어 | [Matrix](https://github.com/matrix-org/matrix-js-sdk/blob/6c8b1b418189919bc69fd9df5e57354e7b3c39cb/src/models/read-receipt.ts#L241-L300), [Mattermost](https://github.com/mattermost/mattermost/blob/7a143a586c71eedf3575208d49386342745f1b20/webapp/channels/src/packages/mattermost-redux/src/reducers/entities/channels.ts#L480-L524) | 소스 확인 |
| <a id="E09"></a>E09 | Zulip은 초기 fetch 중 이벤트를 보관해 뒤에 적용. Rocket.Chat은 읽음 저장 변경 시 subscription 알림. 알림만으로 stale snapshot guard가 증명되진 않음 | [Zulip](https://github.com/zulip/zulip/blob/afcd0cae679ed84eecd3570d072c93e50a71d865/web/src/server_events.js#L35-L61), [Rocket.Chat](https://github.com/RocketChat/Rocket.Chat/blob/ea30eb21dba8e27ed7b2899190942095506d35b4/apps/meteor/server/lib/readMessages.ts#L7-L29) | 소스 확인 |
| <a id="E10"></a>E10 | route.fetch로 서버 snapshot을 확보한 뒤 fulfill로 전달 가능 | [Playwright 공식 예제](https://github.com/microsoft/playwright/blob/354e6fa33a899f8e0ee1ef5428eaf9a934378615/docs/src/mock.md#L106-L124) | 문서 주장 |
| <a id="E11"></a>E11 | 기존 Lead 시험은 POST 응답을 gate로 보류. 57746db는 reached→미완료/상류 없음→release→moved/read original 순서까지 검사 | [held route](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/e2e/lead-chat.spec.ts#L14-L37), [순서 시험](https://github.com/babo-jeonguk/BaboJUBot/blob/57746db231227e81413faac8df142ef2445def03/packages/runtime/src/providers/login-preparation.test.ts#L537-L584) | 소스 확인 |
| <a id="E12"></a>E12 | locator chain으로 범위 축소. 여러 대상이면 strict operation 실패하며 first/last/nth 우회는 오대상 위험 | [locator](https://github.com/microsoft/playwright/blob/354e6fa33a899f8e0ee1ef5428eaf9a934378615/docs/src/locators.md#L152-L192), [strictness](https://github.com/microsoft/playwright/blob/354e6fa33a899f8e0ee1ef5428eaf9a934378615/docs/src/locators.md#L1730-L1781) | 문서 주장 |
| <a id="E13"></a>E13 | click은 visible/stable/enabled 등을 기다림. 데이터 조회 완료는 그 목록에 없음 | [actionability](https://github.com/microsoft/playwright/blob/354e6fa33a899f8e0ee1ef5428eaf9a934378615/docs/src/actionability.md#L6-L17) | 문서 주장 |
| <a id="E14"></a>E14 | role을 실제 accessible name으로 구분하거나 within(container)로 범위를 묶음 | [ByRole](https://github.com/testing-library/testing-library-docs/blob/7c49d046b100e657c64bae78270a5813c1c02eb6/docs/queries/byrole.mdx#L59-L70), [within](https://github.com/testing-library/testing-library-docs/blob/7c49d046b100e657c64bae78270a5813c1c02eb6/docs/dom-testing-library/api-within.mdx#L9-L15) | 문서 주장 |
| <a id="E15"></a>E15 | 현 read mutation은 set만, queryFn은 signal 미전달. live-refresh는 진행 조회 뒤 dirty 재조회하여 수렴하며 일시 반영은 허용. 서버 readMessageSeq는 greatest로 후퇴 방지 | [api](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/src/api.ts#L364-L389), [live-refresh](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/src/live-refresh.ts#L1-L75), [서버 읽음](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/packages/db/src/conversations.ts#L201-L237) | 소스 확인 |
| <a id="E16"></a>E16 | TanStack 공식 권고는 outgoing refetch를 cancel해 낙관 갱신 덮어쓰기를 방지 | [QueryClient](https://tanstack.com/query/latest/docs/framework/react/reference/classes/QueryClient) | 문서 주장; 정확한 설치 동작은 E01–04 |

## 패턴

| ID | 패턴 | 사례 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|
| P01 | 적용 전에 이전 조회 취소 | E01–04, E16 | 현 라이브러리 API로 작은 변경; transport abort 없이도 결과 차단 | 취소 시점 이후 새 조회·다른 mutation 응답까지 자동 순서 보장하지 않음 |
| P02 | 연산 epoch/서버 위치·revision 비교 | E05,E08 | 네트워크 취소와 무관하게 stale 결과 거부 | 관련 key·동시 쓰기·재연결 경계 계약 필요; 서버 벽시계 비교는 clock 전제 |
| P03 | 변경 후 authoritative 재조회/이벤트 replay | E03,E06,E09,E15 | 서버 최신 상태로 수렴, 기존 refresh 정책과 친화적 | 추가 요청·실패 처리; 잠깐의 역행과 inactive/무신호 누락 가능 |
| P04 | gate로 순서 강제 + 영역 내 유일 locator | E10–14 | 부하/Windows 속도와 독립적인 재현과 대상을 검증 | 응답 수신과 cache/React 소비 완료를 구별해야 함 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| D01 | 변형 채택 권고 | read 성공 시 exact conversations(orgId)의 진행 조회를 await cancelQueries한 뒤 서버 목록 setQueryData를 일반 경로로 우선 검토 | P01,E15 | 낙관 갱신 없이 기존 성공 응답 사용. onMutate에서만 취소하면 진행 중 새로 시작한 GET을 놓칠 수 있으므로 성공 적용 직전 경계를 검증. 전체 목록 PUT 응답끼리 역전은 별도 | Q1 |
| D02 | 열린 결정 | A 취소+set / B set+후속 invalidate 또는 dirty drain / C 서버 revision·읽음 위치 비교 중 사용자 선택 | P01–03 | 아래 선택 표. 구현 전에 확정 | Q1 |
| D03 | 채택 권고 | 오래된 GET snapshot 확보→PUT 캐시 반영→GET 해제 순서를 gate로 강제. 실제 QueryClient deferred 시험도 함께 권고 | P04,E04 | 서버 GET 자체를 PUT 뒤까지 미루면 stale snapshot이 사라져 재현 실패 | Q2 |
| D04 | 채택 권고 | composer 범위의 전송 status를 유일하게 질의. 초기 준비 대기는 그 시험 전제일 때만 추가 | P04 | 서로 다른 영역의 로딩과 전송을 구분하며 늦게 뜨는 화면도 다룸 | Q3 |
| D05 | 목록만 | 아래 Q4 후보는 수정 여부를 결정하지 않음 | E01–03, 현재 소스 검색 | 비슷한 형태와 실제 결함을 구별. 다른 기능의 정책 변경은 범위 확대 | Q4 |

### 배제한 패턴

| 패턴 | 이유 |
|---|---|
| 전역 unread=false 우선·boolean AND | 새 메시지가 legitimate unread=true를 만들 수 있음. 읽음 위치 단조 증가와 unread boolean은 다름 |
| 긴 sleep·timeout 증가·CI 재시도·first() | 순서와 대상 오류를 보장하지 않음(E11–13) |
| AbortSignal 전달만으로 해결 | signal 사용은 transport 절약에 유용하나 mutation이 취소를 호출해야 함. 현재 경쟁의 순서 보장은 별도 |
| 라이브러리 교체·낙관 계층만 도입 | SWR은 비교 근거. Apollo/Relay 계층만으로 완료 후 stale GET 방지 보장 미확인 |

## 구현 참고

구현 위치는 웹 캐시 책임인 api.ts의 useMarkConversationRead 및 해당 E2E다. 서버 승인·조직 경계·구조를 바꿀 근거는 없다. hook 공통 정책 추출은 Q4 후보를 검증한 뒤 별도 판단한다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 덮어쓰기 방지 방식 | 사용자/#211 | A(우선 권고): 성공 직전 exact cancel→set, 즉시 역행 방지·추가 GET 없음. B: set 후 active invalidate 또는 기존 dirty drain 활용, 서버 수렴 우선·추가 요청/실패·잠깐 역행 여부를 명시. C: revision/읽음 위치 기반 병합, 동시 mutation/탭 전체까지 넓은 계약·서버/API 비용 |
| 재조회/실패 UX | 사용자/#211 | A 후 추가 invalidate 여부, B 재조회 완료까지 pending을 유지할지 저장 성공과 분리할지. 기존 #144의 void invalidate 정책을 자동 변경하지 않음 |
| 방어 범위 | 사용자/#211 | 단일 PUT vs 이전 GET을 우선 고칠지, 전체 목록 PUT 두 개의 역전·새 이벤트까지 포함할지. A만으로 후자 보장을 주장하지 않음 |

| ID | 검증할 경계(입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | GET unread:true 응답 snapshot 확보(reached) → 메시지 조회/PUT 성공과 cache false 확인 → 오래된 응답 전달/취소 → 최종 false | D01,D03 |
| V02 | deferred 실제 QueryClient query settle/취소 완료 후 underlying Promise도 해제 → 최종 cache assert. 수정 제거하면 stale로 반드시 실패; 정상 순서 대조 | E04,D03 |
| V03 | org A read → A key만 갱신/취소, B key 진행 조회·값 보존 | 제품 조직 경계,D01 |
| V04 | 초기 로딩 2개 + held POST 전송 1개 → composer status 하나, 해제 뒤 같은 locator 소멸·수정 초안 유지 | D04 |
| V05 | PUT 실패 → 읽음 성공을 만들지 않음. PUT 성공 중 새 메시지/다른 대화 read, 응답 역전은 선택한 방어 범위에 맞게 검사 | D02 |
| V06 | route 해제/abort cleanup을 finally에서 수행. PUT response 이벤트만을 React/cache 반영 완료 증거로 간주하지 않음 | D03 |

E2E에서 점이 사라진 순간의 toHaveCount(0)만 검사하면 stale GET 소비 전에 통과할 수 있다. 네트워크 response/fulfill 완료와 앱 소비는 다르므로 V02의 최종 캐시 검사를 함께 둔다. timeout은 hang의 상한으로만 쓴다. 현재 form은 accessible name이 없고 status의 자식 글은 name으로 가정할 수 없다. 기존 DOM에서는 `page.locator('form').filter({has: input})` 안의 `getByRole('status').filter({hasText: /^전송 중…$/})`처럼 범위를 좁히는 후보가 있다([현재 composer](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/src/chat.tsx#L1052-L1084)). 이 locator는 제안이며 브라우저에서 실행 확인하지 않았다.

### Q4 유사 캐시 쓰기 후보(수정 결정 아님)

apps/web/src의 setQueryData 전체를 검색했다. 아래는 mutation 응답 쓰기 경로이며, 같은 key를 읽는 useQuery가 있고 취소 호출이 없다. 실제 in-flight 재현·UI 진입 가능 여부는 미확인이다. 후속 invalidate가 있는 경로도 같은 key인지·active인지에 따라 다르므로 확정 결함으로 세지 않는다.

| mutation·위치(api.ts) | 같은 key의 조회 | 후속 invalidate와 판단 근거 |
|---|---|---|
| useCreateOrganization L211/213 | useOrganization / useOrganizations | organizations exact 무효화. 새 상세 key는 통상 사전 GET이 없으므로 낮은 우선 후보; 목록 응답 병합은 후보 |
| useMarkConversationRead L387 | useConversations | set만. 이번 확인된 경쟁 |
| useUpdateApprovalPolicy L614 | useOrganization | 같은 상세 exact 무효화. active+set이면 E03 취소 refetch 경로 |
| useUpdateNetworkPolicy L646 | useNetworkPolicy | set만 |
| useControlOrganization L665 | useOrganization | organization prefix와 organizations exact 무효화 |
| useControlAgent L695 | useAgent | organization prefix 무효화에 agent key 포함 |
| useUpdateHeartbeat L721 | useAgent | set만 |
| useProviderSettingsMutation L748: defaults/limit/isolation 3 hook | useProviderSettings | set만; 별도 settings_changed로 다시 받는 경로 존재 |
| useRecheckProvider L793 | useProviderSettings | set만 |
| useUpdateAgentProvider L816 | useAgent | organization exact 무효화는 agent key를 포함하지 않음 |
| useUpdateAgentProfile L843 | useAgent | 위와 동일 |
| decisionCachePolicy L955: useDecideApproval / useDecideResult | useApproval / useResultSubmission | organization prefix와 inbox 무효화. active 항목은 refetch 대상 |

위 목록의 원본: [api.ts 생성·조회](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/src/api.ts#L181-L238), [조직·agent·provider](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/src/api.ts#L604-L848), [결정 정책](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/src/api.ts#L940-L1022). queryKeys는 조직 ID를 포함하고 provider는 의도적으로 전역이다.

transcript-window.ts L83/L177도 검색에 잡혔다. 전자는 GET 이어받기 후 cursor가 그대로인지 비교하여 적용하고, 후자는 로컬 창 줄이기다. mutation 응답 쓰기 범주에서는 제외한다([소스](https://github.com/babo-jeonguk/BaboJUBot/blob/34ad3d8afebddba279114e85c1a58a61ab3459b5/apps/web/src/transcript-window.ts#L64-L90)). 시험 fixture의 setQueryData도 후보에서 제외했다.

## 한계와 미확인

- 새로 실행한 검사는 합성 query-core 사례 6개뿐이다. 제품 회귀 시험·Windows CI·Playwright 브라우저·외부 제품 self-host·실화면 관찰은 하지 않았다. 화면 배치 변경이 아닌 캐시/질의 메커니즘 조사이므로 캡처 근거는 없다.
- 원인 trace는 triage 전달 근거이며 이번 실행 관찰 수에 포함하지 않았다. history 실패는 재조사하지 않았다.
- Matrix/Mattermost/SWR은 고정 SHA 소스 확인이며 전체 제품의 모든 경합을 해결한다는 주장이 아니다. SWR 안정판과 beta 차이, Rocket.Chat 클라이언트 snapshot guard, 각 제품 재연결·장애 복구, linked PR의 전체 의도는 미확인이다.
- Q4는 정적 후보 목록이다. 동시 mutation 응답 역전, inactive key, 새 unread 이벤트와의 경합·재조회 실패는 구현 범위 결정 뒤 시험해야 한다.
- 공식 문서는 조사 시점 계약이다. Playwright 설치 1.65.1 전체 소스와 docs HEAD의 차이는 비교하지 않았다. 권고 API는 현재 저장소에서 사용하는 route.fetch/fulfill/filter 조합에 한정한다.
- 설계 참고만 했으므로 THIRD_PARTY_NOTICES 변경 없음. 향후 코드를 복사하면 해당 SHA의 LICENSE/header/NOTICE·의존성을 재확인해야 한다.
