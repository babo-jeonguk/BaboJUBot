# issue-147 레퍼런스 조사: OpenCode schema 호환과 안전한 실패 이유

OpenCode 연구 단계의 도구 schema 전달과 실패 이유 보존을 조사한다. 요구·완료 조건은 [#147 최신 Agent Brief](https://github.com/babo-jeonguk/BaboJUBot/issues/147), 현재 동작은 [현재 구현 현황](../current-implementation.md)이 맡는다.

조사일: 2026-11-11. 구현 전 권고이며 확정 계약이나 구현 완료가 아니다. 제품 코드·테스트·설정을 바꾸지 않았으며, 실제 모델 호출·로그인·제품 DB 변경은 하지 않았다.

## Brief

- 구현할 문제: 연구 단계에서 추가되는 `record_artifact.path`의 NUL 제외 정규식 표기가 대상 upstream에 거부되고, adapter가 실패 원인을 일반 오류로 바꾼다.
- 동종 문제: 로컬 검증 언어를 외부 schema 소비자에 전달할 때의 표현 호환성과, 비밀을 포함할 수 있는 외부 오류를 안전한 공개 결과로 바꾸는 경계.
- 고정된 결정: NUL 거부·길이·선택 입력·산출물 등록 규칙을 유지한다. 초기 연구 승인·최종 완료·조직 경계는 제품 코드가 강제한다. DB 삭제·인증 재생성·조직 직렬화·상한 변경·무조건 재시도는 범위 밖이다. 과거 최대 8회 실제 호출 허가는 소진됐으며 재사용하지 않는다.
- 부모·blocker: GitHub parent 조회 404(없음), blocked_by 목록은 비어 있었다. 원문 본문의 DB/인증 복구 후보보다 최신 Agent Brief가 우선한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | NUL 차단 의미를 보존하며 어떤 schema 표기를 어디서 검증하는가? | Agent Brief AC1–3 | 명세·Source Recon + serialization probe |
| Q2 | OpenCode 2.2.6 공개 실패 응답은 요청 거부·인증·unknown·중단을 어떻게 구분하는가? | AC5–6·8 | API 계약·Source Recon + failure path |
| Q3 | 승인 단계·후속 세션·동시 실행·조직 분리를 모델 없이 어떻게 검증하는가? | AC3–4·7–9 | runtime/failure + adversarial scenario |
| Q4 | 비밀·연구 내용 없이 안전한 이유를 기존 API·화면에 전달할 수 있는가? | AC5–7 | Source Recon + adversarial module probe |

| 재사용한 조사 | 쓰는 범위 | 재확인·재사용 판단 |
|---|---|---|
| [OpenCode 2.x 지침](opencode-2-instructions.md) | native prompt 보존·session instructions 경계 | 설계 맥락만 재사용. 2.2.5 오류 payload를 2.2.6으로 간주하지 않음 |
| [#98–101](issue-98-101-references.md) | 실행 시도별 서버·토큰·프로토콜 재생 검증 구분 | 검증 축 재사용. 과거 E ID를 새 실행 근거로 승격하지 않음 |
| [프로바이더 연결](provider-connection-references.md) | 프로세스·세션·취소 책임 | 연결 방식 재선정 없이 맥락 재사용. v1 session.error/idle을 이번 v2 계약으로 재사용하지 않음 |
| [경로 confinement](artifact-path-confinement.md) | 입력 NUL 거부와 실제 파일 접근 경계 구별 | 정책 맥락만 재사용. 정규식 변경으로 filesystem 보안 검증을 대체하지 않음 |
| [#150](https://github.com/babo-jeonguk/BaboJUBot/issues/150) | OpenCode 2.2.6 공식 저장소·MCP 경로 탐색 출발점 | 같은 버전의 관련 원문을 새로 읽음. 호출 키·실행 의도 복구는 #150 소유이며 확대하지 않음 |
| [#148](https://github.com/babo-jeonguk/BaboJUBot/issues/148)·[#149](https://github.com/babo-jeonguk/BaboJUBot/issues/149) | 인증·OS 격리 경계 | 관련 범위만 구분. 이번 오류 수정으로 해당 격리를 해결했다고 하지 않음 |

## 레퍼런스

관점별 탐색 종료 근거: schema 관점은 공식 규격·native exporter 다음 대체 converter·MCP 경계까지 2라운드에서 source 보존과 소비자별 호환으로 수렴했다. 안전 오류 관점은 SDK·보안 지침 다음 problem-details·harness 테스트·도입 이력까지 3라운드에서 unknown 마스킹·안전 문구 작성·비재시도 분류가 반복됐다. 프로토콜 관점은 해당 버전 생산자·schema·테스트 다음 인접 pi-mono·누락 이벤트 이슈까지 2라운드에서 종료 분류·상관관계 패턴으로 수렴했다. 중복을 제외한 후보는 10개이며, OpenCode SDK와 같은 저장소의 이슈는 별도 후보로 세지 않았다. 생태계 전수조사나 다른 schema 문법 전체에 대한 호환 보증은 아니다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| colinhacks/zod | schema 라이브러리 | 4.6.7, `b500a2ee95134f81d74da7911d7378dd2853d042` | MIT | 소스·실행 | 설치된 정확한 버전의 정규식 검증·export 분리 |
| anomalyco/opencode | agent 프로그램·공개 프로토콜 | 2.2.6, `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06` | MIT | 소스 | 실행 대상 버전의 실패 생산·소비 계약 |
| vercel/ai | SDK·harness | `70e45d5878494be4b66e325187f865951025059e` | Apache-2.0 | 소스·module 실행 | raw API 오류와 공개 메시지의 구별·반례 |
| pi-mono | 인접 agent harness | 고정 SHA 미확인 | MIT(후보 조사) | 문서 | stopReason/errorMessage 분리; 공식 README의 local baseUrl 예제 확인, 실제 실행 미확인으로 심층 제외 |
| JSON Schema·MCP Tools | 공식 명세 | 2020-12·2025-11-25 | 문서 참조 | 문서 | 정규식 구현 차이·공개 schema 경계 |
| zod-to-json-schema | 대체 converter | 목록만 | ISC(후보 조사) | 목록 | native exporter가 있어 교체 실익 낮음; 로컬 실행 가능·미실행 |
| OWASP·OpenTelemetry·RFC 9457 | 보안 지침·관측·오류 표준 | 2026-11-11 열람 | 코드 재사용 없음 | 문서 | 오류 메시지 민감성과 공개 진단 경계; 실행 경로 없음 |

위 세 심층 대상은 설계 참고이며 제품 소스 복사나 의존성 추가 권고가 아니다. root LICENSE를 읽었다. 코드 이식 시 header·NOTICE·전이 의존성은 별도 재확인해야 한다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 기존 실제 대조에서 원래 pattern 최소 도구는 400, 같은 42개 도구의 pattern만 동등 표현으로 바꾸면 200이었다. 이번에 재실행한 결과는 아니다. | [#147 실제 upstream 대조](https://github.com/babo-jeonguk/BaboJUBot/issues/147#issuecomment-6774667486) | 문서 주장(기존 실험 기록) |
| <a id="E02"></a>E02 | JSON Schema 안내는 ECMA262 전체 문법의 구현 간 지원 차이와 JSON escape를 경고한다. 특정 upstream 엔진이나 모든 문법의 유효성을 단정할 근거는 아니다. | [공식 regex 안내](https://json-schema.org/understanding-json-schema/reference/regular_expressions) | 문서 주장 |
| <a id="E03"></a>E03 | Zod는 string 길이를 내보내고 단일 regex의 source를 pattern으로 옮긴다. runtime regex는 lastIndex 초기화 후 test한다. | [stringProcessor](https://github.com/colinhacks/zod/blob/b500a2ee95134f81d74da7911d7378dd2853d042/packages/zod/src/v4/core/json-schema-processors.ts#L146-L175), [$ZodCheckRegex](https://github.com/colinhacks/zod/blob/b500a2ee95134f81d74da7911d7378dd2853d042/packages/zod/src/v4/core/checks.ts#L777-L795) | 소스 확인 |
| <a id="E04"></a>E04 | upstream exporter 테스트는 /asdf/의 pattern 문자열을 snapshot으로 확인한다. 이번에 그 테스트 suite를 실행한 것은 아니다. | [to-json-schema test](https://github.com/colinhacks/zod/blob/b500a2ee95134f81d74da7911d7378dd2853d042/packages/zod/src/v4/classic/tests/to-json-schema.test.ts#L485-L491) | 소스 확인 |
| <a id="E05"></a>E05 | Node24.21.0·설치된 Zod4.6.7의 키 없는 probe 40 assertions 통과. 두 표현 모두 실제 NUL 거부, 일반·절대·한글·숫자0 경로 허용, undefined·4096 상한 유지. JSON roundtrip 뒤 두 표기는 서로 다르게 보존된다. MCP·OpenCode 실행은 아니다. | 이번 로컬 라이브러리 probe, 메인 재실행 exit0 | 실행 확인 |
| <a id="E06"></a>E06 | 실제 failed event는 data.error를 갖는다. Error는 type/message 및 선택 status/response.body/retryAfterMs. interrupted는 별도 이벤트와 reason을 갖는다. | [Execution schema](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/session-event.ts#L244-L263), [SessionError](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/schema/src/session-error.ts#L7-L14) | 소스 확인 |
| <a id="E07"></a>E07 | InvalidRequest→provider.invalid-request, Authentication→provider.auth, unknown을 구분한다. 메시지·raw body도 보존하므로 그대로 공개할 수 없다. | [toSessionError](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/to-session-error.ts#L34-L97), [providerError](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/to-session-error.ts#L134-L143) | 소스 확인 |
| <a id="E08"></a>E08 | 실제 terminal 생산자는 같은 sessionID의 실패에 outcome.error를 publish하고 deliberate interruption을 별도로 처리한다. | [execution settled](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/src/session/execution.ts#L116-L143) | 소스 확인 |
| <a id="E09"></a>E09 | upstream 테스트는 invalid-request의 type/status/raw body 보존을 assert한다. 이름에 diagnostics 비노출이 있어도 body 자체는 남는다. 읽기만 했으며 upstream suite 미실행. | [session-error test](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/test/session-error.test.ts#L212-L258) | 소스 확인 |
| <a id="E10"></a>E10 | AI SDK APICallError는 요청·응답·헤더를 보유하며 400/401/403은 기본 retryable이 아니다. | [APICallError](https://github.com/vercel/ai/blob/70e45d5878494be4b66e325187f865951025059e/packages/provider/src/errors/api-call-error.ts#L7-L58) | 소스 확인 |
| <a id="E11"></a>E11 | harness helper는 검토된 오류 타입의 message를 통과시키고 그 외 일반 문구로 가린다. 타입 허용은 원문 정제와 다르다. | [getHarnessErrorMessage](https://github.com/vercel/ai/blob/70e45d5878494be4b66e325187f865951025059e/packages/harness/src/agent/get-harness-error-message.ts#L5-L23) | 소스 확인 |
| <a id="E12"></a>E12 | 고정 AI SDK의 독립 module들을 import 경로만 조정해 실행, 11 assertions 통과. provider/unknown 오류 마스킹과 함께, known HarnessError에 합성 비밀을 넣으면 그대로 반환되는 반례 확인. raw API 오류 직렬화에도 합성 비밀이 남는다. | Node24.21.0 키 없는 module probe, 메인 재실행 exit0; 전체 SDK 실행 아님 | 실행 확인 |
| <a id="E13"></a>E13 | 현재 MCP는 단계별 도구에 z.toJSONSchema 적용. adapter는 failed 상세를 버리지만 RunResult.error→run update·run.finished→화면 경로는 이미 있다. login_required는 readiness 재확인을 유발한다. | [MCP](../../apps/server/src/mcp.ts), [adapter](../../packages/runtime/src/providers/opencode.ts), [결과 계약](../../packages/contracts/src/run.ts), [종료 계획](../../packages/core/src/run.ts), [dispatcher](../../apps/server/src/dispatcher.ts), [실패 상세](../../apps/web/src/inbox-detail.tsx) — 조사 HEAD `14ad325fbe12230730fddecbe9fc73cd4790b217` | 소스 확인 |

| <a id="E14"></a>E14 | 실제 설치 CLI2.2.6을 임시 HOME·키 없는 env·localhost mock·모델 목록 fetch/갱신 차단·2GiB 상한으로 실행. 정상 응답 exit0, 합성400은 provider.invalid-request/status400 exit1, 합성401은 provider.auth/status401 exit1. 둘 다 합성 비밀이 message/body에 남았다. 메인이 원본 JSON·설정·실행 script를 직접 열어 확인. | 이번 실제 CLI+가짜 모델 3개 대조. SSE 직접 녹화·실제 gateway·제품 adapter 검증은 아님. mock 요청 6개는 제목생성3+본실행3이며 실패 본실행은 각1회 | 실행 확인 |
| <a id="E15"></a>E15 | OpenCode upstream 테스트는 x-should-retry:true가 InvalidRequest 재시도를 허용할 수 있음을 assert한다. BaboJUBot의 추가 재전송 금지와 upstream 내부 retry는 별개다. | [retry override test](https://github.com/anomalyco/opencode/blob/dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06/packages/core/test/session-error.test.ts#L399-L421) | 소스 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 입력 검증 의미와 소비자 표현 호환을 따로 검증 | E01–E05 | Zod의 JS 성공이 모델 endpoint 성공은 아님 | 제약 제거 없이 좁은 수정 | exporter 검사만으로 wire 회귀를 놓침 |
| <a id="P02"></a>P02 | 공개 terminal 계약의 구조화 분류를 읽기 | E06–E09 | v1 이벤트와 v2 혼동 금지 | 합성 payload 추측 제거 | 스트림 단절·미지 타입은 일반 실패 |
| <a id="P03"></a>P03 | 외부 진단 객체와 공개 메시지 분리 | E10–E12·E14 | known 타입도 raw 메시지는 안전하지 않음 | 공개 정보량을 코드로 제한 | 고정 문구는 일부 상세를 포기 |
| <a id="P04"></a>P04 | 기존 종료·화면 seam 재사용 | E13 | 제품의 로그인 오류는 추가 부작용 있음 | 불필요한 공용 계약 개편 방지 | 잘못된 login_required가 진단을 왜곡 |
| <a id="P05"></a>P05 | 라이브러리·synthetic peer·실제 CLI mock·실제 upstream 증거 구별 | E01·E05·E09·E12·E14 | 각 층이 다른 실패를 검증 | mock의 과장 방지 | 실제 CLI mock도 gateway 수락 보장은 아님 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 원본 path regex를 `/^[^\x00]*$/`로 바꾸고 NUL·길이·필드 조합을 보존 | P01·AC1–3 | 기존 실제 대조가 확인한 최소 표현 변경. 범용 schema normalizer 추가는 불필요 | Q1 |
| <a id="D02"></a>D02 | 채택 | 같은 sessionID의 failed.data.error에서 구조화 type·유효 status만 읽고, unknown·손상 응답은 일반 실패 | P02 | 2.2.6 실제 공개 타입 근거. raw 문자열 검색으로 원인 확정하지 않음 | Q2 |
| <a id="D03"></a>D03 | 변형 채택 | provider.invalid-request는 제품 작성 요청 거부 문구, 명시적 provider.auth는 별도 로그인 안내. 외부 message/body는 복사하지 않음 | P02–P04 | 타입 whitelist를 문구 작성 경계로 강화. HTTP400만으로 schema 세부 필드나 내부 엔진을 지목하지 않음 | Q2·Q4 |
| <a id="D04"></a>D04 | 채택 | 기존 RunResult.error를 통해 저장·API·화면 전달. 필요한 경우만 login_required 사용; 새 공용 오류 코드 체계·DB migration은 요구하지 않음 | P04 | 기존 결과 계약으로 안전 이유 표시 가능. 외부 서버 HTTP401/403만으로 제품 로그인 필요를 추정하지 않음 | Q4 |
| <a id="D05"></a>D05 | 채택 | 아래 경계 검증을 분리하고 명시적 거부를 같은 요청으로 자동 재전송하지 않음. 사용자 취소 우선과 실패 후 기존 세션 보존 유지. upstream 내부 retry override는 별도 관찰 범위 | P02·P05·E15·AC4–8 | 이번 원인의 수정에 DB 삭제·조직 직렬화 불필요. 취소 외 interruption의 구체 정책은 구현 중 기존 계약 대조 필요 | Q2·Q3 |
| <a id="D06"></a>D06 | 보류 | 추가 실제 gateway 호출·장시간 연구 검증 | E01·AC8 | 기존 실제 결과와 이번 mock 결과를 구별. 재실행하려면 계정·자격 증명·비용·횟수의 새 허가 필요 | Q1·Q3 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| pattern 삭제·임의 refine 치환·converter 교체 | Zod exporter 경계 | 공개 NUL 제약 보존을 보장하지 않음; 동등 표기 변경으로 충분 |
| 원문 오류·raw body·오류 JSON 전체 공개 | OpenCode·AI SDK | 토큰·연구 내용·reasoning 포함 가능 |
| 알려진 오류 타입으로 raw message를 감싸면 안전하다는 가정 | AI SDK module 반례 | 타입 확인은 문자열 정제가 아님 |
| 400/403→로그인 필요, DB 삭제 후 재시도, 조직 강제 직렬화 | #147 원문 초기 후보 | 최신 Agent Brief와 실제 최소 재현에 근거 없음 |
| JS 정규식 compile 성공→모든 upstream 호환, regex 엔진 추정 | JSON Schema·기존 실제 대조 | 관찰 범위를 넘어선 주장 |

## 구현 참고

- 권고 순서: 원본 schema 표현 수정 → MCP·OpenCode 조립 capture 회귀 → 실패 계약 기반 안전 문구 → 저장·API·화면 및 비노출 검증. 연구 승인을 대신하거나 다른 조직 자료를 섞는 지침 수정으로 해결하지 않는다.
- 위치: `packages/contracts/src/task.ts`는 입력 계약, `apps/server/src/mcp.ts`는 공개 목록, `packages/runtime/src/providers/opencode.ts`는 외부 오류 변환이다. Control Plane의 종료·승인·조직 경계와 Surface 표시 책임은 [전체 구조](../architecture.md) 및 [ADR-0005](../adr/0005-approval-policy-enforcement-scope.md)를 유지한다.
- 테스트 탐색 출발점: 서버 `apps/server/test/mcp.test.ts`, runtime `providers/opencode.test.ts`·`organization-folders.test.ts`·`other-providers.contract.test.ts` 및 `test-fixtures/opencode-simulator.mjs`. 기존 peer는 실제 SQLite·모델 요청 schema 소비자를 구현하지 않으므로 그것만 성공해도 AC3 충족이라고 하지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 실제 NUL·일반/절대/한글/숫자0 경로·길이 경계·path와 inline 조합 → 원본 schema parse → NUL 거부·기존 길이/조합 의미 유지 | D01 |
| V02 | 계획→초기 연구 승인→연구 → 실제 인증된 MCP tools/list → 계획에서 artifact 제외, 연구에서 포함, path.pattern 정확한 새 표현 유지. 원래 표현으로 되돌리면 실패하는 음성 대조군 | D01·D05 |
| V03 | 실제 CLI2.2.6+키 없는 가짜 모델·가짜 MCP → 요청 capture → 모델 function.parameters의 pattern 확인, 원래 표기를 의도적으로 거부하는 가짜 endpoint와 새 표기의 성공 대조 | D01·D05 |
| V04 | 같은 조직 재개·서로 다른 에이전트 동시+후속·다른 조직 → sessionID/지침/토큰·도구 목록 대조 → 경계 혼입 없음. CLI mock과 제품 조직 승인 통합 시나리오는 별도 실행 | D05 |
| V05 | 공개 계약에 맞는 failed.invalid-request·명시 auth·unknown·손상 응답·다른 sessionID → adapter→저장→API/화면 → 각각 안전한 이유·로그인 오분류 없음·타 조직 이벤트 무시·자동 재전송 없음 | D02–D05 |
| V06 | message/body/임의 추가 필드에 합성 토큰·연구 입력/출력·reasoning → 공개 error/summary/활동/run.finished/화면 검사 → 합성 비밀 비노출; 정상 알려진 분류까지 오염해 검사 | D03–D04 |
| V07 | 사용자 취소·실패와 동시 취소·불명 중단 → 기존 종료 계약 확인 → 취소 의미 유지, 승인·최종 완료·조직 경계는 제품에서 유지 | D05 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 안전 문구의 정확한 표현 | #147 구현 | 권고: “모델 서비스가 요청을 거부했습니다(HTTP 400). 도구 정의와 모델 호환성을 확인해 주세요.” status 없으면 괄호 생략. 알려진 invalid-request만으로 특정 schema 필드 탓이라고 쓰지 않음 |
| 사용자 취소 외 interrupted reason 매핑 | #147 구현 | user/shutdown/superseded/inactivity를 전부 사용자 취소로 취급하지 말고 기존 서버 재시작·제어 계약과 대조. 외부 interrupted 자체만으로 로그인 실패를 만들지 않음 |
| 실제 upstream 재검증 필요 여부 | 사용자 | 기존 실제 대조를 근거로 모델 없는 회귀만 수행 / 새 한도를 정해 실제 확인. 현재는 추가 호출 권한 없음 |

## 한계와 미확인

- 실행 확인은 위 라이브러리·module probe와 실제 CLI+mock 대조이며, 제품 회귀 테스트 추가·제품 수정·전체 테스트·E2E는 하지 않았다. 기존 댓글의 실제 호출을 이번 실행으로 집계하지 않는다.
- 실제 CLI+mock은 정상·합성400·합성401의 CLI JSON을 확인했다. MCP 도구 schema capture·serve SSE 직접 녹화·제품 adapter 저장/표시는 실행하지 않았다. OpenCode schema·생산자·테스트 소스 확인은 실제 SSE 녹화나 해당 테스트 실행과 다르다. 합성 재생 자료는 고정 버전 계약과 대조하고 synthetic이라고 표시해야 한다.
- 정상/후속·동시 실행 및 승인·조직 경계의 전체 검증은 구현 완료 조건으로 남는다. 이번 조사에서 통과한 것으로 보고하지 않는다.
- upstream 내부 정규식 엔진·과거 DB 삭제 후 일시 회복·SQLite 경합·OAuth 갱신 원인은 미확인이다. 후속 인증 격리는 #148, 실행 격리는 #149, 호출 키·복구는 #150 범위를 따른다.
- Ubuntu24.04 기준, macOS/Windows·Docker·장시간 실제 연구·모델 품질은 미검증이다. 코드 재사용 시 LICENSE·NOTICE·의존성을 재확인한다.

검사: `git diff --check` 통과. 작업 디렉터리의 `pnpm check`는 작업 전부터 있던 미커밋 #149 조사 문서 34행의 Git 무시 경로 표기에서 실패했다. 이를 수정하지 않고 HEAD 임시 사본에 이번 조사 문서·현재 문서 지도만 적용해 같은 `pnpm check`를 실행한 결과 122개 Markdown 링크 검사 통과(exit0). 제품 테스트·타입·lint·E2E는 이번 조사 범위에서 미실행이다.

## 구현 기록 (2026-11-11)

- 원문 확인: OpenCode `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`의 `packages/schema/src/session-event.ts`(Execution.Failed·Interrupted), `packages/schema/src/session-error.ts`(type·message·선택 status·response.body), `packages/core/src/session/to-session-error.ts`(InvalidRequest→`provider.invalid-request`, Authentication·AuthorizationError→`provider.auth`, providerError의 status·body 보존)를 직접 읽었다. D01–D04는 그대로 적용했다. Zod exporter 원문(E03·E04)은 다시 열지 않고, 실제 MCP `tools/list` 응답 검사로 대신 확인했다.
- D05 보완: 실제 CLI 2.2.6 + 가짜 모델 회귀에서 같은 조직의 두 에이전트가 새 조직 폴더에 서버를 함께 띄우자 하나가 시작 중 끝났다(stderr `SQLiteError: table account_state already exists`, 실행 시도는 일반 실패). 실행 시도 직렬화·폴더 분할 없이 같은 제품 폴더의 **서버 시작만** 하나씩 하도록 고쳤고, 띄운 뒤의 실행은 겹쳐 도는 것을 검사로 확인했다. 원래 실패 조직의 15:17 `SQLITE_BUSY`와 같은 원인인지는 확인하지 않았다.
- 검증 층: 계약 단위(NUL·길이·조합), 서버 MCP `tools/list`(연구 단계 pattern, `\0`로 되돌리면 실패), 합성 시뮬레이터(실패 이벤트 종류별 결과·비밀 비노출·재전송 없음·시작 경합·차례 대기 중 취소), 실제 CLI 2.2.6 + 가짜 모델(승인 전/연구 도구 목록, 동시·후속 실행, 조직 분리, 실제 CLI가 만든 400/401 실패 이벤트). 실제 CLI 검사는 OpenCode가 설치된 곳에서만 돈다. 실제 upstream 추가 호출은 하지 않았다(D06 보류 유지).
