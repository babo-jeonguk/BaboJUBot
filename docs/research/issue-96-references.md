# issue-96 레퍼런스 조사: 능력·끼워 넣기·사용량·작업별 세션·준비 상태

조사일: 2026-10-31. 대상: [#96](https://github.com/babo-jeonguk/BaboJUBot/issues/96), 부모 [#91](https://github.com/babo-jeonguk/BaboJUBot/issues/91), 완료된 선행 #94·#95. 구현 전 권고이며 확정 계약이나 구현 완료가 아니다. 상세 자료: `.reference-cache/issue-96/`(git 무시). 제품 코드·테스트·설정은 변경하지 않고 문서는 구현 변경과 함께 커밋하도록 둔다.

## Brief

- 구현할 문제: 네 프로바이더를 위한 실행 시도 계약과 공통 검사를 먼저 넓히고, 가짜 프로바이더로 능력 선언·실행 중 입력·개별 사용량·세션·준비 상태를 연결한다.
- 동종 문제: **능력이 서로 다른 외부 실행 프로그램에 영속 실행 신원·세션·관찰 결과를 연결하고, 실행 중 전달과 사전 진단을 분리하는 계약**.
- 고정된 결정: 초기 연구 승인·최종 완료·조직 경계는 제품 코드가 강제한다. ADR-0002의 영속 기록·깨우기를 유지하며 끼워 넣기는 Lead 사용자 메시지만 허용한다. 준비 확인은 모델을 부르지 않고 admission을 기다리게 하지 않으며 다른 연결로 바꾸지 않는다. #94에서 연결 ID·모델 null·진행 run 선택 고정·전역 `settings_changed`가 구현됐다. #95에서 개별 작업자 제안/결정과 Lead `list_providers`가 구현됐다. 화면 설명문·경고문 없음, 배지 붙여쓰기·초안 보존은 부모 댓글과 #96에서 확정됐다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 능력을 빠짐없이 선언하고 선언과 실제 동작을 어떻게 검사하는가? | #96 AC1·8 | API·프로토콜 + Source Recon + 음성 대조 |
| Q2 | 지금 run에 끼워 넣기·거절 후 줄 세우기를 전달 유실/중복 없이 어떻게 잇는가? | #96 AC2·9, ADR-0002 | Source Recon + runtime/failure·종료 경합 |
| Q3 | 입력/출력/캐시 읽기/쓰기/비용의 값과 미보고, 누적과 run 사용량을 어떻게 구분하는가? | #96 AC3·8 | schema·parser Source Recon + Behavioral Recon |
| Q4 | 받은 wake로 세션을 고르고 provider/bundle 변경·재개 실패·늦은 종료를 어떻게 다루는가? | #96 AC4–5·9, #94 | Source Recon + persistence/recovery·교차 조직 시나리오 |
| Q5 | 모델 없는 준비 확인의 상태·이유·갱신 시점·비동기 저장을 어떻게 나누는가? | #96 AC6–7·9 | Source Recon + failure·비용 경계 |
| Q6 | 확정된 UI를 배지·컨트롤·미보고 값으로 구현할 때 접근성·진행 상태는 어떻게 지키는가? | #96 화면 조건·E2E | Surface Capture + Behavioral Recon + DS 소스 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [연결 방식](provider-connection-references.md) | 프로세스 수명·steer·resume·취소·사용량의 차이 | 기존 주장은 문서 링크로만 인용. 결정에 쓰는 Paseo 원문은 새 SHA로 독립 확인 |
| [네 프로바이더 능력](executor-capabilities.md) | adapter 후속 작업의 출발점, CLI와 프로토콜 차이 | 이슈가 명시한 공통 계약을 재결정하지 않는다. 실제 네 프로그램 실행은 하지 않음 |
| [선택·준비 상태](executor-selection-references.md) | Paperclip 진단과 모델 hello probe의 차이 | Paperclip 최신 소스에서 재확인. 기존의 경고 UI 권고는 #91·#96의 후속 사용자 결정으로 배제 |
| [화면 지침](design-guidelines-pan2.md) | A·B·D·F·G, 배지·버튼·이름-값 표 | 화면 원칙은 확정된 요구로 재사용. 이번 관찰과 분리 |
| [#94](issue-94-references.md)·[#95](issue-95-references.md) | 선택·cap·snapshot·Lead 조회·초안 | 조사 당시 열린 결정은 완료 이슈/댓글이 우선. 현재 자체 HEAD `db62a51055938bea597d6998c45601ff7ffd8937`에서 아래 소스를 읽음 |

## 레퍼런스

관점별 각 3라운드 탐색: 세션/능력/입력은 provider OSS→프로토콜·checkpoint→오류 테스트·extension, 준비/사용량은 운영 OSS→측정 라이브러리→실패 보고, UI는 기존 가이드→운영 label·query 취소→소스·테스트로 넓혔다. 마지막 라운드가 기존 입력 소유권·명시 상태·응답 순서 패턴만 반복해 이번 질문 범위에서 종료했다. 전수조사 주장이 아니다. 전체 후보는 `candidates.md` 18행(관점 중복 포함), 실행 경로·선정 이유·라운드별 검색은 관점별 `notes/`에 있다.

| 레퍼런스 | 분류 | 고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| Paseo | 실행 프로그램 | `a4f696620b5d248598a882b1a78d82ec5038c74b` | Apache-2.0 | 소스·classifier 실행: 진행 턴 신원과 모호 오류 |
| Paperclip | 조직 운영 | `aa58fa107389e8b9ae5949f7ad815943dfd94292` | MIT | 소스·usage 실행: 작업 세션·재개 복구·비용 반례 |
| Agent Orchestrator(AO) | 준비 진단 | `0a43ac09dde2261a469fb39d7c64d3d946352942` | Apache-2.0 | 소스: 3값·동시 확인 |
| AI SDK | 측정 부품 | `ae5b13ee576e9176b1aaef2348f4d75b0812974a` | Apache-2.0 | 소스·실행: 미보고 표현 |
| SEED | 디자인 시스템 | `99efaf5561de6e18557ffeb57fe95428ce066eb3` | Apache-2.0 | 소스·공개 실행: 지정된 배지·진행 표시 |

codex-acp는 E13 문서 비교만 했다(라이선스 미검증, 코드 재사용 제외). 나머지 후보 ACP·LangGraph·OpenClaw·Vibe Kanban·실패 이슈·PatternFly·TanStack·React·기존 가이드는 목록/문서 범위다. 설계 참고만 하며 외부 코드 복사 없음. Paseo 기존 SHA의 핵심 4파일 blob은 모두 변경되어 새로 읽었다. Paperclip 기존 선택 조사 대비 세션·Claude 실행 2파일은 blob 동일이나 새 원문을 읽었다. SEED는 기존 #95와 같은 SHA다. 자세한 비교는 `recon/sessions.md`에 있다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현재 usage는 입력/출력 필수, 비용 nullable이며 cache 항목이 없다. adapter는 execute(signal,emit), 연결은 능력·진단을 선언하지 않는다. | [원문 1](https://github.com/babo-jeonguk/BaboJUBot/blob/db62a51055938bea597d6998c45601ff7ffd8937/packages/contracts/src/run.ts#L241-L319) | 소스 확인 |
| <a id="E02"></a>E02 | 현재 admission은 agent의 직전 run에서 sessionAfter를 가져온다. 메시지는 message+wake+Event transaction으로 저장한다. | [원문 1](https://github.com/babo-jeonguk/BaboJUBot/blob/db62a51055938bea597d6998c45601ff7ffd8937/packages/db/src/runs.ts#L118-L146) · [원문 2](https://github.com/babo-jeonguk/BaboJUBot/blob/db62a51055938bea597d6998c45601ff7ffd8937/packages/db/src/conversations.ts#L240-L294) | 소스 확인 |
| <a id="E03"></a>E03 | Paseo는 expectedTurnId를 포착하고 accepted에만 전달을 기록한다. unavailable→replace 동작도 별도로 존재한다. | [원문 1](https://github.com/getpaseo/paseo/blob/a4f696620b5d248598a882b1a78d82ec5038c74b/packages/server/src/server/agent/agent-manager.ts#L3016-L3093) | 소스 확인 |
| <a id="E04"></a>E04 | Codex steer는 thread/turn 신원을 재검사하고 ack turnId 일치 때 accepted. 명시적 거절만 unavailable, transport/unknown 오류는 throw한다. 읽은 fake app-server 테스트도 이를 assert한다. | [원문 1](https://github.com/getpaseo/paseo/blob/a4f696620b5d248598a882b1a78d82ec5038c74b/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4430-L4483) · [원문 2](https://github.com/getpaseo/paseo/blob/a4f696620b5d248598a882b1a78d82ec5038c74b/packages/server/src/server/agent/providers/codex-app-server-agent.test.ts#L431-L490) | 소스 확인 |
| <a id="E05"></a>E05 | 원문 classifier 추출 실행: 명시 거절5·모호 오류3·일반 Error 음성대조1 모두 통과. | Paseo E04 SHA; `probes/steer-rejection.mjs`, `steer-run-log.txt`, 메인 재실행 동일 | 실행 확인 |
| <a id="E06"></a>E06 | Paperclip은 company+agent+adapter+taskKey로 세션 조회, taskKey 없으면 agent 세션. Claude는 bundle/cwd/target 일치를 확인하고 known session error에 로그 후 같은 execute에서 fresh 재시도한다. | [원문 1](https://github.com/paperclipai/paperclip/blob/aa58fa107389e8b9ae5949f7ad815943dfd94292/server/src/services/heartbeat/run-state.ts#L1256-L1274) · [원문 2](https://github.com/paperclipai/paperclip/blob/aa58fa107389e8b9ae5949f7ad815943dfd94292/server/src/services/heartbeat/run-state.ts#L1492-L1517) · [원문 3](https://github.com/paperclipai/paperclip/blob/aa58fa107389e8b9ae5949f7ad815943dfd94292/packages/adapters/claude-local/src/server/execute.ts#L1371-L1418) | 소스 확인 |
| <a id="E07"></a>E07 | Paperclip 진단은 Respond with hello. 모델 요청을 한다. usage fallback은 누락 입력/출력/cache read를 0으로 채운다. 둘 다 #96의 반례다. | [원문 1](https://github.com/paperclipai/paperclip/blob/aa58fa107389e8b9ae5949f7ad815943dfd94292/packages/adapters/claude-local/src/server/test.ts#L380-L447) · [원문 2](https://github.com/paperclipai/paperclip/blob/aa58fa107389e8b9ae5949f7ad815943dfd94292/packages/adapters/claude-local/src/server/execute.ts#L1122-L1138) | 소스 확인 |
| <a id="E08"></a>E08 | Codex 누적 측정은 historical baseline과 latest max를 보관해 delta를 계산한다. AI SDK는 각 usage/cache 항목의 undefined를 유지하고, 둘 다 미보고면 합계도 undefined다. 한쪽만 보고되면 부분합이다. | [원문 1](https://github.com/paperclipai/paperclip/blob/aa58fa107389e8b9ae5949f7ad815943dfd94292/packages/paperclip-runner/src/drivers/codex/codex-usage-baseline.ts#L1-L45) · [원문 2](https://github.com/vercel/ai/blob/ae5b13ee576e9176b1aaef2348f4d75b0812974a/packages/ai/src/types/usage.ts#L10-L185) | 소스 확인 |
| <a id="E09"></a>E09 | 원본 함수 실행: Codex baseline6·AI SDK 미보고/0/부분합5 assertions 통과. 누적 반복·과거 snapshot·잘못된 숫자·cache 누락 대조 포함. | `probes/codex-usage.mjs`, `ai-sdk-usage.mjs`, 각 run-log; E08 SHA, 메인 재실행 동일 | 실행 확인 |
| <a id="E10"></a>E10 | AO는 설치+인증 상태에서 3값을 도출한다. 로컬 credential configured는 unknown. 동시 확인을 공유하고 버전을 검사하지만 Ensure는 완료를 기다린다. | [원문 1](https://github.com/ComposioHQ/agent-orchestrator/blob/0a43ac09dde2261a469fb39d7c64d3d946352942/backend/internal/domain/agent_readiness.go#L279-L301) · [원문 2](https://github.com/ComposioHQ/agent-orchestrator/blob/0a43ac09dde2261a469fb39d7c64d3d946352942/backend/internal/service/agent/readiness_coordinator.go#L317-L410) | 소스 확인 |
| <a id="E11"></a>E11 | SEED Badge는 span Root/Prefix/Label과 별도 button Action. useProgress는 value 없을 때 indeterminate, aria-valuenow 생략·progressbar 제공. 접근성 값 loading...은 영어다. | [원문 1](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react/src/components/Badge/Badge.tsx#L30-L97) · [원문 2](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react-headless/progress/src/useProgress.ts#L22-L45) | 소스 확인 |
| <a id="E12"></a>E12 | 공개 Badge에서 스크롤·텍스트 선택 뒤 prefix 아이콘+라벨을 1280px/390px에서 관찰하고 캡처 2개를 메인이 재열람했다. 제품 준비 상태 전이를 관찰한 것은 아니다. | [SEED Badge 공개 데모](https://seed-design.io/react/components/badge), `captures/captures.md` | 실행 확인 |
| <a id="E13"></a>E13 | codex-acp 문서는 pre-standard steering extension과 promptRequired opt-in(입력 미소비·host가 다음 prompt 소유)을 명시한다. 표준/모든 adapter의 보편 능력으로 일반화할 수 없다. | [원문 1](https://github.com/agentclientprotocol/codex-acp/blob/ef45a6d97cd81810aaebcba9533af5411dadec6f/docs/steering.md#L1-L59) | 문서 주장 |

근거 13행: 소스 확인9·실행 확인3·문서 주장1. 아래 패턴·권고는 이 관찰과 제품 요구를 종합한 **추론**이다. Node v24.21.0, Playwright1.58.2/Chromium1208. 순수 함수 probe는 키 없는 셸·설치 없이 실행했다. full SDK/프로바이더를 띄운 self-host 실행은 없고 `selfhost/`는 미사용이다. 결정에 쓰는 원문과 캡처는 메인이 재열람했다(`main-verification.md`).

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이·장점 | 비용·실패 모드 |
|---|---|---|---|---|
| P01 | 정적 능력 + 지금 실행에 대한 승인 | E03–E05·E13 | 미지원 UI 제거와 실행 시점 거절은 별개. turn ID와 ack로 귀속 확인 | timeout을 거절로 취급하면 중복, 자동 replace는 진행 작업 중단 |
| P02 | task별 영속 핸들 + provider/bundle 적합성 | E02·E06 | 오래된 agent 마지막 run보다 정확히 작업 맥락 재사용 | 변경 전 run의 늦은 종료로 무효화한 세션 부활, 모든 오류 재시도는 부작용 반복 |
| P03 | 필드별 관측 여부 + 누적 baseline | E01·E07–E09 | 0과 모름, account quota와 run usage 분리 | counter reset·부분합·cache 이중계상 |
| P04 | 진단 결과와 검사 중 상태·실행 admission 분리 | E07·E10 | 3값·reason code·공유 확인으로 거짓 ready와 중복 호출 감소 | 기다리는 Ensure 그대로 도입 시 실행 지연, 낡은 결과 덮기 |
| P05 | 상태와 행동을 별도 컴포넌트로 조립 | E11–E12 | prefix+label+tone, 행 단위 spinner·독립 버튼 | static span의 상태 변경 알림·접근성 이름은 앱 책임 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| D01 | 변형 채택 | 연결 등록 시 끼워 넣기·resume·resume 지침 재주입·run 토큰·run 비용·precompact를 필수로 선언. 선언 누락 거부, true는 성공/거절 장면, false는 미지원 장면으로 공통 검사 | P01·E01, AC1·8 | upstream optional default를 복제하지 않는다. 토큰 지원과 비용 지원은 따로 표현해 부분 보고 허용 | Q1 |
| D02 | 변형 채택 | 메시지 ID·예상 run ID를 고정하고 영속 기록 뒤 전달. accepted ack만 현재 run 수신으로 표시, 명시 거절은 같은 메시지의 wake를 줄 세우기. 오래된 run 응답은 새 run에 적용하지 않음 | P01·E02–E05 | DB transaction 안 외부 await는 피한다. 모호 오류는 별도 열린 결정 R1, 성공 후 DB 저장 실패/재시작도 대조 필요 | Q2 |
| D03 | 변형 채택 | 5항목 각각 nullable 값(또는 동등한 명시 union), 0 보존. adapter가 native per-run 또는 세션별 baseline 차감으로 정규화하고 실패·취소에서도 알려진 값 보존. 비용에 추정 여부 포함 | P03 | 세션 ID/reset 세대별 baseline 필요. 일부 턴 누락을 전체 합계로 꾸미지 않고 cache 포함 관계를 adapter 문서에 명시 | Q3 |
| D04 | 변형 채택 | 실제 claim한 wake 묶음 전부가 같은 task일 때 해당 task 세션, 하나라도 무작업/다른 task면 agent 세션. 조직·agent·task의 일관된 귀속과 null task 유일성 강제. provider 연결 ID+bundle을 세션에 저장해 비교 | P02·AC4 | #96 규칙은 Paperclip이 증명하지 않는다. task_completed의 taskId는 완료된 자식이므로 현재 담당 작업과 혼동 금지 | Q4 |
| D05 | 채택 | provider 변경은 agent 모든 task/agent 세션 무효화, 모델만 변경은 유지. 실행 이력은 보존하되 무효화 세대 등 조건을 만족할 때만 종료 세션을 현재 포인터에 저장 | P02·E02·자체 잠금 구조 | A→B→A 동안 old A 종료가 세션을 되살리지 않아야 한다. 조직→agent→run 순서에 맞춰 admission/설정/finish 직렬화 | Q4 |
| D06 | 변형 채택 | adapter가 알려진 resume 거절에서 같은 run ID·token·wake로 fresh 시작을 한 번 수행하고 공개 활동 기록. 취소 후 재시도 금지 | E06·AC5 | 일반 실행/인증/timeout 오류까지 복구로 분류하면 중복 실행. 반환 세션은 fresh 결과, 실패한 재개의 세션 재저장 금지 | Q4 |
| D07 | 변형 채택 | 무모델 check가 상태·안전한 reason code·checkedAt 반환. startup/settings-open/recheck/auth-failure-finish에서 비동기 확인·저장, admission과 분리. 연결별 공유 확인+세대 검사로 낡은 결과 저장 방지 | P04·AC6 | configured만으로 ready 단정 금지. 로그인 명령은 product_login_missing 전용, ready가 실행 성공 보장은 아님. 전역 settings_changed 재사용 | Q5 |
| D08 | 채택 | 상태 배지·미지원 버튼 숨김·사용량 표·초안은 #96 화면 계약 그대로. 현재 run의 능력으로 끼워 넣기 판단, spinner의 시각 라벨은 생략해도 행과 연결된 접근성 이름 제공 | P05·AC7·화면 조건 | 준비안됨도 선택 가능. 거절은 queue 목록에만 반영. 이유코드/제어에 raw stderr·토큰 사용 금지 | Q6 |
| D09 | 보류 | precompact 지원 선언·공통 검사 seam만 #96. 스케줄·기준·세션 동시 접근 조정은 후속 #99 | Q1·부모 #91 | 실제 압축·모델 호출을 이번 공통 계약 조사로 확대하지 않음 | Q1 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| steer 거절 시 자동 replace/새 턴 시작 | Paseo E03, codex-acp E13 기본 동작 | #96은 현재 작업을 유지하고 queue로 보내야 함 |
| catch-all 오류를 거절로 보고 재전달 | E04–E05 | 수신 여부 모호하면 중복될 수 있음 |
| hello 모델 호출로 자동 준비 검사 | Paperclip E07 | #96 무모델·비용 경계 위반 |
| 빠진 token을 0으로 채우거나 파일 존재를 ready로 표시 | E07–E10 | 미보고·알수없음 의미 손실 |
| 새 전역 준비 상태를 임의 조직 Event로 저장 | #94 확정 결정·GLOSSARY | Event의 조직 귀속 훼손. 전역 저장+갱신 신호로 처리 |
| checkpoint 엔진 도입·준비 실패 시 자동 provider 교체·경고 배너 | 후보 LangGraph, 과거 선택 조사 일부 | 각각 범위 밖·명시 선택 훼손·후속 사용자 UI 결정 위반 |

## 구현 참고

권고는 공통 계약/검사→세션·메시지 저장 경계→비동기 readiness→가짜 연결 설정→화면 순서로 연결할 때 참고한다. 확정 설계는 #96 구현에서 정한다.

- `packages/contracts/src/run.ts`·`provider.ts`·`message.ts`: 필수 capability·선택적 usage 필드·준비 상태·steer 결과. 기존 입력/출력 필수 usage 및 legacy 행은 미보고를 0으로 backfill하지 않는다.
- `packages/core/src/run.ts`·`provider.ts`: wake 묶음 기반 세션 선택·무효화 판단. DB/runtime import 없이 순수 판단 유지.
- `packages/db/src/runs.ts`·`providers.ts`·`conversations.ts`: 세션 저장·무효화·메시지 전달 기록·migration·조직 귀속·잠금 순서.
- `packages/runtime/src/runtime-contract.ts`·`scripted.ts`·`providers.ts`: 선언과 성공/거절/재개 실패/부분 usage/진단을 제어하는 fake, 공통 검사 확장.
- `apps/server/src/providers.ts`·`dispatcher.ts`·`run-request.ts`·`app.ts`: 연결 검사·현재 run 입력 통로·비동기 진단 갱신·완료 오류 분류. 실제 provider별 CLI·자격 경로는 후속 #98·#100·#101.
- `apps/web/src/global-settings.tsx`·`provider-choice.tsx`·`chat.tsx`·`agents.tsx`·승인 상세: 공통 준비 배지와 현재 run 능력, nullable usage 표시. 현재 기준은 [코드 지도](../agents/code-map/providers.md)·[구조](../architecture.md)·ADR-0002.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 능력 필드 생략/false/true → 등록·공통 검사 → 누락 실패, false 미노출/미지원, true 성공·거절 검증 | D01 |
| V02 | live run에 steer 수락/거절 → message 수신 또는 queue → 하나의 message만, received order·conversation 보존 | D02 |
| V03 | 전송 도중 종료·cancel·새 run 시작/ACK 이후 DB 실패 → reconciliation → 다음 run 오귀속·메시지 유실·무조건 재전달 방지 | D02·R1 |
| V04 | 0·null·부분 cache·음수·중복 누적·session reset → 정규화/표시 → 0 유지·미보고 구분·잘못된 값 거부·이중계상 없음 | D03 |
| V05 | task A+A / A+B / A+heartbeat / 무작업 / interrupt 우선 묶음 → 세션 선택 → A/task 또는 agent 세션 규칙, claim 제외 wake 영향 없음 | D04 |
| V06 | 동일 task 다른 조직/agent 참조 → 세션 조회·저장 → 거부, null task 중복 세션 없음 | D04 |
| V07 | provider A→B→A 중 old A 종료, 다른 task 세션 존재 → 무효화·finish → 전 세션 비움 유지; 모델만 변경은 유지 | D05 |
| V08 | bundle 변경 / known resume 실패 / fresh 실패 / cancel → 전달·재시도 → stale session 없음, 동일 run 한 번 fresh+활동, cancel 후 실행 없음 | D05–D06 |
| V09 | startup·settings open·recheck·auth failure finish → 진단 → 네 trigger 저장, 모델 mock 호출 0, 지연 진단 중 run 시작, provider 자동 대체 없음 | D07 |
| V10 | 재확인 중 auth 무효화·늦은 성공·중복 클릭·서버 재시작 → 저장 → 최신 세대만 반영, 실패는 unknown과 안전한 code, 마지막 검사 정보 보존 | D07 |
| V11 | 미지원 run·not_ready 선택·product_login_missing·일반 timeout → UI → steer 숨김·선택 유지·로그인 복사는 해당 이유만, 접근성 이름 확인 | D08 |
| V12 | usage 1,234 /0/null·390px·닫기→재열기 → UI → 단위·추정 배지·보고 안 됨·초안 유지, 판1 전체 회귀 | D03·D08 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| R1 모호한 steer 전송·ACK 이후 crash의 처리 | #96(메시지 전달 의미가 달라지면 사용자) | A: 미전달을 보장하거나 native message ID로 ack 재조회 가능한 adapter만 steer=true(권고). B: 전송 불명 상태를 영속화해 provider별 reconciliation 후 queue. timeout을 즉시 명시 거절로 취급하는 안은 배제. 무조건 exactly-once 전달을 보장했다고 보고하지 않는다 |
| R2 capability 세분화·reason enum·usage wire 호환 | #96 | 토큰/비용 별도 boolean 또는 필수 구조형 선언. usage nullable 필드 또는 명시 union 중 하나를 선택하되 각 항목 미보고 보존. timeout/unsupported는 unknown, product login missing만 로그인 복사 |
| R3 task_completed 세션 귀속 | #96(제품 의미 변경 시 사용자) | 현재 wake.taskId(완료된 자식) 그대로 사용하거나 별도 대상 task 해소 계약을 둔다. 어떤 안도 부모 담당자의 다른 작업으로 암묵 치환하지 않는다. #96의 '모두 한 작업' 규칙을 명시 사례로 고정 |

## 한계와 미확인

- 실행 확인은 classifier9 + usage11 assertions, 공개 Badge 2폭 관찰뿐이다. 준비 진단 Go 테스트는 도구가 없어 읽기만, DB 복구·세션/steer transport·실제 네 provider·모델·로그인·과금은 실행하지 않았다.
- Progress 공개 페이지의 최종 heading locator가 timeout해 전체 UI 스크립트 exit1. Badge 성공 캡처만 근거로 쓰고 spinner 실화면은 미확인이다. 준비 상태 행 전체·사용량 표·queue 거절·초안·스크린리더는 제품 구현 시 검증한다.
- startup/전역 설정 갱신의 영속 저장·세대 검사, cross-organization refusal, capability 공통 검사 통과는 권고 시나리오이며 구현 결과가 아니다. 전체 upstream suite·핵심 파일 git history/blame 및 연결 PR의 변경 이유 추적은 미확인이다.
- upstream은 계속 변한다. ACP의 과거 'steer 없음' 일반화는 최신 pre-standard extension E13에는 맞지 않는다. 이번 조사는 연결 방식을 재결정하지 않는다.
- 코드 복사·라이브러리 도입 권고가 아니다. 향후 복사 시 고정 SHA LICENSE/header/NOTICE/전이 의존성과 AGENTS 고지 규칙을 별도 확인한다.
