# 고정 시간 대기와 비동기 시험 레퍼런스

이 문서는 늦은 응답의 순서를 만드는 방법과 외부 상태를 기다리는 방법을 비교한다. 저장소의 시험 작성 규칙은 [코드 작성 기준](../../CODING_STANDARDS.md#시간)에 있다.

조사일 2026-11-18. 저장소 기준 커밋 `7c6fa649fd62d658289a0baf86f137b37c20b8d5`. 저장소 기준 판은 Playwright 1.65.1, Vitest 5.0.5, Node.js 24 계열이다. 외부 공식 문서는 조사일에 공개된 판을 읽었고, 구현을 직접 읽은 곳은 태그나 커밋을 표시했다. [웹 패키지](../../apps/web/package.json) · [루트 패키지](../../package.json)

## 결론 요약

- **질문 1. 늦은 GET은 시험이 직접 풀어 준다.** 먼저 시작한 조회가 아직 응답을 받지 않은 동안 같은 조회를 갱신하는 후속 Event를 처리하게 한다. 이 순서를 Promise로 만들어 두면 느린 실행기에서도 경합을 재현할 수 있다. `setTimeout(() => route.fulfill(…), 800)`은 기존 800ms 지연과 같은 조건을 만들기 때문에 후속 Event가 늦으면 경합 없이 통과할 수 있다. 브라우저에 응답을 보내기 전에 이전 서버 응답을 확보하고, 해제 후 후속 조회와 화면 결과를 확인한다. [실시간 갱신 E2E](../../apps/web/e2e/live-refresh.spec.ts) · [Playwright의 실제 응답 가로채기](https://playwright.dev/docs/mock#modify-api-responses)
- **질문 2. 조건과 상한이 있는 폴링은 통용되는 방식이다.** 준비나 종료를 직접 알리는 신호가 있으면 먼저 쓴다. `boot-check`의 프로세스 목록·PID 검사와 E2E 서버 지원 코드의 Postgres PID 검사는 직접 종료 이벤트를 받을 수 없는 후손의 상태를 확인하므로, 첫 확인은 즉시 하고 실패한 확인 사이에만 타이머를 두는 폴링을 유지할 수 있다. E2E API 서버의 시작은 이미 완전한 stdout 준비 줄을 기다린다. [boot-check](../../scripts/boot-check.test.mjs#L552) · [E2E 서버 지원 코드](../../apps/web/e2e/support/server-process.ts#L258) · [Fowler의 비동기 시험 지침](https://martinfowler.com/articles/nonDeterminism.html#AsynchronousBehavior)

## 질문 1. 늦은 응답과 요청 경합

현재 두 E2E는 초기 연구 승인 뒤 다른 탭에 작업자 두 명이 보이는지, 외부 저장 뒤 편집 탭에 새 revision이 표시되면서 draft가 유지되는지를 본다. 두 시험 모두 같은 GET URL에서 동시에 진행된 route의 최대 수가 1인지 검사한다. 현재 `slowGets`는 요청이 들어오면 바로 `route.fetch()`를 시작하고 서버 응답을 받은 뒤 800ms 뒤에 브라우저로 돌려준다. 최종 화면과 최대 수가 맞아도, 응답이 보류된 동안 후속 Event가 처리됐는지는 별도로 확인할 필요가 있다. [두 E2E](../../apps/web/e2e/live-refresh.spec.ts#L10) · [갱신 조율 코드](../../apps/web/src/live-refresh.ts)

| 방식 | 출처 | 장점 | 단점 | 이 저장소 적용성 |
| --- | --- | --- | --- | --- |
| Promise로 요청을 붙잡고 시험에서 해제 | [Playwright `page.route`와 `route.fetch`/`fulfill`](https://playwright.dev/docs/mock) · [Google Testing Blog의 시작·해제·완료 신호 예제, 2008](https://testing.googleblog.com/2008/08/#:~:text=Sleeping%20!%3D%20Synchronization) | 요청 시작, 응답 보류, 해제 순서를 직접 정해 실행기 속도에 덜 민감하다. 실제 서버 응답을 사용하거나 고정 응답을 써서 조건을 더 좁힐 수 있다. | 실패 시 보류한 요청을 정리해야 한다. 실제 서버와 Event까지 제어하면 연결과 신호를 맞추는 코드가 늘어난다. | **우선 권고.** 아래 순서로 적용한다. 정해진 응답만으로 충분한 로딩 화면 시험은 가짜 응답으로도 가능하다. |
| 가짜 시계 | [Playwright Clock](https://playwright.dev/docs/clock) · [Vitest 타이머](https://vitest.dev/guide/mocking/timers) · [Sinon Fake Timers](https://github.com/sinonjs/fake-timers#readme) | 재시도, 디바운스, 만료처럼 시간 자체가 기능일 때 가상 시간을 원하는 만큼 진행해 경계를 재현한다. | 어느 실행 환경의 타이머와 Promise를 진행하는지 알아야 한다. 브라우저의 `page.clock`은 Node의 route 콜백이나 실제 서버의 시계를 제어하지 않는다. Vitest/Sinon도 설치한 실행 환경에 적용된다. | 브라우저 재연결의 대기나 조회 재시도 시간 시험에 적합하다. 두 E2E의 Event와 GET 전달 순서에는 별도 신호가 필요하다. |
| 정해진 지연이나 전송 속도 흉내 | [MSW `delay` 3.x 문서](https://mswjs.io/api/delay) · [Cypress `cy.intercept` 응답 설정](https://docs.cypress.io/api/commands/intercept#Intercepted-responses) | MSW `delay(ms)`, Cypress `delay`/`setDelay`·`setThrottle`로 느린 응답과 전송을 짧게 표현한다. Cypress `req.continue(callback)`은 실제 서버 응답을 받은 뒤 콜백에 넘긴다. 콜백이 반환한 Promise를 기다리므로 순서 제어에도 쓸 수 있다. | 실제 시간 지연은 시간을 소비하고 Event와의 순서를 보장하기 어렵다. MSW의 인자 없는 `delay()`는 실행 환경에 따라 다르고, Cypress의 지연·속도 제한도 실제 네트워크의 일부 특성만 흉내 낸다. | 일정 지연이나 느린 전송이 시험 조건일 때 적합하다. 이번 800ms를 다른 지연 API로 옮기면 경합 재현 조건은 그대로다. |
| 응답을 계속 보류 | [MSW `delay('infinite')`](https://mswjs.io/api/delay#delay-modes) | 응답이 오지 않을 때의 로딩, 취소, 클라이언트 타임아웃을 만들기 쉽다. | 시험이 눌러서 응답을 풀어 줄 수 있는 API가 아니다. 종료·취소 경로를 갖춰야 하며 같은 응답의 완료 이후 상태를 한 흐름에서 확인하기 어렵다. | 응답 없는 서버를 별도로 시험할 때 맞는다. 조회 완료 뒤 최종 화면을 보는 이번 시험에는 해제할 수 있는 Promise가 맞는다. |
| 화면·네트워크 신호를 기다림 | [Playwright `waitForTimeout` 지침](https://playwright.dev/docs/api/class-page#page-wait-for-timeout) · [Testing Library 비동기 API](https://testing-library.com/docs/dom-testing-library/api-async/) · [Cypress 공식 대기 지침](https://docs.cypress.io/app/core-concepts/best-practices#Unnecessary-Waiting) | 화면 표시, 사라짐, 특정 요청·응답을 기다리므로 성공할 때 바로 진행한다. Cypress는 경로 별칭 대기를, Playwright는 자동 재시도 단언과 이벤트 대기를 안내한다. | 신호를 기다리는 것만으로는 응답이 언제 올지 정하지 못한다. HTTP 응답 수신과 앱의 처리·렌더링 완료는 시점이 다르다. | 보류 중 화면 상태와 해제 뒤 결과를 검사하는 데 사용한다. 경합의 순서는 응답 해제 신호로 제어한다. |

Playwright와 Cypress는 임의 시간 대기를 피하라고 공식적으로 안내한다. Playwright에서 실제 응답을 받아 다시 전달하거나 응답 전체를 가짜로 만드는 것은 공식 문서에 나온 방법이다. 응답 해제 시점을 Promise로 제어하는 방식은 이 API와 아래 오픈소스 시험에서 확인한 관행이다. 조사 범위에서 이를 의무화한 공통 표준은 확인하지 못했다. [Playwright 모의 응답](https://playwright.dev/docs/mock) · [Cypress 공식 대기 지침](https://docs.cypress.io/app/core-concepts/best-practices#Unnecessary-Waiting)

### 두 E2E에 적용하는 순서

1. 첫 화면과 Event 구독의 준비를 확인한다. 대상 조직의 시험용 GET을 골라 잡고, 서버 응답의 내용까지 확보한 뒤 시험에 시작 신호를 알린다. 요청 도착만 보고 변경을 시작하면 서버가 GET을 처리할 때 이미 새 값이 들어갈 수 있다. `lead-chat` E2E에 `route.fetch() → Promise 대기 → route.fulfill()`과 정리 선례가 있다. [기존 E2E의 응답 보류](../../apps/web/e2e/lead-chat.spec.ts#L17) · [#211 늦은 조회 조사](issue-211-references.md#구현-참고)
2. 이전 응답을 붙잡은 상태에서 같은 조회를 갱신하는 Event가 탭에 닿도록 한다. 실제 Event를 `routeWebSocket`으로 중계한다면, 첫 Event를 보낸 뒤 GET 보류를 확인하고 모아 둔 후속 Event를 전달할 수 있다. 기존 재연결 시험의 중계 방식을 참고한다. 서버에서 Event를 봤다는 사실이나 중계에서 `send`를 호출한 사실만으로 탭 안의 처리 완료 시점을 확정할 수는 없다. 순서를 검사하려면 브라우저 측에서 Event가 처리됐다는 신호가 있어야 한다. [기존 재연결 시험](../../apps/web/e2e/live-refresh.spec.ts#L119) · [구독 준비 도구의 적용 범위](../../apps/web/e2e/support/live-events.ts#L21) · [Playwright WebSocket 중계](https://playwright.dev/docs/api/class-websocketroute#web-socket-route-connect-to-server)
3. 해제 뒤에 새 조회가 실제로 시작됐는지와 최종 상태를 본다. 중복 요청이 없었다는 검사는 후속 Event 처리와 조회 완료를 확인한 뒤 한다. 최종 화면의 값이 이전 응답에 이미 들어 있더라도 후속 조회를 확인할 수 있게 하고, 가능하면 이전 응답과 최종 응답에 구별되는 값을 쓴다. 주소별 최대 진행 수와 각 시험의 팀·revision·draft 단언을 유지한다. 실패하더라도 `finally`에서 보류한 route를 풀거나 종료한다. [두 E2E의 기존 단언](../../apps/web/e2e/live-refresh.spec.ts#L50) · [조회 직렬화와 후속 갱신](../../apps/web/src/live-refresh.ts)
4. 탭의 처리 신호를 얻기 위해 E2E가 크게 복잡해지면 기존 Vitest 시험에서 경합 순서를 검사하고, E2E에서는 실제 서버의 Event와 화면 갱신을 확인하는 구성이 가능하다. 기존 Vitest는 요청 시작에 응답 값을 고정하고, 초기 응답을 풀기 전에 후속 신호를 넣으며, 값·호출 수·최대 진행 수를 확인한다. 그 시험의 `flush`는 고정된 이벤트 루프 차례 수를 가정한다는 별도 한계가 있다. [Vitest 시험](../../apps/web/src/live-refresh.test.ts#L9) · [저장소 순서 기준](../../CODING_STANDARDS.md#순서)

## 질문 2. 조건을 다시 확인하는 타이머

Fowler는 비동기 완료의 알림을 먼저 쓰고, 알림을 받을 수 없으면 조건을 상한 안에서 다시 확인하라고 권한다. 타이머는 재확인 간격이나 실패 상한을 정하는 데 쓰인다. 성공 여부는 확인한 상태로 결정된다. 느린 실행기나 일시적인 상태를 감안해 적절한 상한과 확인 대상을 정해야 한다. [Eradicating Non-Determinism in Tests, 2011](https://martinfowler.com/articles/nonDeterminism.html#AsynchronousBehavior) · [Google Testing Blog, 2008](https://testing.googleblog.com/2008/08/#:~:text=Sleeping%20!%3D%20Synchronization)

| 방식 | 출처 | 장점 | 단점 | 이 저장소 적용성 |
| --- | --- | --- | --- | --- |
| 준비 줄·IPC·종료 이벤트 | [Node.js 24.21.0 `ChildProcess` 문서](https://github.com/nodejs/node/blob/v24.21.0/doc/api/child_process.md) · [`events.once`](https://nodejs.org/api/events.html#eventsonceemitter-name-options) | 듣고 있던 신호가 도착하면 바로 끝난다. `exit`, 출력 스트림까지 닫히는 `close`, 준비 줄을 각각 기다릴 수 있다. | 등록이 늦으면 신호를 놓친다. 완전한 줄을 조립하고 오류·조기 종료·시한을 다뤄야 한다. 얻을 수 있는 신호는 해당 자식이나 협력하는 프로세스에 한정된다. | 직접 띄운 API 서버의 준비 줄과 자식의 종료에 이미 사용한다. Postgres 후손의 PID나 프로세스 목록에는 같은 자식 핸들이 없다. |
| 시험 도구의 자동 재확인 | [Testing Library `waitFor`](https://testing-library.com/docs/dom-testing-library/api-async/#waitfor) · [Vitest `vi.waitFor`/`vi.waitUntil`](https://vitest.dev/api/vi.html#vi-waitfor) · [Playwright `expect.poll`/`toPass`](https://playwright.dev/docs/test-assertions#expectpoll) | Testing Library는 바로 검사한 뒤 간격과 DOM 변경으로 재검사한다. Vitest `waitFor`는 예외나 거절 시, `waitUntil`은 거짓인 결과일 때 재시도한다. Playwright는 `poll`의 값이나 `toPass`의 단언을 재시도한다. | 콜백이 여러 번 실행되므로 부수 효과가 없는 검사가 맞는다. 조건이 잠깐만 참이면 확인 사이에 놓칠 수 있다. Playwright `toPass`는 자체 기본 상한이 0이므로 상한을 명시한다. | 각 러너 안에서 그 도구를 사용한다. 두 대상 헬퍼는 각각 `node:test`와 Playwright 전역 준비·정리에서도 동작하는 Node 코드다. |
| 상한이 있는 작은 Node 폴링 | [Node.js 24.21.0 `node:test`](https://github.com/nodejs/node/blob/v24.21.0/doc/api/test.md) · [`node:timers/promises`](https://github.com/nodejs/node/blob/v24.21.0/doc/api/timers.md#timers-promises-api) · [Fowler의 폴링 예제](https://martinfowler.com/articles/nonDeterminism.html#AsynchronousBehavior) | 외부 상태를 즉시 검사하고 이후 간격을 두고 확인한다. 러너 의존성이 없다. `node:test`는 조건 폴링 API를 따로 제공하지 않으며, 비동기 시험의 Promise와 전체 시험의 시한을 지원한다. | 검사 비용과 간격, 시간 초과·취소·진단을 정해야 한다. 개별 검사가 오래 걸리면 확인 사이의 deadline 검사만으로 전체 시간을 엄격히 제한할 수 없다. | 두 헬퍼에 적합하다. `setTimeout(poll, N)`을 쓰는 경우에도 매번 같은 조건을 재확인하고, 정해진 시한 뒤 성공 여부를 호출부에 돌려준다. |
| 범용 라이브러리 | [`p-wait-for` README](https://github.com/sindresorhus/p-wait-for#readme) · [`wait-on` README](https://github.com/jeffbski/wait-on#readme) | `p-wait-for`는 Node에서 임의의 참/거짓 조건을 재검사한다. `wait-on`은 파일·포트·HTTP 등의 준비나 사라짐을 CLI/API에서 확인한다. | 두 문서에서 기본 상한은 무한이다. 유한 상한을 설정해야 한다. `p-wait-for`에서 대기를 취소해도 진행 중인 조건 검사 자체는 취소되지 않는다. | 단순한 두 PID·목록 판정에 기존 작은 헬퍼를 쓰면 된다. 공통으로 기다리는 자원이 늘어날 때 라이브러리의 진단과 설정을 비교할 수 있다. |
| Playwright `webServer` 준비 확인 | [Playwright 공식 설정](https://playwright.dev/docs/test-webserver#configuring-a-web-server) · [1.65.1 준비 대기 구현](https://github.com/microsoft/playwright/blob/v1.65.1/packages/playwright/src/plugins/webServerPlugin.ts#L169-L225) | `url` 응답을 확인할 때 내부에서도 100, 250, 500ms, 이후 1초 간격으로 폴링한다. `wait`는 stdout/stderr 정규식 신호를 기다린다. | `url`과 `wait`를 함께 주면 둘 중 먼저 만족한 조건으로 통과한다. URL 가용성은 그 URL이 표현하는 범위까지만 보장한다. Windows에서는 정상 종료 설정이 적용되지 않는다. | 웹 preview 준비에는 이미 쓴다. API 서버는 Windows에서도 종료와 정리를 기다려야 하므로 현재처럼 `globalSetup`이 관리한다. 이 설정은 Postgres 후손의 종료 확인을 맡지 않는다. [현재 설정](../../apps/web/playwright.config.ts#L20) |

두 헬퍼의 상한은 폴링을 끝내는 기준이다. 구현을 손볼 때는 첫 검사 즉시 실행, 검사 간 중복 없음, 조건 만족 시 즉시 반환을 보존한다. 상한이 지난 뒤 호출부가 어떤 PID나 폴더에서 실패했는지 드러나야 한다. 앞으로 해당 프로세스의 실제 종료를 안정적으로 전달하는 신호를 얻을 수 있다면 그 신호를 기다린다. [boot-check의 후손 정리](../../scripts/boot-check.test.mjs#L409) · [E2E의 Postgres 종료 확인](../../apps/web/e2e/support/server-process.ts#L415)

## 오픈소스 시험 사례

아래 표는 각 커밋의 시험 소스를 읽어 확인한 사례다.

| 프로젝트·커밋 | 확인한 방식 | 코드 |
| --- | --- | --- |
| Playwright `8124fc39233c4c349b9dbebd4abc4103738eae81` | Trace Viewer의 HTTP 응답 헤더를 보내고 본문을 붙잡는다. 로딩 대화상자가 표시되면 본문을 보내고, 대화상자가 사라지고 결과가 보이는지 확인한다. | [HTTP 응답을 보류하는 로딩 시험](https://github.com/microsoft/playwright/blob/8124fc39233c4c349b9dbebd4abc4103738eae81/tests/library/trace-viewer.spec.ts#L2473-L2494) |
| Playwright `8124fc39233c4c349b9dbebd4abc4103738eae81` | 첫 스타일시트 GET을 보류하고 새로고침 요청이 도착하면 해제한다. 대상 HEAD 요청과 스냅샷에 적용된 스타일을 확인한다. | [새로고침과 리소스 로딩 경합 시험](https://github.com/microsoft/playwright/blob/8124fc39233c4c349b9dbebd4abc4103738eae81/tests/library/trace-viewer.spec.ts#L1611-L1639) |
| MSW `b3df8504adc30538e9634a46b7303a850a817928` | `request:start`와 응답 해제를 별도 Promise로 제어한다. 요청이 진행 중일 때 워커를 멈추게 하고, 응답을 해제한 뒤 요청 결과를 확인한다. `afterEach`에서도 응답을 해제한다. | [워커를 멈출 때 진행 중인 요청 시험](https://github.com/mswjs/msw/blob/b3df8504adc30538e9634a46b7303a850a817928/test/msw-api/setup-worker/stop/in-flight-request.browser.test.ts#L4-L47) |
| React Router `c9a237a0bd095714fd0111c7e49e18768e1eb8ba` | 첫 조회와 교체 조회를 별도 Promise로 제어한다. 첫 요청의 취소를 확인하고 오래된 값을 먼저 풀어 준 뒤, 새 응답만 반영되는지 본다. 보조 함수 `tick()`에는 0ms 타이머가 있으며 두 응답의 순서는 Promise 해제로 정한다. | [조회 경쟁 시험](https://github.com/remix-run/react-router/blob/c9a237a0bd095714fd0111c7e49e18768e1eb8ba/packages/react-router/__tests__/router/fetcher-discovery-revalidation-race-test.ts#L173-L253) · [`tick` 구현](https://github.com/remix-run/react-router/blob/c9a237a0bd095714fd0111c7e49e18768e1eb8ba/packages/react-router/__tests__/router/utils/utils.ts#L3-L9) |

## 조사 범위와 미확인

- 공식 문서, 고정된 오픈소스 코드, 저장소의 기존 시험과 설정을 읽었다. 오픈소스 시험과 브라우저 E2E를 실행하지 않았고, 느린 Windows·macOS 실행기에서 지연 간격이나 실패율을 측정하지 않았다.
- E2E에서 탭의 후속 Event 처리 완료를 확인할 위치와 두 서버 동작에서 구별되는 응답 값을 만들 수 있는지는 구현 시 확인할 사항이다. 현재 코드만으로 시나리오별 변경 전후 실패 여부까지 확인하지 않았다.
- 외부 도구의 공개 문서는 조사일 기준이다. MSW 지연과 가짜 시계의 조합은 판과 실행 환경에 따라 달라질 수 있으며, 이 저장소에 설치하거나 실행해 확인하지 않았다.
