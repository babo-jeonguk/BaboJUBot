# issue-143 레퍼런스 조사: 웹·채널 사용자 행동 조립과 모델 선택 검증

현재 계약은 [#143 본문](https://github.com/babo-jeonguk/BaboJUBot/issues/143), 책임은 [전체 구조](../architecture.md), 용어는 [GLOSSARY](../../GLOSSARY.md)가 기준이다. 이 문서는 구현 전 조사·권고이며 구현 완료 보고가 아니다.

최초 조사: 2026-11-10(`c88a98b58284a38bdadf7eff7aafa0219005371c`). 재확인: 2026-11-12. fetch한 최신 main과 작업 HEAD는 모두 `983dbc5a4e9342c460f081a4888250e6634522c6`. 현재 이슈 본문과 대조했다. 제품 코드·테스트·설정 변경, 커밋, 실제 모델 호출은 없다. 기존 [receipt 댓글](https://github.com/babo-jeonguk/BaboJUBot/issues/143#issuecomment-6765234210)을 갱신하는 기록이다.

## Brief

- 문제: 사용자 메시지·승인 결정·결과 검토의 실행 조립을 한 곳으로 모아 웹·채널 선택 검증 차이와 commit 뒤 효과 중복을 막는다.
- 동종 메커니즘: 여러 입력 adapter → 공통 행동 조립 → 기존 도메인/DB → commit별 후처리 → 처리된 Outcome.
- 확정 철학: 같은 사용자 행동은 웹·채널에서 같은 규칙과 효과를 가지며, 저장 전후의 안전한 순서는 한 module이 책임진다. 세 행동에 한정한다.
- 고정 범위: app은 생성·주입·연결, adapter는 파싱·대상 식별·응답 변환, 사용자 행동은 모델 목록 조회·기존 도메인/DB 호출·후처리 순서. pending·조직 잠금·선택/정책 판정·단계·저장은 core/DB에 남긴다. 승인 종류별·결과 transaction을 합치지 않는다.
- ADR-0002·0005, 초기 승인·최종 완료·조직 경계를 유지한다. 새 bus/workflow/outbox/exactly-once/전역 dedup/복구 실행기를 만들지 않는다. #142·#144~#146을 blocker로 추가하지 않는다. PR #160·#164의 현재 동작과 #170의 기존 환경 명세를 보존한다.

| ID | 조사 질문·출처 | 전략 | 기존 근거 재사용 판단 / 부족분 |
|---|---|---|---|
| Q1 | #143 Implementation Decisions: 목록 조회·도메인 판단·응답 변환 책임 | Source Recon + adversarial scenario | Zulip의 공통 서비스 경계, 내부 승인/core·registry 재사용. app 변경과 현행 채널 누락을 재독(N01). 기존 HTTP 실행을 신규 결과로 세지 않음 |
| Q2 | #143 AfterCommit 단일 적용·대상별 실패 격리·첫 조회 대기 | Source Recon + runtime/failure | Sequelize의 소유권만 재사용. 과거 E03의 실패 의미와 “후속 #141 개선” 권고는 폐기. 최신 AfterCommit/dispatcher 재독(N02/N03), #141 Django robust 원문을 보충(N06) |
| Q3 | #143 두 commit 순서·수락 steer 첫 복구·웹/채널 동등성 | Source Recon + persistence/recovery | LangGraph의 대응 입력/상태 검사 방식만 재사용. 최신 메시지·재대기·시작 장벽과 기존 회귀검사로 부족분 보강(N04/N05/N07). 전체 replay는 배제 |

| 기존 조사 | 재사용 범위와 제외 범위 |
|---|---|
| [#60](issue-60-references.md#결정-권고) | 영속 깨우기와 촉진 구별만 재사용. 과거 외부 실행 결과는 현재 증거에서 제외 |
| [상호작용](agent-interaction-models.md#3-사용자-개입) | queue/interrupt/steer 개념만 재사용. 현재 순서·복구 증거는 N04/N05로 교체 |
| [#61](issue-61-references.md#구현-참고) | 조직·원본·대화 식별 경계 재사용. HTTP 자기 호출 권고는 배제 |
| [#54](issue-54-references.md#결정-권고) | 단일 결정·조직 경계 원칙 재사용. 현행 DB/core blob 동일 확인 |
| [#141](issue-141-references.md) | Django robust의 효과별 실패 격리·진단 실패 반례만 원문 재독. 과거 probe 결과는 새 실행으로 계상하지 않음. 실패 격리는 이제 현행 AfterCommit의 보존 계약 |

### 파일별 재사용 판정

이전 내부 SHA와 최신 main의 각 파일 blob을 비교했다. 아래 “동일”은 파일 내용 동일이며 과거 실행 결과의 재실행을 뜻하지 않는다. 변경 파일은 결정에 쓰는 함수·검사를 최신 SHA로 다시 읽었다.

| 파일 | 이전 blob → 현재 blob | 판정 |
|---|---|---|
| `apps/server/src/app.ts` | `1b283efd9231c5e5348931d22175bd37145f5af1` → `f999bcebf511281373cf47bba13e64f06f398270` | 변경·재독 |
| `apps/server/src/channel-replies.ts` | `600f2e4a3e551cdb167b5f536f1d886d4a026cea` → `600f2e4a3e551cdb167b5f536f1d886d4a026cea` | 동일 |
| `apps/server/src/providers.ts` | `54effcfcfe656fdbb28390587ee6870186323d34` → `54effcfcfe656fdbb28390587ee6870186323d34` | 동일 |
| `apps/server/src/after-commit.ts` | `564df314035ecdf9a1bf24de2aa2c87f088ff7e5` → `9456c4b292559ef8d37e273d62a47d3e60030fa0` | 변경·재독 |
| `apps/server/src/dispatcher.ts` | `9ed3bf232ab6baca843b75d13bca1e9be265fb64` → `e65d1f146d9d81b33b4d5c194bd2abe2df9ecd83` | 변경·재독 |
| `packages/db/src/approvals.ts` | `6fd9931b78c25fdc13ed8432c5f0ae540e2bae67` → `6fd9931b78c25fdc13ed8432c5f0ae540e2bae67` | 동일 |
| `packages/core/src/approval.ts` | `76b64064ae64b7ced50feb90e8cc44195947e2de` → `76b64064ae64b7ced50feb90e8cc44195947e2de` | 동일 |
| `packages/db/src/conversations.ts` | `3035f7068c9f93c57a88b7381e2c754467d68ec1` → `9c2dfaa185491d162aeef0684da153fb0fd02c6f` | 변경·재독 |
| `packages/db/src/runs.ts` | `1553c0ff1c2d4e99aeeeb881bc73ca273ea921d0` → `0712b16ecebdb390b534549f103c01088e4900fb` | 변경·재독 |
| `packages/db/src/results.ts` | `eb43b958755e14b1edf8b544090bb93b614ef141` → `eb43b958755e14b1edf8b544090bb93b614ef141` | 동일 |

## 레퍼런스

기존 Discovery는 고유 후보 15종(2026-11-10)의 3관점·각 3라운드였다. 이번에는 확정 결정을 다시 탐색하지 않고 그 후보·고정 원문의 유효성과 최신 제품의 부족분만 대조했다. 이전 saturation은 당시 탐색의 기록이다. 현재 upstream 전체나 최신 버전 탐색을 새로 완료했다는 뜻이 아니다.

| 관점 | 이번 보충과 종료 근거 |
|---|---|
| 공통 행동/adapter | Zulip 공통 helper 원문 재독, 동일한 core/DB·registry와 변경된 app 대조. 기존 분리 패턴으로 Q1에 충분하여 후보 확장 없음 |
| commit 후 소유권 | Sequelize managed owner 유지, 기존 후보 Django robust 원문 추가 대조. 실패 격리는 최신 제품이 이미 담당하므로 새 hook 체계 선정 불필요 |
| 두 단계/복구 검사 | LangGraph interrupt 원문과 기존 BaboJUBot 복구 검사 대조. 정확한 두 commit·steer 조립은 외부 자료에서 확인하지 못했으므로 제품 자체의 소스·회귀검사가 직접 근거 |

| 대상 | 고정 SHA·버전 | 라이선스 | 깊이·실행 경로 / 한계 |
|---|---|---|---|
| BaboJUBot | `983dbc5a4e9342c460f081a4888250e6634522c6` | MIT | 소스+기존 검사 실행, 임시 PG·가짜 runtime. 새 공통 행동 구현은 없음 |
| Zulip | `366c9ba5dbf691bce76f87d27da9d1917bd711e2` | Apache-2.0 | 고정 snapshot 공통 helper 재독. self-host Django/PG/큐 경로, 미실행 |
| Sequelize | `53d1e8a6199fff85a8d6cd7d9bf0f3487f0cf798` | MIT | managed wrapper snapshot 재독. Node+SQLite 검사 경로, 미실행.v7 개발 소스이며 v6 계약으로 일반화 안 함 |
| LangGraph | `e5e37b5d70dbfd93c7006bd90a658c6179a95946` | MIT | 고정 checkout interrupt 재독. 모델 없는 InMemorySaver 경로, 미실행 |
| Django | `47fe39af56ecd0ad73b9c7562511015e96b91b80` (5.2.8) | BSD-3-Clause | 고정 checkout robust·검사 재독. SQLite self-host 경로, 이번 미실행 |

외부 고정 SHA를 새 ref로 이동하지 않았다. root LICENSE 확인은 기존 기록을 재사용하며 설계 참고만 한다. 소스 복사·새 의존성 채택 권고는 없다.

## 근거

N01–N07은 2026-11-12 확인이다. 소스·검사 읽기는 실행과 구분한다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="N01"></a>N01 | 웹은 modelsFor 후 DB/complete, 채널은 목록 없이 DB/complete. registry는 요청된 연결 목록을 모으며 unknown 연결은 생략한다. DB가 조직 잠금·pending 우선 확인 후 core 판정을 호출하고 core는 제안과 다른 선택만 목록으로 검증한다 | [웹 승인](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/app.ts#L1172-L1194), [채널](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/channel-replies.ts#L92-L104), [modelsFor](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/providers.ts#L83-L100), [decideApproval](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/approvals.ts#L159-L211), [선택 판단](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/core/src/approval.ts#L293-L315) | 소스 확인 |
| <a id="N02"></a>N02 | ensureWorkspace(조직별) → Event/settings → 취소 → 조직 촉진 → 개별 촉진 → 연결 촉진. 효과별 bestEffort, workspace/개별/연결 반복 대상별 catch, 진단도 catch. completeStored는 거부 효과0·성공 Outcome 반환. 원 Stored 재호출 guard는 없으므로 호출 소유권이 필요 | [applyAfterCommit·bestEffort·completeStored](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/after-commit.ts#L24-L114) | 소스 확인 |
| <a id="N03"></a>N03 | kickOrganization/kickProvider는 첫 대기 목록 조회와 kick 시작까지만 await. 조회 실패는 진단 후 background retry. kick은 void이며 pump 완료를 await하지 않는다. start는 복구 저장 완료 뒤 공통 AfterCommit을 적용하고 대기 목록을 다시 읽는다 | [start·kick](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/dispatcher.ts#L134-L158), [kickWaiting](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/dispatcher.ts#L191-L224) | 소스 확인 |
| <a id="N04"></a>N04 | 메시지 저장 complete 후 steer, 그 결과 settleSteer 저장 complete. 수락은 wake를 기존 run과 runWakes에 묶고 전달 위치를 남김. 거절은 next_run·message.steered(queued)·촉진. 두 complete는 서로 다른 commit이다 | [메시지 조립](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/app.ts#L341-L391), [settleSteer](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/conversations.ts#L337-L412) | 소스 확인 |
| <a id="N05"></a>N05 | 미수락 steer 복구는 run 미배정 wake만 next_run으로. 수락된 메시지는 interruptRun → requeueWakes → markRequeued가 첫 복구 transaction 안에서 next_run·전달 위치 초기화. recoverInterruptedRuns는 running만 처리하고 효과를 모아 반환. 사용자 취소 여부는 core가 판정하며 사용자 행동 모듈의 복구 책임이 아님 | [미정 steer 복구](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/conversations.ts#L415-L434), [markRequeued](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/conversations.ts#L519-L535), [interruptRun·requeueWakes](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/runs.ts#L325-L382), [복구 집계](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/runs.ts#L433-L467), [planRunInterruption](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/core/src/run.ts#L448-L497) | 소스 확인 |
| <a id="N06"></a>N06 | Django는 callback 목록을 먼저 비운 뒤 순서대로 실행, robust=True면 예외를 기록하고 다음 callback 진행. 단 진단 중 callback 메타데이터 접근 오류는 catch 밖으로 나갈 수 있음. 제품의 report 보호를 없앨 근거가 아님 | [run_and_clear_commit_hooks](https://github.com/django/django/blob/47fe39af56ecd0ad73b9c7562511015e96b91b80/django/db/backends/base/base.py#L752-L769), [robust 검사](https://github.com/django/django/blob/47fe39af56ecd0ad73b9c7562511015e96b91b80/tests/transaction_hooks/tests.py#L66-L101), [#141](issue-141-references.md) | 소스 확인(외부 검사 미실행) |
| <a id="N07"></a>N07 | 현행 기존 검사 실행: AfterCommit 13개 + 첫 재시작 accepted steer 서버 1개, DB steering 8개 통과. 서버 검사는 정상 종료 후 첫 재시작, DB 검사는 running으로 남긴 상태·반복 복구·사용자 취소·pause/resume을 포함 | [AfterCommit 검사](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/src/after-commit.test.ts#L39-L215), [서버 첫 복구 검사](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/apps/server/test/recovery.test.ts#L287-L381), [DB 복구 검사](https://github.com/babo-jeonguk/BaboJUBot/blob/983dbc5a4e9342c460f081a4888250e6634522c6/packages/db/src/queued-messages.test.ts#L256-L390), 아래 실행 기록 | 실행 확인(22개, 선택 필터 밖 22개 미실행) |

### 재사용한 외부 원문

| 기존 ID | 현재 사용하는 사실·원문 | 재사용 한계 |
|---|---|---|
| <a id="E06"></a>E06 | Zulip의 서로 다른 addressee wrapper가 같은 check_message→do_send_messages를 호출. [공통 helper](https://github.com/zulip/zulip/blob/366c9ba5dbf691bce76f87d27da9d1917bd711e2/zerver/actions/message_send.py#L1579-L1664) 재독 | 소스 확인. webhook의 일부 예외→None 정책은 웹/채널 같은 거부 의미 계약과 달라 배제 |
| <a id="E09"></a>E09 | Sequelize는 자신이 만든 transaction만 commit하고 완료 뒤 결과 반환. [wrappedCallback](https://github.com/sequelize/sequelize/blob/53d1e8a6199fff85a8d6cd7d9bf0f3487f0cf798/packages/core/src/sequelize-typescript.ts#L975-L1000) 재독 | 소스 확인. DB commit 관리 사례이며 외부 효과 영속 exactly-once 근거 아님. hook 오류를 저장 실패처럼 전파하는 패턴은 배제 |
| <a id="E11"></a>E11 | LangGraph는 interrupt index로 재개 값을 소비하거나 GraphInterrupt 발생. [interrupt](https://github.com/langchain-ai/langgraph/blob/e5e37b5d70dbfd93c7006bd90a658c6179a95946/libs/langgraph/langgraph/types.py#L1018-L1059) 재독 | 소스 확인. 대응 입력/최종 상태 검사 아이디어만 재사용. replay를 제품 메시지 조립에 이식하지 않음 |

### 과거 실행 기록 — 신규 결과 아님

- <a id="E04"></a>E04: 2026-11-10, 내부 `c88a98b…`, Node 24.21.0·가짜 모델 목록·임시 PG: 변경 선택은 웹200/작업자2, 채널422 unknown_provider/작업자0. 선택 생략 성공, 결정 뒤 잘못된 선택은 already_decided. 이번에는 HTTP parity probe를 다시 실행하지 않았다. 현재 차이의 근거는 N01의 소스다.
- <a id="E05"></a>E05: 같은 과거 SHA의 raw Stored를 completeStored에 두 번 넣으면 Event/kick 두 번. 이번에 중복 probe를 재실행하지 않았다. 현행 guard 부재는 N02에서 정적으로 확인했다.
- 과거 “효과 실패 격리는 후속 #141” 권고와 과거 AfterCommit 실패 전파 설명은 현행 권고에서 제외한다. 현재는 N02/N03 계약을 그대로 보존한다.

## 패턴

| ID | 패턴 | 근거 | 이점·실패 모드 |
|---|---|---|---|
| P01 | transport 변환 → 공통 행동 → 도메인/저장 | N01/E06 | 목록 전달 누락 방지. adapter가 도메인 거부를 성공으로 바꾸면 다시 불일치 |
| P02 | commit별 소유자 하나, 완료 값만 반환 | N02/E09 | adapter 재후처리 경로 제거. crash·응답 유실의 전역 전달 보장은 아님 |
| P03 | 독립 효과별 실패 격리와 제한된 대기 | N02/N03/N06 | 저장 성공과 후처리 진단 분리. drain/실행 종료를 await하면 자기 종료 처리가 교착할 수 있음 |
| P04 | 단계별 commit·외부 호출 경계 보존, 기존 복구 재사용 | N04/N05/E11 | 거절 queue·첫 복구 재대기 보존. 두 commit 합치기·전체 자동 replay는 중복/효과 누락 위험 |

## 결정 권고

아래는 현재 본문을 보존하는 구현 참고다. 확정 철학·범위를 재결정하지 않는다. 확정 계약 간 충돌은 이번 대조에서 발견하지 못했다.

| ID | 권고 | 내용·이유 | 근거 | 질문 |
|---|---|---|---|---|
| D01 | 변형 채택 | 행동 모듈이 registry 목록 조회 → 기존 DB/core → complete 순서를 소유. 목록은 잠금 밖에서 받고 adapter에 검증을 복제하지 않음. DB pending 우선·종류/단계/정책 판단은 그대로 | P01/N01 | Q1,Q3 |
| D02 | 채택 | 각 commit의 Stored를 행동 모듈이 한 번 complete하고 Outcome만 반환. adapter 직접 publish/cancel/kick·재complete 제거. 종료/시작 복구도 기존 실행기를 재사용하며 전역 guard 추가 없음 | P02/N02/N03 | Q1,Q2 |
| D03 | 채택 | 저장→complete→steer→settle 저장→complete 직렬 유지. 복구는 기존 DB/dispatcher에 남겨 첫 재시작의 재대기·반복 복구 무증가 보존 | P04/N04/N05/N07 | Q2,Q3 |
| D04 | 변형 채택 | 동일 의미 입력을 웹/채널에 넣고 영속 결과·거부 이유·Event/wake·효과 횟수/순서 비교. ID/시간 정규화와 별개로 조직·원본·대화 귀속 검증 | P01/P04/N01/N07 | Q1,Q3 |
| D05 | 채택 | 현재 AfterCommit 순서·효과/대상별 실패 진단과 계속 진행·저장 성공·첫 조회 대기만 보존. 초기 승인·작업자 추가·결과 transaction과 pause 의미 유지 | P03/N02/N03/N06 | Q1,Q2,Q3 |
| D06 | 배제 | bus/workflow/outbox·exactly-once·전체 retry·전역 dedup·새 복구·환경 점검기/schema/차단 추가. 기존 환경 문자열·snapshot 그대로 전달 | #143 범위·P02/P04 | Q1,Q2,Q3 |

## 구현 참고

`apps/server/src/app.ts`의 세 행동 조립을 추출하고 의존성 생성·주입·adapter 연결을 남긴다. `channel-replies.ts`는 알림의 조직·원본·대화 식별과 입력/응답 변환을 소유한다. core/DB는 server·transport를 import하지 않는다. 새 모듈 이름·주입 형태의 owner는 #143 구현자이며 사용자 제품 정책의 열린 결정은 없다.

### 보존을 확인할 방법 — 향후 구현 검증

다음 V01–V10은 구현 후 완료 조건이다. N07 일부 통과를 웹·채널 통합 완료로 해석하지 않는다.

| ID | 관찰 경계·기대 | 기존 자산 / 부족분 |
|---|---|---|
| V01 | 변경 유효 선택·생략·제안 유지 → 웹/채널 → 같은 팀 연결/모델·단계·결정 Event·wake | notifications.test.ts의 선택 없는 비교 + providers.test.ts. 변경 선택 parity 추가 필요 |
| V02 | unknown provider/model·선택 수 불일치 → 같은 거부 의미·추가 효과0. 결정 뒤 목록 변경/invalid 선택 → already_decided 우선 | approvals/providers 검사 + N01. 목록 조회 실패 자체를 도메인 선택 거부와 혼동하지 않음; 새 실패 정책 도입 없음 |
| V03 | 동시 상반 승인·작업자 추가·결과 결정 → 승자 하나·패자 already_decided·추가 작업자/Event/wake 없음 | approvals/results 검사와 웹·채널 경합 보강 |
| V04 | 초기 승인 pause 해제/stopped 거부, 작업자 추가 pause 유지, 결과 재개/최종 완료/stopped 거부 | approvals/results/control 검사. transaction 종류를 묶지 않음 |
| V05 | 채널 원래 대화 연결·잘못된 조직/원본/없는 알림 거부, 초기 승인 전 연구·도구 최종 완료·교차 조직 쓰기 금지 | notifications/conversations 및 기존 권한 검사. 귀속은 정규화해 지우지 않음 |
| V06 | queue/interrupt/steer accepted/rejected → 원본 메시지와 첫 Event commit 확인 → 첫 후처리 → fake steer gate → settle commit/message.steered → 두 번째 후처리 → 응답 | control/conversations 및 AfterCommit 전용 대역 재사용. gate가 막힌 동안 DB에 첫 저장은 보이고 settle은 없어야 함. rejected는 next_run/wake, accepted는 run_wakes/전달 위치 확인. 새 tx로 전체를 감싸지 않음 |
| V07 | commit별 Event ID·취소 run ID·촉진 대상 기록을 비교해 각 commit 효과만 한 번 적용. 거부는 효과0, 두 commit은 별도로 집계 | 기존 AfterCommit 대역 + 실제 API·채널 경계. 중복 호출 자체를 제품 전역 dedup으로 숨기지 않음 |
| V08 | workspace/발행/설정/취소/조직·개별·연결 촉진 중 한 효과 또는 대상의 동기 throw/비동기 reject → 저장 Outcome 성공·다음 대상/효과 순서 유지·진단 실패도 격리 | after-commit.test.ts의 13개 유지. 둘 이상 workspace/개별/연결 중 앞 대상 실패, 뒤 대상 호출을 확인. 실제 void 효과에 가짜 Promise 반환 계약을 새로 만들지 않음 |
| V09 | 조직·연결 목록 조회 gate를 막으면 다음 단계/응답 대기, 조회를 풀고 fake 실행은 계속 막아도 응답 완료. 조회 실패 후 background retry, 종료 경로의 providersFreed도 자기 실행 종료를 기다리지 않음 | dispatcher #kickWaiting·기존 촉진 검사. drain은 응답 뒤 검증에만 사용. AfterCommit 대역의 Promise 해제를 실행 시도 완료로 해석하지 않음 |
| V10 | accepted steer → 첫 재시작 → next_run·전달 위치 초기화·다음 실행 수신. 반복 복구는 메시지/wake 증가0, 이전/새 run_wakes 보존. 정상 완료는 재전달 안 함, 사용자 취소 먼저면 재대기 안 함, 일시정지는 대기 후 재개 | recovery.test.ts와 queued-messages.test.ts의 N07 유지. 실제 시작 순서와 running 잔존 DB 복구 모두 검증. 웹/채널 공통 행동 추출 뒤 재실행하고 복구 AfterCommit을 adapter에서 다시 적용하지 않음 |

환경 명세는 기존 `approvals.test.ts`의 proposal.environment·snapshot 확인을 양쪽 승인 결과로 확장한다. 점검 기록 문자열까지 동일하게 보존하는지 확인하되 제품 점검기·새 필드·누락에 따른 승인 거부를 추가하지 않는다(#170·#143).

## 실행 기록과 한계

2026-11-12, 위 main SHA·제품 코드/테스트/의존성 변경 없음. Node 24.21.0, Vitest 5.0.5. 키 없는 셸(`env -i HOME="$HOME" PATH="$PATH"`)·기존 가짜 runtime·임시 Postgres로 아래 기존 검사만 실행했다.

| 명령 | 신규 결과 |
|---|---|
| `pnpm --filter @babojubot/server exec vitest run src/after-commit.test.ts test/recovery.test.ts -t 'applyAfterCommit|completeStored|accepted steer across a restart'` | exit 0, 14 passed / 11 skipped |
| `pnpm --filter @babojubot/db exec vitest run src/queued-messages.test.ts -t 'steering into the running run'` | exit 0, 8 passed / 11 skipped |

AfterCommit 검사 출력에는 의도된 실패 주입 진단 외에 `pending.catch is not a function`도 있었다. 기존 대역이 `calls.push`의 숫자를 void 효과 반환처럼 넘겨 bestEffort가 이를 잡아 진단한 것이다. 실제 hub/dispatcher의 void 계약과 구분하며, 13개 통과만으로 진단의 정확성·모든 비동기 실패 조합을 검증했다고 주장하지 않는다. 제품/대역 수정은 수행하지 않았다.

- 신규 공통 행동 구현·웹/채널 변경 선택 parity·전체 승인/결과/조직 분리 suite·모든 효과 실패 조합·첫 조회 gate/종료 자기 대기 검사는 이번에 실행하지 않았다. V01–V10은 향후 검증 방법이다.
- 외부 OSS·실제 채널 self-host, 실제 모델·계정·유료 API·연구 데이터는 사용하지 않았다. 고정 원문의 패턴만 재사용하며 최신 upstream 보장으로 일반화하지 않는다.
- 첫 재시작 서버 검사는 정상 종료를 이용한다. DB 검사는 crash처럼 running으로 남은 상태를 다룬다. 이번에 accepted steer 직후 프로세스를 강제 종료하는 신규 end-to-end 검사는 하지 않았다.
- 재시작 전 수락된 메시지를 새 실행으로 다시 보내는 기존 의미를 유지한다. 재시작 전후 총 한 번 전달한다는 보장은 없으며, commit 직후 crash 때 비영속 알림·촉진 유실도 기존 한계다.
- 최종 검사 결과는 receipt에 기록한다. 문서는 미커밋으로 두어 이후 구현 변경과 함께 커밋한다. 다른 이슈의 기존 미커밋 문서는 수정하지 않는다.
