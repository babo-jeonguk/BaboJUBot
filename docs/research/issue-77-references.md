# issue-77 레퍼런스 조사: Event 폭주 중 대시보드 조회 갱신

조사일: 2026-10-23. 대상: [#77](https://github.com/babo-jeonguk/BaboJUBot/issues/77). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-77/`(git 무시). 조사 receipt: [#77 댓글](https://github.com/babo-jeonguk/BaboJUBot/issues/77#issuecomment-6360074474).

권고는 **현재 조회를 끝까지 반영하고, 조회 중 생긴 변경을 별도 dirty 상태로 기억해 뒤이어 한 번 더 회수하는 방식**이다. `cancelRefetch:false`만 적용하거나 고정 간격 배처만 추가하면 마지막 변경을 놓칠 수 있다. 특히 첫 Event 전에 시작된 조회에 합류하는 경우와 offline pause를 별도로 다뤄야 한다.

## Brief

- 구현할 문제: Event가 몰리면 진행 중 재조회를 반복 취소하여 화면이 오래된 값에 머문다. 같은 조회의 동시 진행을 하나로 제한하고 마지막 Event 뒤의 상태를 반영하며, 첫 구독·재연결의 전체 snapshot 복구를 유지한다.
- 동종 문제: push invalidation을 비동기 snapshot 조회로 바꾸는 **single-flight + dirty/trailing 재처리**.
- 고정된 결정: React·TanStack Query 5.104.3·WebSocket, 전역 목록/Inbox와 조직별 query key, HTTP가 원본이고 Event가 재조회 신호인 현재 구조를 유지한다([ADR-0004](../adr/0004-paperclip-aligned-stack.md), [구조](../architecture.md#surface--control-plane)). 승인·조직 경계는 서버의 책임이며 브라우저 큐가 강제 수단을 대신하지 않는다. 실제 모델·실제 연구 데이터·새 저장 엔진은 범위 밖이다.
- #77은 native parent가 없고 blocker 목록은 비어 있다. 원인 맥락은 [PR #76 리뷰 보고](https://github.com/babo-jeonguk/BaboJUBot/pull/76#issuecomment-6359422139)와 완료된 #64다. 기존 결함이며 #64의 회귀로 취급하지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | cancel/dedupe/invalidate/refetch는 느린 조회와 중간 Event를 어떻게 처리하는가? `cancelRefetch:false`만으로 최신 상태를 보장하는가? | #77 원인·바라는 동작 1/2, `api.ts`, ADR-0004 | API 계약 + Source Recon + runtime/failure |
| Q2 | 진행 응답과 마지막 변경을 모두 반영하는 최소 스케줄러 및 scope 단위는? | #77 바라는 동작 1/2·AC1, AGENTS 조직 경계 | Source Recon + runtime/failure + 인접 큐 비교 |
| Q3 | 전역/조직 key 중첩, ready/reconnect, unmount, 오류·retry·offline, mutation 갱신 경합을 어떻게 다루는가? | #77 바라는 동작 3·AC3, #52 D06·#53 D10·#64 D06 | Source Recon + failure/lifecycle |
| Q4 | 느린 응답·Event 묶음·다른 탭과 마지막 상태를 어떻게 결정적으로 검증하는가? | #77 AC1–3, PR #76 부하 관찰 | 공식 테스트/도구 계약 + source/behavior probes |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#52 D06](issue-52-references.md#결정-권고) | 첫 연결/재연결 snapshot, 전역/조직 key 분리 | 제품 맥락 재사용. 과거 Paperclip provider와 새 SHA의 blob은 서로 달라 새 원문을 읽었다 |
| [#53 D10](issue-53-references.md#결정-권고) | 조직 범위·안정 ID, replay 보장과 snapshot 복구 구별 | 과거 소스 근거를 새 E로 승격하지 않음. 서버의 영속 run/wake 큐를 브라우저에 옮기지 않음 |
| [#64 D06/V10](issue-64-references.md#구현-참고) | draft 보존·다른 탭 revision 반영 회귀 | #64 완료 댓글과 현행 instructions E2E를 읽음. 화면 디자인 재조사는 하지 않음 |
| [#50](issue-50-references.md#결정-권고)·[#59](issue-59-references.md#구현-참고) | 마지막 정상 자료/오류 구분 및 제어 화면 회귀 범위 | 맥락만 참조. 캡처·과거 실행 결과는 이번 조사 결과로 세지 않음 |
| 기존 `.reference-cache/` | 후보·과거 checkout 탐색 힌트 | 결정 근거는 아래 고정 SHA 원문을 새로 읽음. upstream 전체가 변하지 않았다고 주장하지 않음 |

## 레퍼런스

중복을 제거한 후보 **23개 묶음**(관련 issue·연산자는 묶어서 집계)과 각 실행 경로는 `.reference-cache/issue-77/candidates.md`에 있다. 관점별 마지막 라운드는 다음과 같다. 검색 전체의 완전성이나 미발견 기능의 부재를 뜻하지 않는다.

| 관점 | 탐색·saturation 근거 |
|---|---|
| 라이브러리·공식 계약 | 4라운드. 마지막에 #7180 실패 보고가 boolean 유실을 보강했지만 취소/공유/최신 한 슬롯/FIFO/시간 배치/광역 barrier 외 새 패턴은 없었음 |
| 실제 OSS 제품 | 4라운드. 마지막 심볼·실패 교차검색이 Paperclip/Query 사례와 단순 debounce/direct delta를 반복. 새 해결 메커니즘·실패 분류 없음 |
| 인접 큐·검증 도구 | 3라운드. 마지막 p-limit/p-queue·연산자 대안은 FIFO/결과 공유/최신 한 슬롯/취소/버림 분류를 반복. 정리·재진입 실패도 이미 확보한 범위 |

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| TanStack Query | 현재 cache 엔진 | query-core 5.104.3, `ee47993724e5b71e65d9f38ae416367d2dd18395` | MIT 원문 확인 | 소스·실행 | 기본 취소·합류·초기 무캐시·paused 계약을 직접 확인해야 함 |
| Kubernetes client-go workqueue | 인접 per-key reconciliation 큐 | `0ff7d00cf56497f17f92f225f7d2108706943582` | Apache-2.0 원문 확인 | 소스 | processing/dirty 분리와 Done 뒤 1회 재처리가 요구와 일치 |
| p-debounce.promise | 최소 JS async 부품 | 6.0.0, `7fd1617e1ee9dac490fb659f59bd1e9f04d92c47` | MIT 원문 확인 | 소스·실행 | 한 슬롯 trailing, 예외·재진입, 각 응답의 즉시 settle과 history를 비교 |
| Paperclip | 같은 스택·조직 운영 제품 | `412914cfa78d5abefcc34d3eb8d4bb86e461caac` | MIT 원문 확인 | 소스·module 실행 | 300ms 배처와 실제 fetch single-flight가 다른 보장임을 확인 |
| TanStack 실패 보고·Playwright | 역사적 실패/검증 API | #7180·#6536, Playwright 문서 확인일 위와 같음 | 문서 참고 | 문서 | probe의 음성 대조군과 HTTP/WS gate를 설계 |

네 심층 대상의 확인일은 모두 2026-10-23이다. **설계 참고만 권고하며 코드 복사·새 패키지 도입은 권고하지 않는다.** 따라서 root 라이선스는 확인했지만 코드 이식용 파일별 NOTICE·전이 의존성 심사는 수행하지 않았다.

## 근거

소스 확인은 테스트를 읽은 경우까지 포함하며, 실행한 것은 별도 행이다. 메인이 결정용 원문을 다시 열어 확인한 기록은 `.reference-cache/issue-77/main-verification.md`에 있다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현재 Event는 목록 exact·조직 prefix·Inbox를 각각 invalidate하고 ready는 전체 invalidate한다. `request()`는 queryFn의 AbortSignal을 fetch로 넘기지 않는다. mutation에도 직접 invalidation이 있다 | BaboJUBot [`live-events.ts`](https://github.com/babo-jeonguk/BaboJUBot/blob/e2b64ba11f6363d8262af1ae2efb4ddf2a7bace0/apps/web/src/live-events.ts#L17-L59), [`api.ts`](https://github.com/babo-jeonguk/BaboJUBot/blob/e2b64ba11f6363d8262af1ae2efb4ddf2a7bace0/apps/web/src/api.ts#L46-L209) `queryKeys/request/useSendMessage` | 소스 확인 |
| <a id="E02"></a>E02 | invalidate는 먼저 stale을 표시하고 기본 active를 refetch한다. refetch의 cancelRefetch 기본은 true이고 disabled/static은 제외한다 | [QueryClient.invalidateQueries/refetchQueries](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/queryClient.ts#L494-L558) | 소스 확인 |
| <a id="E03"></a>E03 | 진행 중이고 기존 data+cancelRefetch=true면 cancel한다. 그 외에는 기존 retryer Promise에 합류한다. 초기 무캐시도 합류하므로 true만으로 해결되지 않는다 | [Query.invalidate/fetch](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/query.ts#L680-L722) | 소스 확인 |
| <a id="E04"></a>E04 | fetch 성공과 manual setData는 isInvalidated=false를 만든다. Event 세대/시각과 비교하지 않는다. 이 boolean은 별도 dirty 세대가 아니다 | [success reducer](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/query.ts#L961-L995), [successState](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/query.ts#L1054-L1061) | 소스 확인 |
| <a id="E05"></a>E05 | refetch aggregate는 기본 오류를 삼키고 paused query는 실제 완료 대신 즉시 resolve한다. retryer에는 delay/online pause가 있다 | [refetchQueries](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/queryClient.ts#L535-L558), [retryer](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/retryer.ts#L183-L219) | 소스 확인 |
| <a id="E06"></a>E06 | 공식 테스트는 캐시+기본 취소→fetch2회/false→1회, 초기 무캐시 true→1회, paused await 즉시 반환을 명시한다. trailing 최신성 검사는 이 assertions에 없다 | [queryClient tests](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/__tests__/queryClient.test.tsx#L2497-L2541), [초기 무캐시](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/react-query/src/__tests__/useQuery.test.tsx#L379-L410), [paused](https://github.com/TanStack/query/blob/ee47993724e5b71e65d9f38ae416367d2dd18395/packages/query-core/src/__tests__/queryClient.test.tsx#L2283-L2295) | 소스 확인 |
| <a id="E07"></a>E07 | workqueue Add는 dirty에 표시하고 processing이면 enqueue하지 않는다. Get은 processing에 넣고 dirty를 지운다. Done은 processing을 빼고 다시 dirty인 항목만 enqueue한다 | [Typed.Add/Get/Done](https://github.com/kubernetes/client-go/blob/0ff7d00cf56497f17f92f225f7d2108706943582/util/workqueue/queue.go#L193-L305) | 소스 확인 |
| <a id="E08"></a>E08 | TestReinsert는 처리 중 Add 뒤 Done 시 다시 얻는 것을 검사한다. TestCollapseWhileProcessing은 반복 Add 뒤 다른 worker가 Done 전에는 못 받고 완료 뒤 한 번만 처리함을 검사한다 | [workqueue tests](https://github.com/kubernetes/client-go/blob/0ff7d00cf56497f17f92f225f7d2108706943582/util/workqueue/queue_test.go#L190-L300) | 소스 확인 |
| <a id="E09"></a>E09 | p-debounce.promise(after:true)는 호출 전 busy를 세우고 queuedCall 한 슬롯을 최신 인자로 교체한다. finally에서 후속을 시작하되 현재 caller는 자기 실행 결과로 settle한다 | [promise 구현](https://github.com/sindresorhus/p-debounce/blob/7fd1617e1ee9dac490fb659f59bd1e9f04d92c47/index.js#L105-L144) | 소스 확인 |
| <a id="E10"></a>E10 | gate 테스트는 첫 성공/실패가 후속 전체 완료를 기다리지 않음과 maxRunning=1을 검사한다. 관련 수정은 전체 drain을 기다리던 응답 지연을 고친다 | [gate tests](https://github.com/sindresorhus/p-debounce/blob/7fd1617e1ee9dac490fb659f59bd1e9f04d92c47/test.js#L1731-L1808), [수정 commit](https://github.com/sindresorhus/p-debounce/commit/0db803f5c8736083b9da24c11df124111fe515d4) | 소스 확인 |
| <a id="E11"></a>E11 | Paperclip은 300ms trailing throttle+동일 필터 Map을 쓴다. flush 시작에 timer/pending을 비운 뒤 await하므로 진행 HTTP 중 다음 창도 flush 가능하다. 실제 query 동일성과 필터 문자열 동일성은 다르다 | [createInvalidationBatcher](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/lib/query-invalidation-batcher.ts#L40-L125) | 소스 확인 |
| <a id="E12"></a>E12 | provider는 Event를 배처로 보내고 첫 연결/재연결에는 raw QueryClient의 active invalidate(false)를 쓴다. replay가 없어서 첫 구독 전 누락도 reconcile한다 | [provider 배처](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/context/LiveUpdatesProvider.tsx#L2008-L2019), [onopen/onmessage](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/context/LiveUpdatesProvider.tsx#L2101-L2149) | 소스 확인 |
| <a id="E13"></a>E13 | Paperclip 배처 테스트는 즉시 resolve fakeClient로 창 안 중복 제거·별도 필터·dispose를 검사한다. 느린 응답/최종 서버 상태는 이 파일의 assertions에 없다 | [query-invalidation-batcher tests](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/lib/query-invalidation-batcher.test.ts#L9-L148) | 소스 확인 |
| <a id="E14"></a>E14 | 설치본 QueryClient+QueryObserver와 signal을 쓰지 않는 deferred queryFn에서 Event10회→호출10회·진행 최대10회. 마지막만 cache에 반영되어도 앞선 물리 작업은 남는다 | `probes/query-burst.mjs` 기본 취소 사례, `query-burst-result.json` | 실행 확인 |
| <a id="E15"></a>E15 | false-only는 호출1·진행최대1이지만 server10/cache1/invalidated=false. naïve dirty-drain이 첫 Event 전에 시작된 조회에 합류해도 cache1에 머문다. 초기 무캐시 default도 중간 Event를 새 fetch로 회수하지 않는다 | 같은 probe의 false-only/preexisting/initial 사례. 조회 시작 때 snapshot을 고정 | 실행 확인 |
| <a id="E16"></a>E16 | 별도 dirty 모형은 진행 응답1을 먼저 cache에 반영하고 후속 snapshot10으로 수렴(호출2·최대1). 첫 오류 뒤 dirty 후속, 기존 조회 합류 시 dirty 미소비, 매 응답 중 새 Event가 오는 경우도 통과했다 | 같은 probe의 dirty-drain/오류/existing-aware 사례. 모형 검증이며 제품 수정이 아님 | 실행 확인 |
| <a id="E17"></a>E17 | offline 상태에서 invalidate(false)를 await해도 fetchStatus=paused·queryFn 호출0이었다 | 같은 probe의 paused 사례, `onlineManager.setOnline(false)` | 실행 확인 |
| <a id="E18"></a>E18 | p-debounce 원본 직접 import: 입력1/2/3은 실행1/3·최대진행1, 첫 caller 완료 시 tail은 pending. 첫 거부 뒤 queued 성공도 통과했다 | `probes/reference-schedulers.mjs`, `reference-schedulers-result.json`; 원본 SHA E09, 외부 API 없음 | 실행 확인 |
| <a id="E19"></a>E19 | Paperclip 원본 배처 import: 한 창20회는1회로 합쳐지지만 미완료인 두 창을 flush하면 최대진행2. prefix/exact 중첩 필터도2회 호출했다 | 같은 probe. visibility만 visible stub, deferred fake invalidate와 명시 flush 사용. 실제 300ms timer/HTTP/UI 검증은 아님 | 실행 확인 |
| <a id="E20"></a>E20 | #7180은 WS invalidation 후 성공 응답이 stale 표시를 없애는 실패와 호출 제어를 논의한다. #6536은 초기 fetch 동안 재조회가 무시되는 보고다 | [Query #7180](https://github.com/TanStack/query/discussions/7180), [#6536](https://github.com/TanStack/query/issues/6536). 역사적 문서이며 현재 사실은 E03/E06/E15로 확인 | 문서 주장 |
| <a id="E21"></a>E21 | route.fetch/fulfill로 HTTP 응답을 잡고, routeWebSocket으로 frame 입력을 제어할 수 있다. waitForResponse는 동작 전에 등록하는 예시를 제공한다 | [Playwright network](https://playwright.dev/docs/network), [Route](https://playwright.dev/docs/api/class-route), [routeWebSocket](https://playwright.dev/docs/api/class-page#page-route-web-socket), [waitForResponse](https://playwright.dev/docs/api/class-page#page-wait-for-response) | 문서 주장 |
| <a id="E22"></a>E22 | 큐의 식별자는 실제 조회 또는 겹치지 않는 scope여야 한다. 모든 조직을 한 최신 인자로 합치면 다른 조직의 입력이 사라지고, 모든 조회를 한 완료 barrier로 묶으면 느린 한 조회가 나머지를 지연시킨다 | E01/E07/E09/E11 및 [구조의 Surface 책임](../architecture.md#module)에서 도출 | 추론 |

실행 환경: Node v24.21.0, 키 없는 `env -i HOME="$HOME" PATH="$PATH"`, 패키지 추가 설치 없음. 설치본 query/queryClient/retryer/queryObserver 소스는 정확 버전 SHA 원문과 byte 일치했다. build artifact와 소스의 재빌드 동일성을 검증했다는 뜻은 아니다. 명령과 실패/결과는 `probes/run-log.txt`에 기록했다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 현재 처리와 후속 dirty를 분리 | E07–E10/E16 | workqueue는 key 집합, p-debounce는 최신 인자 한 슬롯 | burst를 한 후속으로 합치고 현재 응답도 진행 | 조직들을 한 인자 슬롯에 섞으면 유실. 외부 선행 fetch 합류는 별도 처리 |
| <a id="P02"></a>P02 | 동일 Promise 공유와 마지막 변경 회수 구별 | E02–E06/E15/E20 | Query false는 현재 실행 공유, dirty 모형은 Event 이후 snapshot까지 수행 | 동시성 제한과 최신성을 따로 검증 | isInvalidated를 세대로 쓰거나 await를 새 fetch 완료로 오해하면 유실 |
| <a id="P03"></a>P03 | 시간 창 배치와 async single-flight 구별 | E11/E13/E19 | Paperclip은300ms throttle, #77은느린 응답 동안의 직렬화 필요 | 창 내부 호출 수 감소 | 응답이 간격보다 느리면 창 간 중첩. pure debounce는 연속 Event에 무한 대기 |
| <a id="P04"></a>P04 | 각 응답 완료와 전체 drain 완료 분리 | E09/E10/E16/E18 | p-debounce 수정은 caller별 settle, Query는 실제 응답 때 cache 갱신 | Event가 계속 와도 화면은 완료된 응답을 따라감 | 모든 후속이 빌 때까지 UI 반영을 막으면 기존 증상 재현 |
| <a id="P05"></a>P05 | 전역·조직·query scope와 전체 복구를 한 경로에서 조율 | E01/E12/E22 | Paperclip reconnect는 raw bypass, #77은동시성 보장과 함께 검증 필요 | ready 중 겹침·다른 조직 starvation 방지 | prefix와 exact 필터가 다르더라도 같은 실제 조회에 도달 가능 |
| <a id="P06"></a>P06 | 완료·오류·pause·dispose를 구분 | E05/E06/E17/E18/E21 | finally는 슬롯 해제, paused는 응답 미완료, E2E는 HTTP/WS gate 분리 | lock 고착·busy loop·거짓 성공을 검사 | 영구 오류에 무한 즉시 retry를 붙이면 폭주. unmount 뒤 재기동도 방지해야 함 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 현재 Query 위에 processing/busy와 dirty(또는 요청 세대)를 분리한다. 처리 중 입력은 후속1회로 합치고, 후속 처리 중 새 입력은 다시 다음1회로 남긴다 | P01/P02; #77 AC1 | 진행 응답을 취소하지 않으면서 마지막 변경을 회수. 새 queue 의존성 불필요 | Q1/Q2 |
| <a id="D02"></a>D02 | 변형 채택 | 재조회에는 non-cancelling 합류를 사용하되 **Event 이전에 시작된 fetch에 합류한 것**은 Event를 소비한 것으로 보지 않는다. 선행 fetch 종료 뒤 새 snapshot 필요를 남긴다. 최초 무캐시/ready도 같은 규칙 | E03/E15/E16 | `cancelRefetch:false` 단독과 naïve loop의 실제 반례를 막음. 자체 dirty와 Query 상태를 구별 | Q1/Q2/Q3 |
| <a id="D03"></a>D03 | 변형 채택 | 실제 query identity 단위 조율을 우선 검토한다. 전역 목록 exact·Inbox·조직 prefix를 매칭할 때 같은 query의 dirty는 합치고 다른 query는 독립 진행한다. scope 방식이면 겹치는 필터와 느린 하위 조회의 영향을 증명한다 | P05/E22 | 한 전역 Promise.all barrier나 org ID 최신 인자 하나는 피함. query별 방식은 lifecycle 관리가 더 필요 | Q2/Q3 |
| <a id="D04"></a>D04 | 채택 | 성공 응답은 즉시 cache/UI에 반영하고 전체 burst 종료나 drain 완료를 기다리지 않는다. 비활성 query는 기존 stale/재mount 정책을 존중하되 진행 fetch가 stale을 지워도 변경 의무가 유실되지 않게 한다 | P02/P04; 기존 #52 D06 | 활동 중에도 진전이 보임. 별도 응답 buffer를 쌓을 이유 없음 | Q1/Q2/Q3 |
| <a id="D05"></a>D05 | 변형 채택 | 첫 ready/재연결의 전체 재조회도 동일 조율 경로를 거친다. mutation·focus/reconnect·route mount의 선행/경합 조회를 검사하고, 같은 query를 취소하는 직접 호출은 AC 보장에 필요한 범위에서 조정한다 | E01/E03/P05; #77 AC3 | Event hook만 고쳐 놓고 raw invalidate가 다시 취소하는 우회를 남기지 않음. WS replay/서버 프로토콜 변경은 불필요 | Q3 |
| <a id="D06"></a>D06 | 변형 채택 | 예외에도 busy를 해제하고 dirty 의무와 오류를 보존한다. paused/disabled/no-active의 즉시 resolve를 성공 snapshot으로 세지 않는다. offline 때 즉시 재루프하지 않고 복귀 신호에 이어 처리하며 dispose 후 새 요청을 막는다 | P06/E05/E17 | 영구 lock·오류 은폐·무한 loop 방지. retry 소진 뒤 자동 재시도 정책은 아래 열린 결정 | Q3 |
| <a id="D07"></a>D07 | 채택 | 요청 시작 시 snapshot을 고정하는 gate 검사와 다른 탭의 느린 HTTP+실제 Event E2E를 함께 둔다. 최대진행1·중간 응답 표시·최종 revision/팀 상태를 독립 assertion으로 검증 | E14–E21; #77 AC1–3 | 단순 호출 횟수 감소나 timeout 증대만으로 최신성을 증명하지 않음 | Q4 |
| <a id="D08"></a>D08 | 배제·보류 | false-only, timer-only 배처, quiet까지 기다리는 debounce, 모든 Event FIFO, 직접 delta cache 전환, 새 cache/queue 패키지 교체는 이번 해법에서 제외. Event별 targeted key 최적화와 별도 주기 제한은 correctness 확보 후 필요 시 검토 | P01–P06; 고정 stack/Event 계약 | 최소 범위를 유지하고 최신성·폭주 문제를 실제로 다루는 데 집중 | Q1/Q2/Q3/Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 공유 결과만 반환 | Query false-only·Go singleflight(후보) | 동시성은 줄여도 처리 중 새 변경의 후속 실행이 없음(E15) |
| 300ms 간격만 추가 | Paperclip batcher | burst 빈도 완화지만 느린 응답 사이 single-flight 보장 없음(E19). 300ms는 우리 제품 요구로 채택하지 않음 |
| 모든 Event를 순서대로 조회 | RxJS concatMap·p-limit/p-queue 후보 | 오래된 invalidation마다 FIFO를 쌓을 필요가 없음. 마지막 상태 회수와 다름 |
| busy 중 입력 폐기·이전 입력 취소 | exhaustMap·switchMap 후보 | 전자는 마지막 변경 유실, 후자는 진행 응답 반영 목표에 맞지 않음 |
| stream delta를 cache에 직접 적용 | ServerBee 후보 | 현재 Event는 모든 화면 snapshot 계약이 아님. revision/순서/재연결 reconciliation까지 확대됨 |
| 서버 run/wake 큐 재사용 | #53 기존 조사 | 브라우저 조회와 영속 실행 시도는 다른 생애주기·책임. 승인·조직 강제 계층도 그대로 유지 |

## 구현 참고

[코드 지도](../agents/code-map/organizations.md) 기준 `apps/web/src/live-events.ts`가 Event/ready 진입점, `api.ts`가 queryKeys·queryFn·mutation invalidation, `main.tsx`가 QueryClient/구독 생애주기다. 조율 책임은 `apps/web` 안에 둔다. `packages/core/db/runtime`로 웹 cache 의존성을 끌어들이지 않고 승인·최종 완료·조직 격리 정책을 바꾸지 않는다. helper 파일 분리·정확한 알고리즘은 #77 구현에서 결정한다.

비공식 상태 모형: **신호→해당 조회 dirty 표시→idle이면 조회 시작→현재 응답 즉시 반영→그사이 dirty면 후속 조회**. 이미 진행 중인 외부 조회에 합류하면 그 합류로 dirty를 지우지 않는다. paused는 idle/성공과 다르다. p-debounce의 최신 인자 한 슬롯은 **같은 key 안에서만** 참고하며 전체 조직을 한 슬롯에 넣지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 캐시가 있는 느린 조회 중 Event 여러 개 → 시작 때 revision 고정·gate 제어 → 같은 실제 query의 최대 HTTP 진행1, 기존 응답도 반영, 최종 revision 회수 | D01/D02/D07 |
| V02 | Event 단1개가 mount/focus에서 시작한 옛 조회 도중 도착 → 기존 Promise 합류 → 완료 뒤 반드시 새 상태 회수 | D02 |
| V03 | 초기 무캐시 조회 중 ready 또는 Event → default dedupe 경로 → 첫 응답만으로 복구 완료 처리하지 않음 | D02/D05 |
| V04 | 후속 조회마다 Event가 계속 옴 → 중간 gate를 하나씩 해제 → Event가 멈추기 전에도 완료 응답이 표시됨 | D01/D04 |
| V05 | ready 전체와 org prefix/exact·Inbox 갱신 중첩 → 같은 query 매칭 → 중복 시작·취소 없음 | D03/D05 |
| V06 | 조직 A의 느린 조회와 B의 Event → 독립 처리 → A가 B와 전역 목록/Inbox 완료를 불필요하게 막지 않음. A/B 응답은 각 cache에만 귀속 | D03 |
| V07 | fetch 오류/동기 예외·retry delay 중 Event → 종료/후속 처리 → busy 고착·무한 즉시 retry·오류 은폐 없음 | D06 |
| V08 | offline paused 중 Event·ready → aggregate resolve → 완료로 세지 않고 online/WS 복귀 뒤 마지막 상태 회수, busy loop 없음 | D06 |
| V09 | 비활성/disabled query·화면 전환 → invalidation → 비활성 fetch 강제 확대 없이 다시 관찰할 때 최신화. 남은 old fetch가 dirty를 지우는 경합 검사 | D04/D06 |
| V10 | mutation 성공의 직접 invalidate/setQueryData와 Event 겹침 → 전체 호출 경로 검사 → 취소 폭주 재발·dirty 소실 없음, mutation 성공 대기는 기존 의미 유지 | D05 |
| V11 | 요청 중 Root cleanup/재mount·socket 교체 → 이전 completion/timer 실행 → 정리된 coordinator가 새 조회를 시작하지 않음. 새 ready가 누락을 복구 | D05/D06 |
| V12 | 다른 탭에서 사본 저장·초기 승인 → 관찰 탭 HTTP snapshot을 잡아 지연+실제 Event burst → 사용자 입력 없이 revision/팀 수 표시, 요청이 계속 바뀌어 대기하지 않음 | D07 |
| V13 | WS 연결 끊김 사이 상태 변경 → 재연결 ready → 전체 snapshot 복구 유지. 조직 이동 중 늦은 A 응답이 B 화면을 덮지 않음 | D03/D05 |
| V14 | 기존 생성·대화·작업·연구 지도·사본 편집·승인/결과·일시정지/재개 E2E → 실행 → 기존 사용자 흐름과 draft 보호 통과 | D07; #77 AC3 |

E2E는 `page.route`에서 서버 응답을 먼저 받아 snapshot을 고정한 후 gate로 `fulfill`을 늦추거나, 동등한 제어 지점을 사용한다. 단순히 서버 조회 **이전**에 sleep하면 변경 뒤 snapshot만 보게 되어 trailing 유실을 놓칠 수 있다(추론: E15/E21). 실제 다른 탭/실제 Event E2E와 mock frame 기반의 결정적 입력 검사는 역할을 구분한다. 고정 5초 timeout 증대나 시스템 부하 재현만을 주 검사로 삼지 않는다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 정확한 조율 단위 | #77 | **권고:** 실제 query identity별 busy/dirty, 서로 독립 진행. **대안:** 겹치지 않는 scope별 조율. 후자는 global/organization 중첩과 느린 하위 조회 barrier를 V05/V06으로 증명해야 함(D03) |
| retry 소진 이후 | #77 / 사용자 | **권고:** 기존 Query의 제한된 retry·오류 표시를 유지하고 dirty는 다음 online/ready/Event/명시 재시도에 회수. **대안:** backoff로 제한된 자동 재시도 정책 추가. 영구 장애에서 “마지막 Event 뒤 반드시 반영”의 복구 조건을 구체화해야 하며 무한 즉시 retry는 배제(D06) |
| 별도 갱신 주기 상한 | #77 | **권고:** 완료 기준 직렬화부터 적용하고 고정 지연은 두지 않음. **대안:** 실제 측정으로 추가 비용이 남을 때 per-query 최소 간격을 더함. 간격은 최신성·진행 보장의 대체가 아님(P03) |

## 한계와 미확인

- 실행: 설치본 Query의 결정적 probe **9개 사례(결과 행10개)**, 원본 p-debounce2개·원본 Paperclip 배처2개의 독립 probe가 통과했다. p-debounce upstream test 파일도 실행했으나 Node reporter는 파일1개 통과만 출력하여 개별 assertion/test 수를 보고하지 않는다. 전체 lint/타입/배포 검사로 확대하지 않았다.
- **제품 hook·브라우저 다른 탭·느린 실제 HTTP·실제 WS 재연결·기존 제품 E2E는 실행하지 않았다.** 따라서 #77 AC를 충족했다는 보고가 아니다. 위 V01–V14는 구현 때 검증할 항목이다. 모형의 dirty 처리와 실제 React/Query lifecycle의 완전 일치를 주장하지 않는다.
- workqueue는 Go 실행기가 없어 소스·테스트 읽기만 했다. Paperclip 전체 제품·p-debounce 정식 npm test(lint/type 포함)·TanStack 전체 upstream suite는 실행하지 않았다. Paperclip probe는 visibility stub과 명시 flush를 사용해 타이머 간격·브라우저 시각 효과를 관찰한 것이 아니다.
- 최초 sandbox GitHub 네트워크가 실패해 승인된 네트워크 확장으로 공개 원문을 읽었다. 일부 RxJS 문서는 JS 요구로 본문 확인이 어려워 안정 tag 소스로 대체했다. 약한 제품 후보는 검색 결과만 있으며 결정 근거에 쓰지 않았다. 로그인·유료 API·실제 모델·실제 연구 데이터는 사용하지 않았다.
- 조사용 소스·모형은 git 무시 캐시에만 있다. 제품 코드·제품 테스트·설정 변경과 commit/push/PR·이슈 close는 하지 않았다. 조사 문서는 구현 변경과 함께 검토·커밋하도록 남긴다.
- 재확인 필요: upstream SHA/설치 버전 변경, inactive/paused/오류 소진의 실제 recovery, mutation/focus/route와의 경합. 코드 이식으로 범위가 바뀌면 파일 header·NOTICE·전이 의존성과 `THIRD_PARTY_NOTICES.md`를 별도로 심사한다.
