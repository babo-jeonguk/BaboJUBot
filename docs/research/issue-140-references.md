# issue-140 레퍼런스 조사: 공통 Usage 숫자 규칙 정렬과 이상값 격리

조사일: 2026-11-10. 대상: [#140](https://github.com/babo-jeonguk/BaboJUBot/issues/140). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-140/`(git 무시). 제품 정책은 이슈에서 이미 확정됐으며 재결정하지 않는다.

## Brief

- 구현할 문제: adapter마다 숫자 허용 범위가 다르고 부분 합계가 전체처럼 보이거나, 사용량 이상 때문에 정상 실행 시도 결과와 다음 세션이 사라진다.
- 동종 문제: 부분 관측된 보조 계측의 검증·계산 오염 전파와 주 결과의 실패 격리.
- 고정된 결정: contracts가 공통 숫자 규칙을 단독 소유한다. 토큰은 비음수 안전 정수, USD는 비음수 유한수이며 외부 미보고 표현은 null이다. 명시적 이상값은 해당 항목 null과 진단, 이후 정상 보고로 회복 금지. runtime은 필드 매핑·턴합·누적차감·캐시분리·중복제외를 소유한다. 미보고 baseline/cache fallback은 유지한다. 초기 연구 승인·사용자의 최종 완료·조직 경계는 제품 코드가 강제한다. parent 없음(REST 404), blocker 없음(빈 목록).

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 미보고·0·명시적 이상값을 구분하면서 숫자 규칙을 한 곳에서 소유하는 방법은? | #140 소유 경계·숫자 계약 | API·계약 + Source Recon |
| Q2 | 턴합·누적/캐시차감·중복제외·취소에서 overflow와 의존성 오염을 보존하는 방법은? | #140 동작 변경 표·사용자 이야기 4–11 | Source Recon + runtime/failure + persistence/recovery |
| Q3 | usage 이상만 격리하고 정상 결과·다음 세션·독립 사용량·조직 귀속을 보존할 경계와 검증은? | #140 완료 조건·Testing Decisions | Source Recon + adversarial scenario |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#96](issue-96-references.md#근거) E08–E09 | 미보고·0·부분합 구분의 출발점 | 과거 실행을 이번 실행으로 세지 않는다. AI SDK는 새 SHA 원문과 probe로 별도 확인 |
| [#98–101](issue-98-101-references.md#결정-권고) D06 | baseline 차감·중복 snapshot 제외·캐시 분리의 맥락 | 과거 source 사실을 전재하지 않고 현행 adapter를 새로 읽음 |
| [#125](issue-125-references.md#결정) D01·E04 | Claude 턴합과 세션 누적 비용의 차이 | 현행 claude.ts 및 공식 cost tracking 문서 재확인 |
| [캐시 조사](provider-prompt-caching.md), [능력 조사](executor-capabilities.md) | provider별 cache 필드의 의미와 범위 | TTL·비용 절약 실측은 재사용하지 않음. 이번 숫자 규칙과 별도 |

기존 docs/research와 캐시를 사용량 키워드로 선별했다. 나머지 일치 문서는 UI·조직 도구·승인·세션 제어의 맥락으로만 보고 숫자 정책 근거에서는 제외했다.

## 레퍼런스

전체 후보·라운드·실행 경로는 `.reference-cache/issue-140/candidates.md`에 있다. 프로바이더 OSS, 집계 라이브러리, 숫자/계측 표준의 세 관점으로 탐색했다. 마지막 라운드에서 각각 정규화/누적 의미, 부분합/미측정 추적, 숫자 범위/계측 격리/기본 0의 반례가 반복됐다. 이 탐색 범위의 포화이며 모든 프로젝트를 망라했다는 뜻은 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| OpenCode | provider OSS | `57719d7fd400721783a059fee78c7d33a21cd9b6` | MIT | 소스·순수함수 실행 | 0 보정/비용0 우선의 반례, provider 내부 호출 경로 |
| Vercel AI SDK | 집계 SDK | `f9d43bdaa78a0564105942c7a6709469a120c3ee` | Apache-2.0 | 소스·순수함수 실행 | 필드별 부재 표현과 부분합, 다중 step 경로 |
| Pydantic AI | 집계 SDK | `cc37d25c2bcba1ecaa8ec80614fac99142db7930` | MIT | 부분 소스 | 미측정 요청 별도 표시·추출 오류 warning |
| ECMA / Zod / OTel | 언어·숫자 검증·계측 명세 | 열람일 2026-11-10 / 로컬 Zod 4.6.7 | 공식 문서; 코드 복사 없음 | 문서 / 로컬 schema 실행 | 숫자 범위·계측 오류 격리 |
| Claude Agent SDK | provider 공식 문서 | 열람일 2026-11-10 | 공식 문서; 코드 복사 없음 | 문서 | 턴 사용량과 세션 누적의 차이 |

깊이는 전체 제품 실행 여부를 뜻하지 않는다. 고정 SHA raw 파일과 root LICENSE를 확인했으며 전체 checkout/앱 실행은 하지 않았다. AI SDK의 과거 조사와 이번 `usage.ts` blob은 모두 `8db69ea59c8f1ef6d6b05be58610be2c2d3c955d`로 변경 없다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | safe integer와 finite는 다르다. 토큰 범위의 상한은 2^53−1이며 소수 USD는 별도 검증해야 한다 | [ECMA Number.isSafeInteger](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.issafeinteger), [Zod integers/numbers](https://zod.dev/api#integers) | 문서 주장 |
| <a id="E02"></a>E02 | 현재 contracts의 `.int().nonnegative()`는 이미 안전 정수 범위를 검사한다. raw input·계산 결과를 정규화하는 공통 경계가 별도로 필요하다 | [tokenCountSchema·usageSchema](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/contracts/src/run.ts#L261-L276) | 소스 확인 |
| <a id="E03"></a>E03 | Claude는 finite 비음수를 턴별 더하며 이상값을 건너뛴다. 비용/저장값 차감은 음수를 0 보정한다 | [executeClaude·runUsage](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/claude.ts#L68-L83), [result 처리](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/claude.ts#L369-L403) | 소스 확인 |
| <a id="E04"></a>E04 | transcript는 각 model 항목을 safe integer로 검사하지만 더한 결과를 재검사하지 않는다. 취소/결과 없는 종료는 savedUsage 경로를 쓴다 | [claudeSessionCost](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/claude-transcript.ts#L124-L149), [savedUsage](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/claude.ts#L468-L502) | 소스 확인 |
| <a id="E05"></a>E05 | Codex는 raw safe integer를 검사하지만 누적 차감/cache 차감에 0 보정·미보고 fallback을 쓴다. 새 snapshot으로 usage를 교체한다 | [tokenUsage handler](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/codex.ts#L296-L324) | 소스 확인 |
| <a id="E06"></a>E06 | OpenCode adapter는 session before/after 차감, Antigravity는 완료 step_index 중복 제외 후 캐시를 빼서 합산한다. 전자는 finite 검사, 후자는 integer 검사라 safe 범위와 차이가 있다 | [sessionUsage](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/opencode.ts#L547-L565), [step_update](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/runtime/src/providers/antigravity.ts#L312-L335) | 소스 확인 |
| <a id="E07"></a>E07 | 서버는 종료 결과 전체 safeParse 실패 시 일반 failed 결과로 교체한다. usage를 고치는 과정에서 다른 종료 계약 위반까지 허용하면 안 된다 | [Dispatcher execute](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/dispatcher.ts#L283-L298) | 소스 확인 |
| <a id="E08"></a>E08 | contracts 허용/거부, 소수 USD 보존, 잘못된 usage를 가진 completed 계약 거부, transcript 합산 overflow 통과 및 음수 항목 격리/독립 output 보존을 직접 확인 | `probes/local-boundaries.mjs`, `probes/local-run-log.json`; Node v24.21.0, 키 없는 셸, 14 assertions 통과 | 실행 확인 |
| <a id="E09"></a>E09 | AI SDK 새 관찰: asLanguageModelUsage는 숫자를 그대로 매핑하고 generateText는 step 사용량을 reduce한다. 부분합 규칙은 [기존 #96 E08](issue-96-references.md#E08)을 재사용하며 이번 실행으로 재확인했다 | [addLanguageModelUsage·addTokenCounts](https://github.com/vercel/ai/blob/f9d43bdaa78a0564105942c7a6709469a120c3ee/packages/ai/src/types/usage.ts#L81-L101), [generateText](https://github.com/vercel/ai/blob/f9d43bdaa78a0564105942c7a6709469a120c3ee/packages/ai/src/generate-text/generate-text.ts#L1722-L1745) | 소스 확인 |
| <a id="E10"></a>E10 | OpenCode 자체 usage 정규화는 missing/비유한/음수를 0으로 만들고 이후 단순 가산한다. 명시 비용 0은 catalog 추정보다 우선한다 | [SessionUsage tokens·record·add](https://github.com/anomalyco/opencode/blob/57719d7fd400721783a059fee78c7d33a21cd9b6/packages/core/src/session/usage.ts#L8-L64) | 소스 확인 |
| <a id="E11"></a>E11 | 계측 런타임 오류가 본 애플리케이션을 실패시키지 않도록 하고 계측 자체 진단을 권고한다. Usage 숫자 정책 자체를 정하는 명세는 아니다 | [OpenTelemetry Error handling](https://opentelemetry.io/docs/specs/otel/error-handling/) | 문서 주장 |
| <a id="E12"></a>E12 | Claude streaming input에서는 result가 턴마다 나오며 usage는 턴 범위, total_cost_usd/modelUsage는 세션 누계다 | [공식 cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode); 원문 `notes/claude-cost-tracking.md` | 문서 주장 |

| <a id="E13"></a>E13 | OpenCode 원문 정규화 함수에서 타입 주석만 제거해 정상0/1, missing/음수/NaN/Infinity, 소수/unsafe를 실행: 뒤 두 값도 그대로 통과 | `probes/opencode-tokens.mjs`, `probes/opencode-main-run-log.txt`; Node v24.21.0, 8개 입력, 메인 재실행 일치 | 실행 확인 |
| <a id="E14"></a>E14 | AI SDK 원문 함수 직접 import: missing/0/부분합·음수·소수·overflow·NaN·Infinity·독립 output 9개 assertion 일치. #140 통과가 아니라 현행 집계의 반례 | `probes/ai-sdk-usage.mjs`, `probes/ai-sdk-main-run-log.txt`; Node v24.21.0, 메인 재실행 | 실행 확인 |
| <a id="E15"></a>E15 | Pydantic AI는 미측정 요청이 있으면 합계는 lower bound임을 별도 표현하고 사용량 추출 오류는 warning으로 격리한다. 기본 토큰0은 이식하지 않는다 | [unmeasured_requests](https://github.com/pydantic/pydantic-ai/blob/cc37d25c2bcba1ecaa8ec80614fac99142db7930/pydantic_ai_slim/pydantic_ai/usage.py#L160-L165), [추출 오류](https://github.com/pydantic/pydantic-ai/blob/cc37d25c2bcba1ecaa8ec80614fac99142db7930/pydantic_ai_slim/pydantic_ai/usage.py#L385-L416) | 소스 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 내부 관측 상태와 외부 숫자 표현 분리 | E01–E02·E09·E15 | AI SDK undefined를 프로젝트 null로 바꾸되 missing/invalid를 합치지 않음 | 0을 유지하며 규칙 단독 소유 | null 하나로 누적하면 이상값 뒤 정상값에서 합계가 되살아남 |
| <a id="P02"></a>P02 | 필드별 오염을 단조롭게 유지하고 의존 연산으로 전달 | E03–E06·E08–E10·E13–E14 + #140 | upstream 부분합/0 보정을 변형해야 함 | 독립 항목 보존·잘못된 전체합 방지 | 내부 상태 필요, 합/차감 후 재검사 누락 위험 |
| <a id="P03"></a>P03 | provider별 관측 단위는 adapter에 둠 | E03–E06·E12 | 턴합·세션차감·step 중복제외가 서로 다름 | 정상 집계 회귀 방지 | 숫자 helper가 원시 필드/세션 의미까지 알면 책임 중복 |
| <a id="P04"></a>P04 | 보조 계측 실패를 주 결과와 격리 | E07–E08·E11·E15 | 서버의 엄격한 종료 검사는 유지하면서 usage 숫자만 사전 격리 | 성공/세션/정상 사용량 보존 | 광범위 catch나 전체 schema fallback은 다른 오류를 숨김 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | contracts에서 숫자 분류/검사와 이상값→null 규칙을 제공하고 schema와 공유. 내부적으로 missing·valid(value)·invalid에 해당하는 구별을 계산 완료까지 보존 | P01·#140 | 외부 Usage 상태를 추가하지 않고 adapter마다 범위를 다시 정의하지 않음. 구체 타입/helper 이름은 구현에서 선택 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 항목별 invalid는 실행 시도 집계가 끝날 때까지 유지. raw 및 합/차감 결과 검증. invalid 피연산자가 필요한 계산만 오염 | P02·#140 | output 100→이상→50은 null. input 100−cache 120은 input null, cache 120 보존. missing fallback을 invalid에 재사용하지 않음 | Q1·Q2 |
| <a id="D03"></a>D03 | 채택 | 턴합·누적 baseline·cache 분리·중복 step/snapshot·취소 transcript 경로를 adapter에 남김 | P03·#140 | 숫자 정책 통일이 provider 집계 의미 통일로 번지지 않음. 취소/결과 없는 종료도 같은 공통 규칙 사용 | Q2 |
| <a id="D04"></a>D04 | 변형 채택 | adapter와 서버의 반환 경계에서 사용량 숫자만 공통 규칙으로 격리한 후 나머지 RunResult 계약은 엄격히 검사. 진단은 항목/원인/계산 단계가 식별되게 함 | P04·#140 | summary·stopReason·nextSession과 독립 사용량 보존. 서버에는 provider 필드 해석을 넣지 않음. 원시 응답·transcript·비밀값을 진단에 덤프하지 않음 | Q3 |
| <a id="D05"></a>D05 | 채택 | 기존 Usage/RunResult·진단 경계에 합성 peer/fixture 주입으로 검증. 새 외부 seam이나 내부 helper 호출 횟수 검사는 도입하지 않음 | E08·#140 Testing Decisions | 순수 helper probe만으로 서버/취소/조직 시나리오 검증을 대체할 수 없음 | Q1·Q2·Q3 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 미보고/이상값을 0으로 정규화 | OpenCode E10 | 무료·미보고·잘못된 보고의 차이가 사라짐 |
| 이상 항목을 건너뛴 부분합을 전체합으로 보고 | Claude E03, AI SDK E09를 invalid에도 확장 | #140 sticky invalid에 위배 |
| 음수 차감 clamp 또는 세션 counter reset 추측 | 현행 E03·E05·E06 | 감소 결과 null이라는 확정 정책과 충돌 |
| usage 전체 catch 또는 전체 결과를 정상화 | E07·P04 | 독립 항목을 버리거나 다른 종료 계약 위반을 숨김 |
| 신규 비용 계산/추정 가격 fallback 도입 | OpenCode E10 | #140 범위 밖, USD 추정치를 실제 청구로 취급할 수 없음 |

## 구현 참고

- 권고 요약: 공통 숫자 규칙, 계산 중 세 상태 구별, 필드별 오염 유지, 의존성 전파, 종료 전 숫자 이상 격리 순서로 좁힌다. 위 권고는 #140 확정 정책을 구현하기 위한 설계 참고다.
- 위치: `packages/contracts/src/run.ts` 및 공통 숫자 정책 모듈(구체 파일명 미정) → `packages/runtime/src/providers/{claude,claude-transcript,codex,opencode,antigravity}.ts` → `apps/server/src/dispatcher.ts` 종료 검사 경계. contracts는 runtime/서버를 import하지 않는다. core/DB/AfterCommit·UI·요금 계산·예약 정책은 범위 밖이다([구조](../architecture.md), [ADR-0001](../adr/0001-adapter-control-plane.md)).

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 0/null/MAX_SAFE/소수/음수/NaN/Infinity/MAX_SAFE+1·소수USD → 공통 규칙 → 허용값 보존, 이상만 null+진단 | D01 |
| V02 | output 100→이상→50·safe 값들의 합 overflow → adapter → 해당 합계 null 유지, input/비용 독립 보존 | D02 |
| V03 | 누적 100→90, input100/cache120, 잘못된 baseline/cache → 차감 → 음수/의존항목 null, 정상 cache120 보존 | D02·D03 |
| V04 | baseline/cache 단순 누락·정상 차감·중복 snapshot/step → adapter → 기존 fallback·중복제외 회귀 없음 | D03 |
| V05 | Claude 취소/결과 프레임 없음·새 cost-state 없음·여러 model의 합 overflow → transcript → 기존 미보고/귀속 유지, 이상 항목만 격리 | D02·D03 |
| V06 | 성공 summary+nextSession+사용량 한 항목 이상 → 서버 → completed·세션·독립 항목 유지, 항목 진단 존재 | D04 |
| V07 | 잘못된 stopReason/세션 구조 → 서버 → 기존 계약 거부 유지 | D04 |
| V08 | 조직 A/B의 합성 실행·취소와 후속 세션 → 기존 RunResult/조직 경계 → 각 조직의 정상 사용량·세션만 유지, 교차 귀속 없음 | D03–D05 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 내부 상태 표현·정책 모듈 배치·진단 형태 | #140 구현 | tagged 상태 또는 값+오염 플래그. 외부 Usage는 유지하고 단일 규칙/필드 식별/비밀값 비노출 조건 충족. 새 사용자 정책 판단은 필요 없음 |
| null 비용의 예산 판단·추정/청구 회계 | 판4 관련 이슈/사용자 | #140 후속 질문 그대로 보류. 이번 조사에서 예산 결정을 만들지 않음 |

## 한계와 미확인

- 실제 모델 호출·로그인·자격 증명·실제 연구 데이터 사용 없음. 공개 자료와 합성 데이터만 사용했다. 제품 코드·테스트·설정은 변경하지 않았다.
- 로컬 순수 probe는 현재 결함과 schema 범위를 확인한 것이다. #140을 구현했거나 V01–V08 전체를 통과했다는 뜻이 아니다. 서버 DB 통합·네 adapter 실제 transport·조직/취소 회귀·전체 제품 검사·전체 upstream suite는 실행하지 않았다.
- sticky invalid는 선행 SDK들이 보장하는 정책으로 확인하지 못했으며 #140에서 확정한 제품 요구다. 공개 provider 문서는 실제 wire 정밀도·청구 금액을 보장하는 실행 근거가 아니다.
- 설계 참고이며 외부 코드 복사나 새 의존성 도입을 권고하지 않는다. 복사한다면 해당 SHA의 LICENSE/header/NOTICE/전이 의존성을 확인하고 AGENTS의 출처 및 THIRD_PARTY_NOTICES 규칙을 따른다.
