# issue-63 레퍼런스 조사: 판 1 · 데모 시나리오와 흐름 전체 E2E

조사일: 2026-10-27. 대상: [#63](https://github.com/babo-jeonguk/BaboJUBot/issues/63), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49). 구현 전 기술 권고이며 확정 계약이나 구현 완료가 아니다. 상세 자료: `.reference-cache/issue-63/`(git 무시). 제품 적합성 확인 기준 SHA: `71345a2be52f8b524b643c7ce25d31421c62a5b1`.

[이슈 receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/63#issuecomment-6433163794)를 게시한 뒤 다시 읽어 로컬 receipt 본문과 완전히 일치하고 #63이 열린 상태임을 확인했다.

## Brief

- 구현할 문제: 기본 가짜 실행기로 대시보드 조직 생성부터 사용자 최종 완료까지 직접 눌러 보고, Playwright 한 흐름으로 지킨다. 중간에 일시정지·재개와 작업자 추가 정책을 켠 뒤 승인하는 장면을 포함하고 README의 시작·검증 명령과 판 1 상태를 갱신한다.
- 동종 문제: 비동기 업무의 실제 상태 변경 경로를 통과하는 결정적 fake 실행기와 사용자 승인 경계를 지나는 브라우저 통합 검증.
- 고정된 결정: [구조](../architecture.md#제품-불변-조건-강제-위치)·[기능](../features.md#웹-대시보드-화면-지도)·[용어](../../GLOSSARY.md)·[ADR1](../adr/0001-adapter-control-plane.md)·[ADR2](../adr/0002-durable-records-and-wakes.md)·[ADR3](../adr/0003-configurable-approval-policy.md)·[ADR4](../adr/0004-paperclip-aligned-stack.md)를 따른다. 초기 승인은 항상 필요하고 최종 완료는 사용자만 결정한다. fake도 실행 시도 token의 실제 조직 도구 HTTP를 사용한다. 조직별 기록·기억을 분리하고 실제 모델·유료 API·새 workflow/기억 엔진은 포함하지 않는다.
- 최신 범위: blocker #56/57/58/59/60/61/62/64는 모두 closed. [#63 인계](https://github.com/babo-jeonguk/BaboJUBot/issues/63#issuecomment-6312257963)에 따라 작업 완료 뒤 Lead 대화로 결과 제출을 부탁한다. [#64 제외 확인](https://github.com/babo-jeonguk/BaboJUBot/issues/63#issuecomment-6162232829)에 따라 사본 편집을 새 E2E 단계로 추가하지 않는다. Inbox는 [#61 최신 정정](https://github.com/babo-jeonguk/BaboJUBot/issues/61#issuecomment-6411357116)(주의 필요·전체·읽지 않음·보관됨, 실패만 보관)을 따른다.
- 현재 차이: 전체 데모의 핵심 동작은 이미 기본 runtime에 있다(E01–E03/E06). 남은 검증 공백은 주요 사용자 행동을 한 테스트에서 모두 UI로 수행하는 연결과 개발 안내다. 이번 조사로 #63을 닫거나 구현을 시작하지 않는다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 실제 도구·승인·조직 경계를 거치는 기본 데모와 테스트 시나리오를 어떻게 재사용하는가? | #63 What to build, #49 이야기83, ADR1/2/3 | Source Recon + runtime/failure·adversarial scenario |
| Q2 | 비동기 상태·사용자 승인 대기를 sleep/networkidle/과도한 mocking 없이 어떻게 검증하는가? | #63 AC1/2, #49 Testing Decisions·이야기84 | 공식 도구·Source Recon + Behavioral Recon |
| Q3 | 서버·DB·브라우저의 준비/격리/실패 정리를 어떻게 보장하는가? | #63 기본 dev·AC3, #49 이야기81/82/86 | Source Recon + persistence/recovery·failure |
| Q4 | 통합 여정의 부정 검증과 기존 API/기능 E2E의 범위, pause/resume·정책·heartbeat 배치는? | #63 AC1–4·#64 제외 댓글, AGENTS 핵심 경계 | Source Recon + adversarial scenario·clock probe |

| 재사용한 조사 | 쓰는 범위 | 재확인·판단 |
|---|---|---|
| [#1](issue-1-references.md#brief)·[코드 구조](reference-code-structure.md#프로젝트별-구조와-참고-지점)·[비교 조사](comparative-survey.md) | 후보·seam 탐색 출발점 | 확정 스택은 ADR4 우선. 과거 실행 수치/소스 E를 새 근거로 복제하지 않음 |
| [#53](issue-53-references.md#결정-권고) | fake/clock/gate/drain·token HTTP | 현행 scripted/support/dispatcher와 E06에서 재확인. drain은 실행 가능한 후속 처리의 안정화이며 paused/closed wake 소멸 보장이 아님 |
| [#54](issue-54-references.md#결정-권고)·[#55](issue-55-references.md#결정-권고)·[#56](issue-56-references.md#결정-권고) | 초기 승인·팀/작업/산출물/지도 연결 | 최신 완료 댓글·현행 demo 원문·E06/E07 재확인. 지도 전체 종류나 구조 편집 시나리오를 #63으로 확대하지 않음 |
| [#57](issue-57-references.md#결정-권고)·[#58](issue-58-references.md#결정-권고)·[#59](issue-59-references.md#결정-권고) | 사용자 결과 결정·정책·제어 | 닫힌 이슈의 결정 우선. E06 및 현행 각 기능 spec 읽기. 이전 열린 정책을 다시 열지 않음 |
| [#60](issue-60-references.md#결정-권고) | 서버 clock·heartbeat·복구·같은 호출 키 | 최신 #60 완료/README와 E03/E06 확인. 과거 기억 제품 비교는 이번 결정에 불필요 |
| [#61](issue-61-references.md#결정-권고)·[Inbox 상세](inbox-detail-references.md#결정-권고) | Inbox 진입·결정과 정리 구별 | #61의10/26 정정으로 과거 Working/보관 권고를 대체. 이번 scope에서 outbox 전체 재구현/재검증하지 않음 |
| [#62](issue-62-references.md#결정-권고)·[#77](issue-77-references.md#결정-권고) | 관찰 지표와 Event 뒤 HTTP 수렴 | #62 완료·현행 config/기능 spec 확인. 새 E2E는 reload나 route fake로 실시간 회귀를 숨기지 않음 |
| [#64](issue-64-references.md#결정-권고)·[#50](issue-50-references.md#결정-권고)·[#51](issue-51-references.md#결정-권고) | 사본/화면·지도 배치 범위 | 확정된 UI 의미만 재사용, 신규 배치 권고·타사 화면/캡처 재사용 없음. #64는 자체 검증에 남김 |
| 기존 `.reference-cache/` | 후보와 checkout 찾기 | 기존 조사 원문 근거를 직접 승격하지 않음. 이번 고정 ref 원문을 새로 읽어 과거 ref blob 동일성을 주장하지 않음 |

## 레퍼런스

후보32행 중 MSW 중복1행을 제거한 **31개**, 외부 심층 **7종**이다. 현행 BaboJUBot은 외부 후보 수에서 제외한 적합성 확인이다. 전체 목록·URL·실행 경로·선정/제외 이유는 `.reference-cache/issue-63/candidates.md`에 있다. 검색 snippet만인 후보는 발견 기록이며 결정 근거에서 제외했다.

| 관점 | saturation 근거 |
|---|---|
| A OSS fake/demo·승인 | 4라운드: 공식 SDK/제품 → stateful mock 대안 → 승인 gateway/실패 PR → 사용처 교차검색. 마지막 integration 후보는 provider seam·tool gate·UI 모형의 기존 변형으로 수렴 |
| B 브라우저 도구·격리 | 4라운드: 공식 문서/패키지 → source symbol → 인접 runner·orchestrator → 실패/재사용 검색. 마지막은 조건 대기·callback 반복·준비/정리·shared state 범주 반복 |
| C 인접 workflow·상태기계 | 4라운드: 공식 문서 → tests → Restate/실패 보고 → releases/사용처. 마지막은 replay·시간 공유·임시 backend/정리 범주 반복 |
| 메인 대조 | 현재 Paperclip config·planning/signoff fixture·history를 추가 확인했으나 위 범주 외 새 패턴 없음. 포화는 이 질문·검색 범위의 판단이고 전수조사 주장이 아님 |

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Playwright | 기존 도구 | 1.58.2 / `ce480a952553175eae75342aad2c5e86cdf2cbba` | Apache-2.0·NOTICE 확인 | 소스·제한 실행 | 설치 버전의 기다림·webServer·clock/fixture 계약 |
| Paperclip | 운영 OSS | `ea727dc3c2a14660635f30cdba09f7790ac5603d` | MIT | 소스·테스트 읽기 | 같은 스택·throwaway 환경·승인 대기·API/UI 혼합 한계 |
| Vercel AI SDK | provider 부품 | `95348b32c6ef9aec688db1021ff921dfe94f8f12` | Apache-2.0 | 소스·pure mock 실행 | provider fake와 실제 승인 gate 분리·중복 회귀 |
| Alexa-plus | 작은 hackathon OSS | `42fd28e61cf7839ecbfed6a9775dc1e4a0b0c34b` | MIT | 소스·테스트 읽기 | 공유 script·실제 HTTP·사용자 confirmation 대기. 운영 내구성 근거로 쓰지 않음 |
| assistant-ui | UI demo 반례 | `7d6cf6a923b5381cd5ee64847a2269f4b1b962a5` | MIT | 소스·pure adapter 실행 | tool result가 보이는 시연과 실제 효과 검증의 차이 |
| Temporal TS SDK | 인접 workflow | `7d27a7ff5937c62954f61fce962370e1440b3bbf` | MIT | 소스·테스트/JSDoc 읽기 | 실제 workflow+대체 외부 효과·공유 clock·신호 대기 |
| XState | 상태기계·clock 부품 | `060cd63378b46b32e7559d569ed3ad112ee60084` | MIT | 소스·clock만 실행 | 금지 이벤트 누락·하위 완료/전체 완료·clock 경계. v6 계열 HEAD를 stable API로 간주하지 않음 |

확인일은 모두2026-10-27. 각 대상의 진입→상태 변경→계약→테스트→실패→이력은 캐시 `recon/`에 기록했다. **설계 참고만** 권고한다. 코드 복사를 하려면 해당 SHA의 LICENSE/header/NOTICE/함께 오는 의존성을 별도 검토하고 출처·고지를 추가해야 한다.

## 근거

26개: 실행 확인6·소스 확인18·문서 주장2. 적용 판단은 아래 패턴·권고의 추론이며 원본에서 확인한 사실과 구별한다. worker 보고에 쓴 원문을 메인이 다시 열어 `main-verification.md`에 일치·범위를 기록했다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 서버의 기본 runtime은 createScriptedRuntime이고 selector가 Lead/작업자 데모를 고른다. 개발·E2E main은 runtime을 덮어쓰지 않는다. | [기본 runtime](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/apps/server/src/app.ts#L132-L146); [기본 selector](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/packages/runtime/src/scripted.ts#L641-L654) | 소스 확인 |
| <a id="E02"></a>E02 | 목표 메시지 파싱→승인 요청, 초기 승인→작업 분담, 사용자 부탁→작업자 추가/결과 제출이 이미 있다. 작업자는 산출물→템플릿 첫 종류 노드→작업 연결→완료를 수행한다. | [demoLeadScript](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/packages/runtime/src/scripted.ts#L186-L333); [demoWorkerScript](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/packages/runtime/src/scripted.ts#L541-L615) | 소스 확인 |
| <a id="E03"></a>E03 | fake는 실행 시도 token/AbortSignal의 실제 tools client를 사용하고, wake 묶음·도구별 쓰기 번호로 Idempotency-Key를 정한다. 각 단계 전후 abort를 확인한다. | [createScriptedRuntime.execute](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/packages/runtime/src/scripted.ts#L670-L754) | 소스 확인 |
| <a id="E04"></a>E04 | 기존 결과 검토 E2E는 생성·목표·초기 승인을 API로 준비하며, 완료 뒤 새 실행 부재는 1초 waitForTimeout으로 확인한다. 전체 사용자 여정을 검증하는 테스트와 범위가 다르다. | [API setup](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/apps/web/e2e/result-review.spec.ts#L20-L53); [완료 뒤 검사](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/apps/web/e2e/result-review.spec.ts#L163-L171) | 소스 확인 |
| <a id="E05"></a>E05 | 현 E2E는 전용 포트·임시 DB·빈 DATABASE_URL·workers1·reuse=false·SIGTERM·retain-on-failure다. main은 외부 DATABASE_URL을 임시 DB flag보다 먼저 검사한다. | [E2E config](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/apps/web/playwright.config.ts#L3-L51); [DB 선택](https://github.com/babo-jeonguk/BaboJUBot/blob/71345a2be52f8b524b643c7ce25d31421c62a5b1/apps/server/src/main.ts#L21-L34) | 소스 확인 |
| <a id="E06"></a>E06 | 기본 fake+실제 token HTTP+임시 PG 조사 probe 5시나리오·73assertions 통과. 승인 전 작업/작업자0, 승인 후 작업·산출물·노드 각2, pause 입력 보존/resume, 정책 승인 후 worker2→3, heartbeat, 사용자 최종 완료, 교차조직404·종료/무토큰401을 확인했다. | 캐시 `probes/product-flow.mjs`, `product-flow-log.txt`, `run-log.txt`. Node24.21.0. 서버 구성 clock 주입·DB 직접 쓰기0. Runtime wrapper의 호출 관찰도 포함하므로 순수 외부 seam 테스트와 구별 | 실행 확인 |
| <a id="E07"></a>E07 | 기존 조직 생성·초기 승인·결과 검토 E2E 4건이 실제 main+임시 PG+production UI+Chromium에서 통과(55.8s). 새 #63 전체 흐름 구현 결과는 아니다. | 캐시 `probes/existing-e2e-log.txt`; 기존 세 spec 무변경, Playwright1.58.2·workers1 | 실행 확인 |
| <a id="E08"></a>E08 | locator expect는 즉시 한 번 확인 후 필요하면 deadline까지 반복한다. expect.poll은 generator를 반복 호출하므로 그 안의 변경 연산도 반복될 수 있다. | [Frame.expect](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/packages/playwright-core/src/server/frames.ts#L1383-L1423); [pollMatcher](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/packages/playwright/src/matchers/expect.ts#L367-L402) | 소스 확인 |
| <a id="E09"></a>E09 | webServer는 이미 가용한 URL이면 reuse=true에서 command/env 확인 없이 재사용하고 false는 거부한다. 새 process는 readiness timeout/early-exit를 감시하고 gracefulShutdown 때 process group에 signal을 보낸다. | [setup/start/teardown](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/packages/playwright/src/plugins/webServerPlugin.ts#L67-L139); [readiness](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/packages/playwright/src/plugins/webServerPlugin.ts#L182-L203) | 소스 확인 |
| <a id="E10"></a>E10 | page.clock은 context init script와 frame 평가에 적용된다. 기본 page fixture의 per-test newContext/close에는 서버 DB reset이 없다. | [Clock](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/packages/playwright-core/src/server/clock.ts#L73-L109); [context fixture](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/packages/playwright/src/index.ts#L349-L390) | 소스 확인 |
| <a id="E11"></a>E11 | retain-on-failure는 첫 실행부터 trace를 수집하고 on-first-retry는 retry===1에서만 수집한다. | [trace capture](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/packages/playwright/src/worker/testTracing.ts#L70-L81) | 소스 확인 |
| <a id="E12"></a>E12 | 동봉 공식 문서는 networkidle을 testing readiness에 쓰지 말고 web assertion을 사용하도록 명시한다. | [navigation waitUntil](https://github.com/microsoft/playwright/blob/ce480a952553175eae75342aad2c5e86cdf2cbba/docs/src/api/params.md#L1-L8) | 문서 주장 |
| <a id="E13"></a>E13 | 작은 실제 HTTP/browser probe에서 비동기 DOM assertion·poll 성공/timeout, browser clock과 server clock 분리, API fulfill의 실제 handler 우회, 새 context의 storage 격리와 server state 공유를 확인했다. | 캐시 `probes/playwright-mechanisms.cjs`, `playwright-run-log.txt`; 설치된1.58.2 API·합성 HTTP 서버 | 실행 확인 |
| <a id="E14"></a>E14 | webServer plugin probe에서 무관한403 서버를 reuse=true가 수용하고 command는 미실행, false는 거부했다. 새 child의 ready→SIGTERM handler→PID 소멸도 확인했다. | 캐시 `probes/playwright-webserver.cjs`, `playwright-run-log.txt`; 설치된1.58.2 내부 plugin. 제품 DB/강제 crash 검사는 아님 | 실행 확인 |
| <a id="E15"></a>E15 | Paperclip도 temp home·전용 포트·single worker·빌드 UI·health·reuse=false로 전용 인스턴스를 구성한다. retries0과 trace on-first-retry 조합은 그대로 옮기지 않는다. | [config](https://github.com/paperclipai/paperclip/blob/ea727dc3c2a14660635f30cdba09f7790ac5603d/tests/e2e/playwright.config.ts#L6-L95) | 소스 확인 |
| <a id="E16"></a>E16 | Paperclip planning fixture는 API setup+UI composer+API 조회 검증이며 agent를 paused/heartbeat off로 둔다. signoff helper는 wake POST 한 번 후 소속을 검증한 GET으로 대기한다. | [planning fixture](https://github.com/paperclipai/paperclip/blob/ea727dc3c2a14660635f30cdba09f7790ac5603d/tests/e2e/plan-task-fixture.spec.ts#L5-L30); [fetchVerifiedRun/invokeHeartbeat](https://github.com/paperclipai/paperclip/blob/ea727dc3c2a14660635f30cdba09f7790ac5603d/tests/e2e/signoff-policy.spec.ts#L110-L164) | 소스 확인 |
| <a id="E17"></a>E17 | AI SDK MockLanguageModelV4는 실제 model interface에 canned function/object/array를 주입하며 호출을 먼저 기록한다. 배열 범위 밖은 별도 throw 없이 undefined가 된다. | [model mock](https://github.com/vercel/ai/blob/95348b32c6ef9aec688db1021ff921dfe94f8f12/packages/ai/src/test/mock-language-model-v4.ts#L9-L75) | 소스 확인 |
| <a id="E18"></a>E18 | AI SDK는 user-approval tool을 blocked 집합으로 실제 실행에서 제외하고, 재개 collection에서 이미 결과가 있거나 같은 toolCallId 결정이 중복이면 건너뛴다. 이 dedupe는 한 collection 범위다. | [approval gate](https://github.com/vercel/ai/blob/95348b32c6ef9aec688db1021ff921dfe94f8f12/packages/ai/src/generate-text/generate-text.ts#L1392-L1429); [execution filter](https://github.com/vercel/ai/blob/95348b32c6ef9aec688db1021ff921dfe94f8f12/packages/ai/src/generate-text/generate-text.ts#L1505-L1519); [collector](https://github.com/vercel/ai/blob/95348b32c6ef9aec688db1021ff921dfe94f8f12/packages/ai/src/generate-text/collect-tool-approvals.ts#L96-L143) | 소스 확인 |
| <a id="E19"></a>E19 | 작은 Alexa-plus 사례는 같은 conversation script에서 사용자 confirmation Promise를 기다리고 실제 HTTP로 도구/승인을 보낸다. 원본 통합 테스트는 confirm/decline과 실제 상태를 검사한다. 기본 callback은 자동 confirm이다. | [runConversation](https://github.com/guptachetan1995/alexa-plus/blob/42fd28e61cf7839ecbfed6a9775dc1e4a0b0c34b/client/src/planner.js#L27-L81); [원본 테스트 읽기](https://github.com/guptachetan1995/alexa-plus/blob/42fd28e61cf7839ecbfed6a9775dc1e4a0b0c34b/client/test/conversation.integration.test.js#L116-L156) | 소스 확인 |
| <a id="E20"></a>E20 | assistant-ui scripted adapter는 tool-call/result를 로컬 parts 배열에 직접 만든다. reasoning도 시나리오 문자열이며 서버 실행·모델 내부 추론의 증거가 아니다. | [runAgentScript](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/examples/with-react-ink/src/scripted-adapter.ts#L78-L160) | 소스 확인 |
| <a id="E21"></a>E21 | AI SDK 원 mock의 응답 순서/소진/미구현/실패 기록과 assistant-ui 원 adapter의 canned tool5개·무관 입력 tool0·fetch0 등 5검사 영역을 실행했다. 승인 SDK 전체와 Alexa 서버는 실행하지 않았다. | 캐시 `probes/demo-mocks.mjs`, `demo-run-log.txt`; Node type-strip, 같은 snapshot helper import만 data URL로 치환 | 실행 확인 |
| <a id="E22"></a>E22 | Temporal JSDoc는 result await가 시간 전진을 열고 시계는 workflow별이 아니라 환경 전체 공유라 직렬 또는 환경 분리를 권한다. Java test server는 일반 서버와 동작이 다를 수 있다고 명시한다. | [createTimeSkipping JSDoc](https://github.com/temporalio/sdk-typescript/blob/7d27a7ff5937c62954f61fce962370e1440b3bbf/packages/testing/src/testing-workflow-environment.ts#L138-L165) | 문서 주장 |
| <a id="E23"></a>E23 | Temporal 원본 테스트는 실제 Worker에 Activity만 대체하고, start→수동 시간 이동→signal→result를 검사한다. result의 시간 lock은 finally에서 복구한다. 테스트는 읽기만 했다. | [worker/time/signal 테스트](https://github.com/temporalio/sdk-typescript/blob/7d27a7ff5937c62954f61fce962370e1440b3bbf/packages/test/src/test-testenvironment.ts#L85-L132); [result finally](https://github.com/temporalio/sdk-typescript/blob/7d27a7ff5937c62954f61fce962370e1440b3bbf/packages/testing/src/client.ts#L54-L64) | 소스 확인 |
| <a id="E24"></a>E24 | XState 경로 테스트의 state.can 필터는 disabled 이벤트를 경로에서 제거한다. 별도 final 테스트는 child final이어도 root가 active임을 검사한다. 원본 테스트 미실행. | [guarded paths](https://github.com/statelyai/xstate/blob/060cd63378b46b32e7559d569ed3ad112ee60084/packages/core/src/graph/test/paths.test.ts#L121-L159); [child final](https://github.com/statelyai/xstate/blob/060cd63378b46b32e7559d569ed3ad112ee60084/packages/core/test/final.test.ts#L760-L784) | 소스 확인 |
| <a id="E25"></a>E25 | XState SimulatedClock은 주입된 시간으로 due timer를 발화 전 삭제하고 clearTimeout·역행 set 거부를 구현한다. | [clock](https://github.com/statelyai/xstate/blob/060cd63378b46b32e7559d569ed3ad112ee60084/packages/core/src/SimulatedClock.ts#L38-L85) | 소스 확인 |
| <a id="E26"></a>E26 | 원본 SimulatedClock만 transpile한 probe에서 deadline1ms전/도달/중복 없음/취소/역행 거부가 통과했다. 만료 뒤 미발화라는 잘못된 기대는 의도대로 exit1이었다. | 캐시 `probes/workflow-clock.mjs`, `workflow-run-log.txt`; TS6.0.3. actor/graph suite·workflow 서버 아님 | 실행 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | fake는 판단·외부 응답만 정하고 실제 효과 경계를 유지 | E01–E03,E17–E20,E23 | Babo runtime token HTTP, AI SDK provider seam, Alexa shared conversation, assistant-ui 로컬 parts | 같은 데모로 실제 승인·도구 경로 검증 | UI 성공 문자열/seed/API fake로 서버 검증을 건너뜀 |
| <a id="P02"></a>P02 | 사용자 결정 전후 업무 상태를 따로 확인 | E06,E18,E19,E24 | SDK tool gate·인접 confirmation을 Babo 사용자/조직 권한과 동일시하지 않음 | pending/실제 생성/최종 완료 구별 | 순간 부재나 run 성공으로 장기 불변 조건·연구 완료 오판 |
| <a id="P03"></a>P03 | 변경은 한 번, 관찰은 조건까지 반복 | E08,E12,E16 | locator expect 우선, 필요한 실제 GET만 poll | 느린 환경에서도 의미 있는 대기·실패 위치 | poll 안 POST/click 중복, networkidle·sleep가 업무 완료를 뜻하지 않음 |
| <a id="P04"></a>P04 | 브라우저·서버·DB 수명과 격리를 별도로 소유 | E05,E09–E11,E14–E16,E22 | per-test context와 suite DB는 다름, shared clock도 환경 자원 | 개발 DB 오염·stale server·cleanup 누락 예방 | workers1만으로 다른 invocation/fixture state까지 격리됐다고 오판 |
| <a id="P05"></a>P05 | 시간 의존 검증은 서버 주입 clock과 통제된 경계에서 | E06,E10,E13,E22,E23,E25,E26 | page.clock은 browser, Temporal은 환경 전체, Babo now/tick은 서버 | heartbeat를 실제 분 대기 없이 검증 | 새 E2E clock endpoint·독자 가상시간 engine·timer race 확대 |
| <a id="P06"></a>P06 | 여정 하나와 경계별 API/기능 검증을 함께 유지 | E04,E06,E07,E18,E24 | 현재 기능 spec은 API setup 허용, #63은 주요 사용자 전이를 UI로 수행 | 통합 누락을 찾으면서 부정/경합 검증은 결정적으로 유지 | 여정에 모든 실패 조합을 넣어 느려지거나 기존 테스트 삭제로 경계 소실 |

## 결정 권고

확정 계약은 Issue·제품 불변 조건이 우선한다. 새 제품 정책에 대한 사용자 선택이 필요한 항목은 발견하지 않았다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 이미 기본인 scripted runtime/selector·실제 token HTTP·도구별 쓰기 키를 재사용한다. 새 demo 전용 상태 저장소/DB seed/agent loop를 만들지 않는다. 현재 worker의 첫 노드 종류(problem) 생성·작업 연결이면 #63의 노드 확인 범위를 충족한다 | P01; E01–E03/E06; #63 | 기존 계획·승인·작업·결과 계약을 중복 구현할 필요 없음. 개별 가설/실험까지 자동 연구하는 의미로 확대하지 않음 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 한 test에서 조직 생성·Lead 메시지·초기 승인·제어·정책 저장·작업자 추가 부탁과 승인·결과 제출 부탁·최종 완료를 UI로 수행한다. 작업/산출물/노드와 결과 검토는 실제 저장·화면을 확인한다. 조회 API는 보조 관찰만 사용 | P01/P02/P06; E04/E06/E07/E16 | 기존 result-review를 그대로 전체 흐름이라고 부르면 생성/승인 UI의 통합 공백이 남음. route.fulfill·결정 API setup으로 AC 단계를 건너뛰지 않음 | Q1/Q2/Q4 |
| <a id="D03"></a>D03 | 채택 | test.step과 조직·영역에 한정한 role/label locator assertion으로 상태를 기다린다. 필요한 GET poll은 HTTP 성공/응답 shape·조건·timeout을 명시한다. Event 준비가 중요하면 기존 ready barrier를 listener 등록 후 사용하고 cleanup/deadline을 갖춘다 | P03; E08/E12–E14/E16 | timeout 증대나 새로고침 반복으로 갱신 실패를 숨기지 않음. click/POST를 재시도 callback 안에 넣지 않음. 부정 assertion 전 pending/paused/처리 완료라는 긍정 기준을 확보 | Q2/Q4 |
| <a id="D04"></a>D04 | 채택 | 현재 전용 health·포트·ephemeral DB·DATABASE_URL 빈 override·reuse=false·SIGTERM·workers1·retain-on-failure를 유지한다. 새 spec은 자기 조직 ID/고유 이름과 범위 assertion을 사용하고 suite의 전역 빈 DB/조직 총수에 의존하지 않는다 | P04; E05/E09–E11/E14/E15 | 기존 create spec의 최초 빈 DB 전제와 충돌하지 않게 파일 순서/fixture 영향을 검토. per-test backend 격리·포트 할당으로 suite 전체를 재설계하는 것은 필요 시 별도 범위 | Q3 |
| <a id="D05"></a>D05 | 변형 채택 | 초기 승인 뒤 작업자 결과를 확인하고 연구 진행에서 정책을 켠다. 조직 pause→대화로 작업자 추가 부탁을 남김→미전달 표시/팀 불변→resume→추가 승인 pending/팀 불변→사용자 승인→팀 +1 순서를 권고한다. 결과 제출 전에 끝낸다 | P02/P06; E06/E18/E19/E24; #59 완료 결정 | 빠른 fake를 실행 중에 잡으려는 시간 race 없이 두 AC를 한 흐름에서 확인. running cancel/빠른 resume 경합은 #59 API에 남긴다 | Q2/Q4 |
| <a id="D06"></a>D06 | 변형 채택 | heartbeat는 기존 에이전트 상세 설정을 사용할 수 있게 유지한다. 여정에 넣으면 저장→nextAt 표시→끄기까지만 확인하고, 실제 due/합침/취소·완료 후 admission은 기존 서버 clock/tick/drain API 검증에 맡긴다 | P05/P06; E06/E10/E13/E22–E26; #60 | browser clock으로 서버를 전진시키거나 실제 1분을 기다리지 않음. heartbeat on을 남겨 여정에 배경 실행을 섞지 않음. 공개 test clock/drain endpoint 추가 불필요 | Q3/Q4 |
| <a id="D07"></a>D07 | 채택 | 승인 전 worker/task 없음, 정책 pending 때 팀 불변, result_review는 미완료, Owner 결정 뒤 completed를 대표 여정에 넣는다. 직접 도구 거부·교차조직·종료 token·중복 결정·동시성·복구·#64 편집은 기존 API/기능 spec에 남긴다 | P02/P06; E06/E18/E24; #49 Testing Decisions·#63의 #64 제외 | 단기 화면 부재를 장기 보장으로 확대하지 않음. Run completed나 산출물 존재를 완료 기준 충족으로 해석하지 않음. 기존 상세 E2E를 단일 여정 추가와 함께 삭제하지 않음 | Q1/Q4 |
| <a id="D08"></a>D08 | 변형 채택 | 구현 시 README에 기본 fake·실제 모델 미사용, 시작 명령, 아래 손 조작 순서/정확한 대화 입력, 전체 흐름 spec 실행 명령과 판 1 상태를 연결한다. pnpm check 및 변경 계약의 검사 결과를 실행/미실행으로 구분한다 | E01–E07; #63 AC3/4; README 검증 기준 | 조사 probe 통과만으로 판 1 완료를 선언하지 않음. 이미 있는 dev/test script를 우선 사용하고 실제 통합 검증 뒤 상태를 갱신 | Q1/Q3/Q4 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 완성 상태 seed·page.route/MSW 성공 응답으로 주요 흐름 통과 | E13/E16/E20 | initial approval·조직 도구·DB·Event 경로를 시험하지 않음. 실패 UI용 mock과 #63 전체 흐름 검증은 구별 |
| callback 기본 자동 승인·테스트가 승인 API를 대신 수행 | E19 | 초기 승인·선택 정책·최종 완료의 실제 사용자 행동을 생략. Alexa 메모리 저장/단일 owner key/조직 없는 모델도 채택하지 않음 |
| raw provider 응답 배열 index·timer로 여정 상태를 중복 관리 | E17/E21 | 배열 소진·추가 wake·heartbeat에 취약. 현재처럼 role/stage/wake 기반 selector 재사용 |
| 고정 sleep·networkidle·poll 안 변경 연산 | E08/E12/E16 | 업무 준비 신호와 다르거나 중복 부작용 위험 |
| context 초기화=DB 초기화, reuse=true=올바른 서버 | E09/E10/E13/E14 | 서로 다른 격리 경계. 외부 DATABASE_URL이 임시 flag보다 우선하는 것도 주의 |
| run/child 성공=연구 최종 완료, fake reasoning=관찰된 내부 추론 | E20/E24 | 제품 용어·관찰 불변 조건과 상충 |
| 새 workflow/model graph/mock server/testcontainer 제품 도입 | E22–E26, ADR1/4 | 이번 검증 공백은 기존 stack/seam으로 다룸. 모델 기반 허용 경로만 생성하면 금지 입력이 빠질 수 있음 |

## 구현 참고

권고 요약: 기존 default fake로 실제 Control Plane을 통과하는 **한 개의 전체 UI 여정**을 추가하고, 결정적 부정/시간/복구 검증은 기존 API seam에 둔다. 이번 작업에서 제품 코드·테스트·설정·README를 편집하거나 구현을 시작하지 않았다.

| 위치 | 구현 시 확인할 책임 |
|---|---|
| `packages/runtime/src/scripted.ts` | 현재 role/stage/wake 분기·실제 token tool call·가짜 결과 안내 재사용. 필요한 수정이 발견될 때만 이 경계에서 수정 |
| `apps/web/e2e/` | UI 전체 흐름 test 하나와 기존 의미 있는 assertion/helper 최소 재사용. 새 spec은 기존 create spec 빈 상태 전제를 앞질러 오염시키지 않음 |
| `apps/web/playwright.config.ts`·`apps/server/src/main.ts` | 실제 default runtime·전용 임시 DB와 종료 경로 확인. 고정 포트 충돌은 실패로 드러냄 |
| `apps/server/test/`·runtime testing helper | clock/tick/drain/gate의 in-process seam 사용. 장기 부정 조건·cancel/복구·교차조직 matrix를 여정 UI로 옮기지 않음 |
| `README.md` | 시작→브라우저 주소→대화 입력→승인→확인→최종 완료와 실제 실행한 검사·판 1 상태 연결 |

손 조작 권고: `pnpm dev` → 새 조직 → Lead 대화에 `목표: 공개 자료로 오류 유형을 정리한다`와 `완료 기준: 유형 목록과 근거 메모`를 **두 줄**로 보내기 → Inbox에서 초기 연구 계획/팀/연구 환경 승인 → 작업·자기 보고/산출물/연결 연구 노드 확인 → 조직 설정의 작업자 추가 정책 켜기 → 조직 pause → Lead 대화에 `작업자 추가: researcher` → resume → Inbox 추가 승인 → Lead 대화에 `결과 제출 부탁해요` → Inbox 결과 검토에서 요약·완료 기준·근거를 읽고 최종 완료 확정. UI의 정확한 이름/경로는 현행 화면을 기준으로 한다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | UI 조직 생성 → 전용 Lead/목표 설정 → 정확한 조직 대화에 목표 두 줄 → 기록·초기 승인 pending | D01/D02 |
| V02 | 초기 승인 pending → 계획/팀/환경 표시·worker/task0 → 사용자 승인 → researching·초기 팀2·작업 생성 | D02/D07 |
| V03 | 작업자 완료 → 자기 보고와 산출물 내용·출처, 연구 노드와 작업 연결 확인 → 산출물을 연구 완료로 오판하지 않음 | D01/D02/D07 |
| V04 | 작업자 추가 정책 off 기본값 → UI로 on·저장된 상태 → 후속 호출이 승인 요청으로 전환 | D05/D07 |
| V05 | researching에서 pause → 대화 입력은 다음 실행 대기·팀 불변 → resume → 대기 요청 처리 | D03/D05 |
| V06 | 추가 승인 pending → 팀2 유지 → 사용자 승인 → 팀3·같은 조직에 새 사본, 초기 연구 단계 재승인 없음 | D05/D07 |
| V07 | 결과 제출 부탁 → result_review/Inbox 항목 → 요약·완료 기준·근거 → 사용자 확정 후 completed | D02/D07 |
| V08 | 서버 clock으로 heartbeat due/끄기·완료 뒤 입력/종료 token·교차조직 → 기존 API의 결정적 검사 → UI 순간 부재로 대체하지 않음 | D06/D07 |
| V09 | 같은 spec 단독/전체 suite·기존 조직 잔존 → 자기 조직 범위 검증·create spec 빈 DB 전제 보존 | D04 |
| V10 | 포트에 다른 서버/실패/timeout → reuse 거부·trace/단계별 실패·소유 process/임시 DB 정리, 지속 개발 DB 불변 | D03/D04 |
| V11 | Event 뒤 상태 변화 → 같은 화면/올바른 조직에서 갱신 → reload/API fake로만 통과하지 않음 | D02/D03; #77 |
| V12 | README 안내를 새 환경에서 따름 → 실제 dev 기본 fake 흐름·문서 링크/검사 명령 일치 → 실행/미실행 구분 보고 | D08 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| heartbeat 설정 조작을 대표 여정에도 넣을지 | #63 | 권고는 설정 on→nextAt→off를 짧게 추가하거나 기존 heartbeat E2E 근거를 연결하는 안. 실제 due/합침은 어느 안이든 #60 서버 clock 검증에 둠(D06) |
| suite의 전역 빈 DB 선행 spec과 새 파일 구성 | #63 | 권고는 최초 create spec 이후 순서의 자체 조직 여정으로 최소 변경. suite 전체의 per-test DB/동적 포트 변경은 비용이 더 커 필요가 생기면 별도 작업(D04) |

새 제품 승인 정책·기억 엔진·연구 방법을 정할 열린 결정은 없다. 후속 경계는 기존 #59/60/61/62/64/77의 완료된 계약을 재사용하는 의미이며 이 이슈를 다시 여는 권고가 아니다. 실제 adapter·메시지 앱·외부 job/예산·기억 심화는 #49의 후속 판으로 남긴다.

## 한계와 미확인

- 실행한 것은 현행 기본 fake의 API 조사5시나리오/73assertions, **기존** 브라우저 E2E4건, 외부 원본 mock/clock 및 Playwright 소형 probe다. 신규 #63 전체 UI 여정·전체 suite·`pnpm dev` watch 조작·실제 CI·외부 Postgres/타 OS·브라우저 전체·강제 crash/cleanup 복구는 실행하지 않았다.
- 제품 API probe의 runtime wrapper는 호출 수·신원/토큰을 관찰한다. DB 직접 쓰기는 없지만 순수 외부 seam 제품 테스트와 같다고 주장하지 않는다. E2E는 API로 준비한 단계까지 UI 통과로 세지 않는다. 기존 spec의1초 확인은 영구 admission 증명이 아니다.
- AI SDK/Temporal/XState 전체 테스트·Alexa HTTP 서버·Paperclip 전체 제품은 미실행. 소스 테스트를 읽은 사실과 통과를 구분한다. type-strip/transpile probe는 부분 모듈 검증이며 reproducible build·upstream 전체와의 동등성은 미확인이다.
- 시계 probe는 각각 browser/작은 HTTP 서버·pure clock 경계다. 서버 heartbeat 자체는 E06에서 별도로 주입 clock으로 확인했다. POSIX 정상 SIGTERM은 봤지만 SIGKILL/네트워크 단절/응답 유실/디스크 장애를 보장하지 않는다.
- 공개 후보 중 s-m-r-t URL은 열기 실패, 일부 인접 integration/시제품은 검색 snippet만 확보해 실행 경로와 운영 주장을 미확인으로 표시했다. 계정·로그인·키가 필요한 UI는 접근하지 않았다. 타사 캡처·시각 배치 권고는 없고 사용자 데이터/자격 증명/실제 모델·유료 API를 사용하지 않았다.
- 원문·LICENSE는 고정 SHA와 확인일 기준이다. 설계 참고만이며 코드 재사용은 별도 고지·의존성 검토가 필요하다. upstream 변경 시 결정에 쓰는 파일을 다시 확인한다. 과거 조사와 blob 동일성 검증 없이 예전 E를 이번 새 소스 사실로 이식하지 않았다.
- 조사 문서는 미커밋으로 두고 구현 변경과 함께 검토·커밋한다. receipt는 요약과 문서 **경로**를 남기며 아직 원격에 이 문서가 있다는 뜻은 아니다.

