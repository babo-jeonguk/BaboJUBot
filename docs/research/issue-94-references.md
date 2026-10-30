# issue-94 레퍼런스 조사: 에이전트별 프로바이더·모델, 전역 기본값, 동시 실행 상한

조사일: 2026-10-30. 대상: [#94](https://github.com/babo-jeonguk/BaboJUBot/issues/94), parent [#91](https://github.com/babo-jeonguk/BaboJUBot/issues/91). 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-94/`(git 무시). 제품 코드·테스트·설정은 변경하지 않았다.

## Brief

- 구현할 문제: 서버의 이름 붙은 프로바이더 연결 여러 개, 에이전트별 선택, 생성 기본값, 연결별 동시 실행 상한과 사용자 설정 화면을 가짜 프로바이더 둘로 검증할 수 있게 한다.
- 동종 문제: 오래 사는 구성원의 실행 설정을 실행 시도마다 고정하고, 여러 구성원이 공유하는 실행 자원을 원자적으로 할당한다.
- 고정된 결정: #94 AC를 우선한다. 기존 에이전트는 가짜 프로바이더로 채움, 모델 비움은 프로바이더 기본, Lead·작업자 기본값은 생성 때 복사, 변경은 다음 실행 시도부터, 상한 기본 2·최소 1·감소 시 진행 유지. 에이전트당 실행 시도 하나, 승인·최종 완료·조직 경계는 유지한다. 설명문·경고문 없는 화면, `기본 모델` 첫 옵션, 초안 보존, `닫기`, 좁은 화면 bottom sheet도 고정이다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 연결 ID·adapter 종류·모델 목록·nullable 기본을 어떻게 나누는가? | #94 AC1–3 | API/Adapter + Source Recon |
| Q2 | 생성 기본값과 변경 시점·실행 이력·세션을 어떻게 고정하는가? | AC4–6, #91 story15 | Source Recon + persistence/recovery |
| Q3 | 연결별 상한과 에이전트별 하나를 함께 지키고 감소·취소·복구를 처리하는가? | AC7,9 | Source Recon + runtime/failure |
| Q4 | dependent Select·stepper·설정 초안·좁은 dialog의 책임은 무엇인가? | 화면 조건·패턴, AC5,6,10 | Surface Capture + Behavioral Recon |
| Q5 | 전역 설정 기록·다른 탭 동기화를 조직 Event 경계와 어떻게 함께 지키는가? | AC8, GLOSSARY Event, architecture | 현재 계약 Source Recon + 신뢰 경계 대조 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [프로바이더 선택 조사](executor-selection-references.md#babojubot에-주는-시사점) | 에이전트 소유 설정, 생성 복사, 모델 초기화, 새 세션 | 새 SHA와 파일별 blob 비교: Multica 관련 파일·Paperclip 타입/registry는 변경 없음, AO manager는 변경되어 새 원문을 읽음. 비교 결과는 cache `notes/selection-source/blob-comparison.json` |
| [화면 지침](design-guidelines-pan2.md) A·B·C | Select·stepper·Save·초안·bottom sheet, 문장 없는 상태 표시 | SEED 고정 SHA 및 공개 데모 재확인. E11–E13 및 한계 참조 |
| [#59](issue-59-references.md), [#61](issue-61-references.md), [#63](issue-63-references.md) | 취소 정리·에이전트 하나·복구의 배경 | 외부 E ID를 이식하지 않고 현재 저장소 원문(E09–E10)으로 확인 |
| [기능 비교](executor-capabilities.md), [연결 방식](provider-connection-references.md) | 실제 adapter 후속 범위 식별 | 실제 provider 사실은 이번 권고 근거로 재사용하지 않음 |

기존 선택 조사의 `Lead는 프로바이더를 제안하지 않는다`, `정적 목록 + 직접 입력`, 자유 args를 승인 경계로 배제한 옛 근거는 최신 #91/#94 및 ADR-0005와 구분한다. 팀 제안은 후속 #95, 목록은 #94의 동적 조회/고정 fallback을 따른다. 나머지 그래프·메모리·채널 조사는 직접 관련이 없어 재사용하지 않았다.

## 레퍼런스

관점별 saturation은 후보 수의 충분함이 아니라 마지막 검색에서 새 패턴·실패 모드가 나왔는지로 판단했다. 전체 후보·검색 경로·실행 경로는 `.reference-cache/issue-94/candidates.md`에 기록한다.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| Multica | agent OSS | `908456c60192907f3c7e65709e18846f08eea2f8` | Multica License(추가 조건) | 소스 | 연결 identity·model reset·session guard |
| AO | agent OSS | `be4259d4fa281c6194f3acf24f8b12323aa750e7` | Apache-2.0 | 소스 | 역할 기본값과 저장 선택 복원 |
| Paperclip | agent OSS | `8035f8b245fddeda5857a2248688eaac7c6051e6` | MIT | 소스 보조 | 동적/정적 catalog 차이 |
| p-queue | 큐 부품 | 10.0.0 · `7f272ab5ff2254c0dc2537b7977e88ede1cd55e8` | MIT | 소스·실행 | cap 감소와 취소 조기 반환 반례 |
| BullMQ | 영속 큐 | `e80a9ea72e985849eb2096e5820db6a63c17f665` | MIT | 소스 | 공유 cap과 claim 원자성 |
| SEED | UI 부품 | `99efaf5561de6e18557ffeb57fe95428ce066eb3` | Apache-2.0 | 소스·공개 데모 실행 | AC가 명시한 실제 컨트롤 |
| React | 공식 상태 수명 문서 | 확인일 2026-10-30 | 코드 복사 없음 | 문서 | dialog unmount와 draft 보존 책임 |

- agent OSS 관점: 기존 후보→공식 역할 문서·모델 mismatch 이슈→현재 소스/테스트 순으로 3라운드. 마지막은 역할 기본·snapshot·catalog·session guard의 반복으로 수렴.
- 큐 관점: p-queue/BullMQ/agent 실패 보고→p-limit/Bottleneck 대안으로 2라운드. 마지막 추가 항목은 rate/weight/Redis cluster로 #94 밖이며 cap 질문에 새 실패 모드가 없었다.
- UI 관점: SEED→Radix/React Aria/Chakra→React state 수명으로 3라운드. 마지막 교차 검색은 controlled 값·경계·responsive·draft 소실의 반복. Q5의 직접 일치 외부 사례는 레퍼런스 없음으로 남겼다.

후보 항목 20개(관점 간 중복 포함), 심층·보조 소스 대상 6개. 검색 범위 안의 saturation이며 모든 OSS의 완전 탐색을 뜻하지 않는다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | runtime의 UUID·name·provider를 분리하고 에이전트가 runtime_id를 참조한다. 연결 인스턴스와 프로그램 종류를 나누는 사례 | [Multica migration L1–18](https://github.com/multica-ai/multica/blob/908456c60192907f3c7e65709e18846f08eea2f8/server/migrations/004_agent_runtime_loop.up.sql#L1-L18) | 소스 확인 |
| <a id="E02"></a>E02 | Paperclip은 `models`와 `listModels`를 함께 선언하고, 동적 결과가 비면 고정 목록을 사용한다. 이 함수에 thrown error catch는 없다. Codex 내장 목록은 오디오·이미지 모델 혼입 때문에 정적 목록 사용 | [registry `listAdapterModels` L1146–1161](https://github.com/paperclipai/paperclip/blob/8035f8b245fddeda5857a2248688eaac7c6051e6/server/src/adapters/registry.ts#L1146-L1161), [타입 L520–521](https://github.com/paperclipai/paperclip/blob/8035f8b245fddeda5857a2248688eaac7c6051e6/packages/adapter-utils/src/types.ts#L520-L521) | 소스 확인 |
| <a id="E03"></a>E03 | AO는 역할 harness가 맞을 때 역할 모델을 상속한다. 복원에서는 저장한 model을 빈 값까지 그대로 사용하며 오늘의 기본값으로 덮지 않는다 | [manager `effectiveAgentConfig`·`restoredAgentConfig` L2321–2377](https://github.com/ComposioHQ/agent-orchestrator/blob/be4259d4fa281c6194f3acf24f8b12323aa750e7/backend/internal/session_manager/manager.go#L2321-L2377) | 소스 확인 |
| <a id="E04"></a>E04 | Multica는 runtime 변경 때 명시 모델이 없으면 known incompatible만 초기화한다(unknown/custom 보존). 세션 fallback은 이전 runtime ID가 같을 때만 받는다 | [agent update L2221–2229](https://github.com/multica-ai/multica/blob/908456c60192907f3c7e65709e18846f08eea2f8/server/internal/handler/agent.go#L2221-L2229), [daemon L3721–3730](https://github.com/multica-ai/multica/blob/908456c60192907f3c7e65709e18846f08eea2f8/server/internal/handler/daemon.go#L3721-L3730) | 소스 확인 |
| <a id="E05"></a>E05 | p-queue는 pending < cap일 때만 시작한다. setter는 새 cap을 적용하고 대기를 처리하며 진행 작업을 취소하지 않는다 | [`index.ts` guard L389–404](https://github.com/sindresorhus/p-queue/blob/7f272ab5ff2254c0dc2537b7977e88ede1cd55e8/source/index.ts#L389-L404), [setter L790–800](https://github.com/sindresorhus/p-queue/blob/7f272ab5ff2254c0dc2537b7977e88ede1cd55e8/source/index.ts#L790-L800) | 소스 확인 |
| <a id="E06"></a>E06 | p-queue의 signal 취소는 원 작업과 Promise.race하며 finally에서 logical slot을 반환한다. 프로세스 정리 완료와 동일하지 않다 | [`add` L685–732](https://github.com/sindresorhus/p-queue/blob/7f272ab5ff2254c0dc2537b7977e88ede1cd55e8/source/index.ts#L685-L732) | 소스 확인 |
| <a id="E07"></a>E07 | 원본 TS 실행: 2→1 감소 시 두 진행 작업 유지·새 cap 미만이 될 때 대기 시작, cap0 거부, 두 큐 독립, 취소 뒤 원 작업 cleanup 전 다음 작업 겹침 재현 | p-queue E05 SHA, Node v24.21.0; `probes/pqueue-concurrency.mjs`, `probes/concurrency-run-log.txt`. 메인 재실행도 네 PASS | 실행 확인 |
| <a id="E08"></a>E08 | BullMQ Lua는 active count가 cap 이상이면 대기를 유지하고, 같은 호출 안에서 통과 후 wait→active로 옮긴다 | [`getQueueMetadata` L5–20](https://github.com/taskforcesh/bullmq/blob/e80a9ea72e985849eb2096e5820db6a63c17f665/src/commands/includes/getQueueMetadata.lua#L5-L20), [`moveToActive` L54–74](https://github.com/taskforcesh/bullmq/blob/e80a9ea72e985849eb2096e5820db6a63c17f665/src/commands/moveToActive-11.lua#L54-L74) | 소스 확인 |
| <a id="E09"></a>E09 | 현재 admission은 조직→에이전트 잠금, 진행 run 검사와 wake 전달을 한 transaction으로 한다. dispatcher는 종료 저장 재시도 완료 전 다음 claim 금지. sessionBefore는 bundle version만 비교 | [자체 `claimNextRun`](https://github.com/babo-jeonguk/BaboJUBot/blob/914b31f3e8e7bc8f7da078790df3e33240c3098a/packages/db/src/runs.ts#L66-L159), [dispatcher L188–208](https://github.com/babo-jeonguk/BaboJUBot/blob/914b31f3e8e7bc8f7da078790df3e33240c3098a/apps/server/src/dispatcher.ts#L188-L208), [core L241–284](https://github.com/babo-jeonguk/BaboJUBot/blob/914b31f3e8e7bc8f7da078790df3e33240c3098a/packages/core/src/run.ts#L241-L284) | 소스 확인 |
| <a id="E10"></a>E10 | Event 계약·DB FK는 조직 필수. all 구독도 조직 Event의 묶음이다. web은 ready 때 재조회·event 때 조직별 조회를 갱신한다 | [event L20–25](https://github.com/babo-jeonguk/BaboJUBot/blob/914b31f3e8e7bc8f7da078790df3e33240c3098a/packages/contracts/src/event.ts#L20-L25), [DB L1219–1249](https://github.com/babo-jeonguk/BaboJUBot/blob/914b31f3e8e7bc8f7da078790df3e33240c3098a/packages/db/src/schema.ts#L1219-L1249), [web L25–44](https://github.com/babo-jeonguk/BaboJUBot/blob/914b31f3e8e7bc8f7da078790df3e33240c3098a/apps/web/src/live-events.ts#L25-L44) | 소스 확인 |
| <a id="E11"></a>E11 | SEED QuantityPicker는 safe integer min/max를 요구하고 경계에서 disabled/clamp. ResponsiveDialog는 기본 md 아래 BottomSheet, 이상 Dialog이며 open state를 공통 관리 | [quantity validation L85–115](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react-headless/quantity-picker/src/useQuantityPicker.ts#L85-L115), [경계 L155–191](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react-headless/quantity-picker/src/useQuantityPicker.ts#L155-L191), [ResponsiveDialog L57–122](https://github.com/daangn/seed-design/blob/99efaf5561de6e18557ffeb57fe95428ce066eb3/packages/react/src/components/ResponsiveDialog/ResponsiveDialog.tsx#L57-L122) | 소스 확인 |
| <a id="E12"></a>E12 | React는 제거한 component state를 파기하므로, 닫은 뒤 초안 유지는 부모 등 살아 있는 상태 소유자에게 맡겨야 함 | [Preserving state for removed components](https://react.dev/learn/preserving-and-resetting-state#preserving-state-for-removed-components) | 문서 주장 |
| <a id="E13"></a>E13 | SEED 공개 Select를 열어 옵션·현재 선택 체크를 확인. QuantityPicker에서 증가→감소 후 값1·감소 native disabled=true 확인 | [Select demo](https://seed-design.io/react/components/select), [QuantityPicker demo](https://seed-design.io/react/components/quantity-picker). Playwright 1.58.2/Chromium, 1280×900. cache `captures/seed-select-open.png`, `seed-quantity-min.png`, `captures.md`, 메인 이미지 재열람 | 실행 확인 |

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 연결 identity·실행 설정·모델 catalog를 분리 | E01–E04 | Multica는 기기 runtime, Paperclip은 adapter 종류, AO는 세션 snapshot | 같은 adapter 둘·nullable 기본·변경 이력 표현 가능 | catalog 오류를 기본 모델 변경으로 오해하면 안 됨 |
| <a id="P02"></a>P02 | 실행 시점 snapshot과 세션 identity | E03–E04, E09 | AO는 session 단위, 우리는 오래 사는 agent와 run 분리 | 진행 run과 다음 run의 설정 차이를 보존 | provider A→B→A도 이전 연결 세션이 자동으로 안전해지지 않음 |
| <a id="P03"></a>P03 | 공유 admission guard, 실제 자원 수명 기준 slot | E05–E09 | p-queue는 메모리, BullMQ는 Redis Lua, 우리는 DB wake와 transaction | cap 감소·복구·중복 claim을 같은 경계로 검증 | 취소 race 조기 해제, count/claim 분리 경쟁, 대기 촉진 누락 |
| <a id="P04"></a>P04 | 서버 저장값과 폼 초안을 분리 | E11–E13, #94 화면 패턴 | 컴포넌트 선택 상태와 앱 초안 수명은 별개 | 다른 탭 갱신에도 편집값 보존 | 리페치가 미저장 입력을 덮거나 닫기 unmount가 초안 삭제 |
| <a id="P05"></a>P05 | 영속 변경 기록 후 commit 뒤 갱신 신호 | E09–E10 | 현재는 조직 Event만 정의 | 재연결 재조회로 놓친 갱신 회복 | 전역 변경을 임의 조직에 귀속하면 의미·경계 손상 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | registry key는 이름 붙은 연결 ID, adapter 종류와 분리. agent와 run에는 연결 ID·요청 모델(null 허용) 저장. 같은 fake adapter 두 연결도 가능하게 함 | P01, AC1–3 | 네 provider 종류 enum만으로는 가짜 둘이나 같은 종류 두 연결을 구분 못 함. 외부 runtime/daemon 계층 전체는 도입하지 않음 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | 연결별 catalog는 동적 목록→실패/timeout 시 고정 목록. 화면 첫 옵션 `기본 모델`은 null로 전송. 동적 조회는 모델 추론을 부르지 않음 | E02, AC2–3 | Paperclip empty fallback만 복사하면 throw 경로가 빠짐. model 요청 null을 임의 첫 모델로 바꾸지 않음. 실제 실행 모델을 보고받지 못하면 추정하지 않음 | Q1 |
| <a id="D03"></a>D03 | 채택 | Lead·작업자 기본값은 생성 transaction에서 복사. 기존 agent·run은 전역 변경에 영향 없음. agent 변경은 사용자 API에만 둠 | P01–P02, AC4–6 | 조직 생성과 첫 wake 사이 별도 설정 저장을 두면 첫 run 경쟁. worker 모든 생성 경로에 같은 기본값 적용 | Q2 |
| <a id="D04"></a>D04 | 변형 채택 | admission에서 agent의 연결·모델을 run에 고정, request·run 목록은 이 snapshot 사용. provider 변경 다음 run은 새 세션. 폼 provider 변경 시 `기본 모델`로 초기화 | E03–E04, E09, AC6 | 진행 run을 현재 agent 설정으로 표시하거나 종료 session에 현재 provider를 붙이면 오귀속. #96의 작업별 세션 설계와 연결 ID 검사 정합성 필요 | Q2 |
| <a id="D05"></a>D05 | 변형 채택 | 연결별 전체 조직 running 합계와 agent별 하나를 함께 검사하고 claim과 원자화. cap 도달 시 run/wake 전달 없이 대기. cap 감소는 신규 admission만 제한 | P03, AC7 | 기본2와 최소1을 분리. count 후 무잠금 insert는 배제. provider별 원자 경계를 기존 org→agent→run 잠금 순서와 함께 설계·검증 | Q3 |
| <a id="D06"></a>D06 | 채택 | slot은 provider 정리와 finish commit 뒤 반환. 같은 연결의 다른 agent도 다시 촉진. cap 증가·대기 agent의 provider 변경·서버 복구도 대기 재평가 | E06–E09 | p-queue signal 취소 그대로 연결하면 실제 process 겹침. 종료 저장 실패 시 slot 유지로 가용성보다 기존 불변 조건 우선 | Q3 |
| <a id="D07"></a>D07 | 채택 | 같은 Select 쌍 재사용, 초안과 서버값 분리, dirty일 때 Save, 저장 실패·닫기에도 초안 유지. stepper 최소1·기본2, 좁은 dialog bottom sheet | P04, #94 화면 조건 | 준비 상태 확인 기능·실제 로그인은 #96 이후. 구현이 없는 readiness를 가짜 `준비됨`으로 표시하지 않음 | Q4 |
| <a id="D08"></a>D08 | 보류 — 상충·판단 필요 | 전역 기본값/상한 변경의 영속 기록·전파 범위를 #94에서 명시적으로 정함. 조직 Event에 임의 organizationId나 null을 끼워 넣지 않음 | E10, P05, AC8 | 현재 용어·schema와 AC8의 접합부. 아래 두 안의 비용·기준 문서 개정을 검토 | Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 빈 agent 설정은 전역 기본을 매번 상속 | AO 역할 기본의 실행 시 merge를 그대로 확장 | 기존 agent 유지 AC와 충돌. 생성 복사 후 불변 기본값 연동 해제 |
| unknown 모델 문자열을 provider 변경 뒤 무조건 보존 | Multica E04 | #94는 catalog Select, 화면 규칙은 변경 시 기본 모델. 구 공급자 모델을 보내지 않음 |
| 메모리 큐를 wake 원본으로 교체 / Redis 추가 | p-queue·BullMQ 전체 도입 | 영속 wake·transaction 복구가 이미 있음. 부품은 메커니즘 참고이지 새 저장 엔진 채택 근거 아님 |
| abort promise가 끝나면 slot 반환 | p-queue E06–E07 | 실제 cleanup 전 동시 작업 겹침 재현 |
| cap 감소 시 진행 run 강제 취소 / 다른 provider 자동 대체 | 대안 설계 | #94 AC 및 #91 사용자 선택과 충돌 |
| 모든 조직에 같은 설정 Event 복제 / 임의 조직에 전역 변경 귀속 | AC8의 단순 우회 | 조직이 0개일 때 기록 불가능·조직 기록 의미 왜곡·공유 경계 혼동 |

## 구현 참고

권고 요약: 연결 registry → 생성 복사 → admission snapshot → 원자 cap 검사 → provider 실행 → 정리·종료 저장 → 같은 연결 대기 촉진. 설정 화면의 서버값·초안·run 이력은 서로 다른 시점의 값이다.

책임은 [전체 구조](../architecture.md)를 따른다. `contracts`는 연결/모델 목록·설정·run snapshot 입출력, `core`는 순수 기본값·변경·세션/상한 판정, `db`는 backfill·영속 설정·admission 원자성, `runtime`은 adapter와 catalog, `server`는 registry 주입·dispatch/commit 뒤 촉진, `web`은 같은 contracts로 폼과 실시간 갱신을 담당한다. 외부 SDK를 core로 끌어오지 않는다. 구체 진입점은 [실행 코드 지도](../agents/code-map/runs-and-conversations.md), [복구 코드 지도](../agents/code-map/heartbeat-and-recovery.md), [공통 commit 경로](../agents/code-map/shared-path.md)를 따른다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 같은 fake adapter를 두 이름으로 등록 → Lead/worker 생성·실행 → 각 연결로만 호출·모델 null 그대로 전달, 기존 agent는 fake backfill | D01–D03 |
| V02 | 전역 기본 변경 → 기존 agent/새 Lead/초기 승인·정책 off 추가 worker 생성 → 기존 유지·새 값 복사, 첫 wake부터 선택 연결 사용 | D03 |
| V03 | A 실행 중 agent를 B/model 변경 → A 종료·새 wake → A 이력/세션은 A 귀속, 다음 B 새 세션, 조직 기록 유지. agent 조직 도구로 변경은 거부 | D04 |
| V04 | 모델 목록 성공·empty·throw·timeout → Select 조회 → 유효 목록 또는 정적 fallback, 첫 `기본 모델`; provider 바꾸면 이전 모델 제거 | D02,D07 |
| V05 | 서로 다른 조직 agent가 같은 연결에 동시에 claim → cap=1 → 하나만 시작·다른 wake 미전달. 다른 연결은 독립 시작; 같은 agent는 여전히 하나 | D05 |
| V06 | cap2의 두 run 진행·세 번째 대기 → cap1 → 기존 유지·active가 1이면 계속 대기·0이 되면 하나 시작. cap0은 거부, cap 증가 뒤 즉시 대기 촉진 | D05–D06 |
| V07 | 취소 후 cleanup 지연·finish 저장 실패 → 같은 연결 대기 → 정리·finish commit 전 신규 시작 없음. 종료·provider 변경 시 다른 대기 agent도 시작 | D06 |
| V08 | cap 대기/실행 중 서버 SIGKILL → 재시작 → 기존 복구 완료 뒤 cap 안에서 wake 재전달, 중복 실행·slot 누수 없음. 최종 완료/일시정지는 admission 거부 | D05–D06, E09 |
| V09 | 두 탭에서 설정 저장 → 다른 탭 재조회 → 저장값·목록 갱신, 편집 중 초안 보존; 연결 끊김 뒤 ready 재조회로 수렴 | D07–D08 |
| V10 | 조직 만들기 입력 후 닫기/재열기·390px, 설정 저장 실패, stepper 최소 경계 → 초안 보존·bottom sheet·감소 비활성; 판1 서버·데모 E2E 유지 | D07, #94 AC9–10 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 전역 변경을 Event에 남기는 계약 충돌 | #94 (제품 의미 변경 시 사용자) | A: 조직 Event는 유지하고 별도 전역 설정 감사 기록·갱신 frame을 추가(권고). AC8의 “Event” 범위를 이슈에서 명확히 해야 함. B: Event를 조직/전역 scope union으로 확장하고 GLOSSARY·architecture·DB·stream을 함께 개정. 단일 stream이 쉽지만 기존 조직 귀속 정의 변경. 어느 안도 이번 조사에서 확정하지 않음 |
| catalog가 빈 배열을 반환한 의미 | #94 | 빈 성공도 고정 fallback으로 취급(권고, E02) 또는 정상 빈 목록으로 인정하고 `기본 모델`만 제공. 일시 오류와 실제 모델 0개의 의미를 계약으로 구분 |
| cap 최대값·공정성 | #94 | 최소1/기본2 외 상한은 AC에 없음. 임의 UX 최대값을 만들지 말고 표현 범위를 정한 뒤 경계 버튼 규칙 적용. 우선 기존 wake 순서, 조직별 공정 배분은 요구 발생 때 별도 논의 |

후속 #95: Lead 제안·승인 override·제안/결정 보존. #96: capability·준비 상태·(agent,task) 세션. #98/#100/#101: 실제 adapter와 catalog 구현. #102: OS 격리. 조직별 기억 엔진·예산은 판4이며 이번 조사에서 채택하지 않는다.

## 한계와 미확인

- 위 검증 표는 구현 시 확인할 항목이다. 이번에 제품 서버 검사·E2E를 실행하거나 #94를 구현한 것이 아니다.
- p-queue probe 네 장면만 실행했다. upstream 전체 suite·BullMQ Redis 실행/복구·agent OSS Go 실행은 하지 않았다. Go 도구가 없으며 실제 provider·모델은 전혀 호출하지 않았다.
- BullMQ TS backend→Redis adapter 전체 경로를 추적하지 않았다. 원자 Lua 패턴만 확인했으며 Redis 도입 권고가 아니다. 과거 `getTargetQueueList.lua` 경로 404는 근거에서 제외했다.
- 운영 실패 보고·문서 그림은 런타임 재현/실화면 근거로 승격하지 않았다. Q5에 직접 맞는 “조직 Event 불변 + 전역 설정 Event” 외부 사례는 이번 조사 범위에서 찾지 못해 현재 계약 근거로 열린 결정으로 남겼다.
- 실제 provider 모델 목록 호출의 비용·timeout·유효 모델은 각 adapter 후속에서 확인해야 한다. UI에서 `기본 모델`이라고 보여도 요청 null과 실제 선택 모델은 다르다.
- 설계만 참고했으며 제품 코드 복사 없음. 코드 재사용 시 해당 SHA의 root LICENSE·파일 header·NOTICE·전이 의존성을 별도로 확인해야 한다. 특히 Multica는 Apache-2.0에 추가 조건이 있는 Multica License다.
- 공개 Select/stepper 관찰은 agent 설정 전체의 저장·종속 선택·오류/로딩/권한·닫기 후 초안 보존을 검증한 것이 아니다. 해당 상태는 미확인이다. 제3자 화면 캡처는 cache에만 보관하며 저장소·Issue에 게시하지 않는다.

## 조사 완료 기록

[Issue receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/94#issuecomment-6520778150)를 게시하고 재조회해 권고·열린 결정과 일치함을 확인했다. 문서는 구현 변경과 함께 커밋하도록 미커밋 상태로 남겼다. `node scripts/check-project.mjs`(Node 24.21.0)로 Markdown 88개 로컬 링크 검사, `git diff --check` 통과. `pnpm check`는 로컬 pnpm이 Node 20.11.1로 실행되어 engine 검사에서 막혔고, 같은 check 스크립트를 Node 24로 직접 실행했다. 제품 검사는 실행하지 않았다.
