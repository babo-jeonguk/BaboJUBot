# issue-143 레퍼런스 조사: 웹·채널 사용자 행동 조립과 모델 선택 검증

#143의 사용자 메시지·승인 결정·결과 검토 조립 경계를 조사한다. 확정 범위는 [#143](https://github.com/babo-jeonguk/BaboJUBot/issues/143), 제품 책임은 [전체 구조](../architecture.md), 용어는 [GLOSSARY](../../GLOSSARY.md)가 기준이다.

조사일: 2026-11-10. 구현 전 기술 권고이며 확정 계약이나 구현 완료 보고가 아니다. 상세 후보·원문·probe는 git 무시 조사 캐시에 보관한다. 제품 코드·테스트·설정은 변경하지 않았고 이 문서는 구현 변경과 함께 커밋하도록 미커밋으로 둔다.

[이슈 receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/143#issuecomment-6765234210)를 게시하고 결정 표와 일치함을 재열람했다.

## Brief

- 구현할 문제: 웹과 채널에 분산된 세 사용자 행동의 모델 목록 조회·도메인/DB 호출·저장 후 처리를 공통 모듈로 모아 선택 검증의 차이와 후처리 이중 적용을 막는다.
- 동종 문제: 여러 입력 adapter가 하나의 사용자 행동 조립을 호출하고, 각 commit 후 효과를 완료한 결과만 받는 메커니즘.
- 고정된 결정: 사용자 확정 후보 B, 세 행동만 통합. app은 의존성 생성·주입, adapter는 파싱·대상 식별·응답 변환, 사용자 행동 모듈은 모델 목록 조회·기존 도메인/DB 호출·후처리 순서와 Outcome을 소유한다. 승인 종류별/결과 transaction은 분리하며 pending·조직 잠금·선택 검증·일시정지 의미는 core/DB에 남긴다. ADR-0002·0005와 초기 승인·최종 완료·조직 경계를 유지한다. 새 명령 버스·workflow engine·outbox·exactly-once·AfterCommit 재설계는 제외한다.
- 이슈 관계: 댓글 없음, blocker 목록 비어 있음, parent 조회는 404(No parent issue found). #141은 참고 대상이며 구현 blocker가 아니다. 현행 기준 SHA: `c88a98b58284a38bdadf7eff7aafa0219005371c`.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 여러 adapter의 입력 파싱·대상 식별·모델 조회·도메인 판단·응답 변환 책임을 어떻게 나누는가? | #143 구현 전 조사 1, Implementation Decisions | Source Recon + adversarial scenario |
| Q2 | 각 commit 결과를 한 곳에서 처리하며 Event·취소·촉진의 이중 적용을 피하는 인터페이스와 검증은? | #143 구현 전 조사 2, 각 commit 한 번 처리 | Source Recon + runtime/failure + 원본 함수 probe |
| Q3 | 두 commit과 외부 steer 순서 및 선택·중복·일시정지의 웹/채널 동등성을 어떻게 검증하는가? | #143 구현 전 조사 3, Testing Decisions | Source Recon + Behavioral Recon + persistence/recovery |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [영속 기록·깨우기 #60](issue-60-references.md#결정-권고) | 저장된 wake와 실행 촉진의 구별 | 과거 외부 SHA/실행을 재사용하지 않고 현행 Stored·app·승인 DB를 재독(E01–E03) |
| [상호작용](agent-interaction-models.md#3-사용자-개입) | queue/interrupt/steer 후보·의미 | Paperclip 과거 소스는 새 근거로 세지 않음. 현재 메시지 closure가 순서의 기준(E03) |
| [알림 채널 #61](issue-61-references.md#구현-참고) | 알림의 조직·원본·대화 식별과 adapter 경계 | 현행 channel-replies·notifications API 검사를 다시 읽음. 과거 HTTP 명령 재호출 권고는 #143의 in-process 호출 결정으로 대체 |
| [초기 승인 #54](issue-54-references.md#결정-권고) | 단일 확정·조직 경계·원자적 팀 생성 | 현행 approvals.ts 잠금·pending 우선순위 재독, 이번 probe로 already_decided 우선 확인(E02/E04) |
| #141 조사 | 기존 Stored/AfterCommit 책임과 실패 격리 공백 | `docs/research/issue-141-references.md` E05의 after-commit.ts는 현행과 같은 SHA·blob `564df314035ecdf9a1bf24de2aa2c87f088ff7e5`. 이전 probe 결과를 신규 실행으로 세지 않음. #141의 실패 격리 개선 권고는 이번 범위에 합치지 않음 |

기존 캐시는 후보·파일 탐색에만 사용했다. 기타 기존 조사는 이 세 행동의 조립을 직접 다루지 않아 신규 심층 대상으로 삼지 않았다.

## 레퍼런스

세 관점을 병렬 조사했다. 관점별 후보 14종과 메인 보충 MikroORM 1종, 총 고유 15종이며 질문 범위의 saturation이다. 전수조사 주장이 아니다.

| 관점 | 라운드 확장과 마지막 라운드 종료 근거 |
|---|---|
| 공통 행동/adapter | agent 제품 → 채팅 API/webhook → REST/GraphQL 서비스 지침, 3라운드. 마지막 GitLab은 parsing→service→presentation의 기존 분류를 반복 |
| commit 후 소유권 | ORM 공식 계약 → callback/savepoint 변형 → Sequelize API·PR 이력, 3라운드. 마지막은 owner·직렬 hook·완료 guard·예외 전파의 기존 분류를 반복 |
| 두 단계/비교 검사 | agent interrupt → workflow·서버리스 외부 이벤트 → durable step integration, 3라운드. 마지막 Restate는 journal 전 crash/재실행 실패 모드 반복 |

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이 | 선정 이유 |
|---|---|---|---|---|---|
| BaboJUBot | 현행 비교 기준 | `c88a98b58284a38bdadf7eff7aafa0219005371c` | MIT | 소스·실행 | 실제 HTTP+임시 PG+가짜 모델 목록으로 불일치 재현 |
| Zulip | 채팅 API/webhook | `366c9ba5dbf691bce76f87d27da9d1917bd711e2` | Apache-2.0 | 소스 | 두 adapter→동일 검증/저장, commit 이벤트와 오류 의미 차이 |
| Sequelize | managed transaction | `53d1e8a6199fff85a8d6cd7d9bf0f3487f0cf798` | MIT | 소스 | wrapper의 완료 처리 소유와 결과만 반환; 중복 commit 테스트 |
| LangGraph | interrupt/resume | `e5e37b5d70dbfd93c7006bd90a658c6179a95946` | MIT | 소스 | 재개 시 재실행 반례와 같은 입력/최종 상태·횟수 비교 |

모두 확인일은 2026-11-10. Sequelize는 v7 개발 소스이며 v6 출시 계약과 동일시하지 않는다. 라이선스는 각 고정 SHA의 root LICENSE를 읽었다. 설계 참고만 권고하며 코드 복사·새 의존성 채택은 없다. Zulip/Sequelize는 필요한 원문 파일 snapshot, LangGraph는 고정 SHA checkout으로 확인했다.

## 근거

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 웹은 modelsFor(choices) 후 decideApproval+complete. 채널은 목록 없이 decideApproval+complete. 채널 메시지는 알림으로 원래 조직·대화를 찾아 공통 메시지 closure를 호출 | [웹](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/app.ts#L1093-L1115), [채널](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/channel-replies.ts#L60-L105) | 소스 확인 |
| <a id="E02"></a>E02 | DB는 조직 잠금 후 pending을 먼저 확인하고 단계·core 선택 검증 뒤 팀/사본/wake/Event를 저장. connections 기본값은 빈 목록. core는 제안과 달라진 선택만 현재 목록으로 검사 | [decideApproval](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/db/src/approvals.ts#L159-L275), [planApprovalDecision](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/packages/core/src/approval.ts#L293-L311) | 소스 확인 |
| <a id="E03"></a>E03 | 메시지는 저장→complete→외부 steer→settle 저장→complete. completeStored는 after를 제거한 Outcome을 반환하지만 원 Stored 재적용을 막는 guard가 없음. 적용 순서는 workspace→Event/settings→취소→재개 조직→개별/프로바이더 촉진 | [메시지 closure](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/app.ts#L327-L378), [completeStored/applyAfterCommit](https://github.com/babo-jeonguk/BaboJUBot/blob/c88a98b58284a38bdadf7eff7aafa0219005371c/apps/server/src/after-commit.ts#L20-L70) | 소스 확인 |
| <a id="E04"></a>E04 | 같은 fake-2-mini/max 선택: 웹200·작업자2, 채널422 unknown_provider·작업자0. 채널 선택 생략 후200. 양쪽 결정 완료 뒤 없는 provider/model 선택 재전송은409 already_decided | 원본 HTTP server+임시 PG+createFakeProviders(2)·로컬 probe; Node24.21.0 | 실행 확인 |
| <a id="E05"></a>E05 | 같은 raw Stored를 completeStored에 두 번 넣으면 Event/kick이 두 번 실행. 반환 Outcome에는 after 없음. 원본 함수+fake hub/dispatcher 범위 | 같은 probe의 duplicateRawStored/outcomeHasAfter assert | 실행 확인 |
| <a id="E06"></a>E06 | Zulip API와 webhook의 전송 wrapper는 addressee 변환 후 같은 check_message→do_send_messages를 호출. do_send_messages는 atomic 아래 Message bulk_create | [공통 helper](https://github.com/zulip/zulip/blob/366c9ba5dbf691bce76f87d27da9d1917bd711e2/zerver/actions/message_send.py#L1579-L1664), [저장](https://github.com/zulip/zulip/blob/366c9ba5dbf691bce76f87d27da9d1917bd711e2/zerver/actions/message_send.py#L1107-L1128) | 소스 확인 |
| <a id="E07"></a>E07 | webhook은 target/filter를 다루고 없는 stream 예외를 None으로 바꿈. 공통 helper만으로 adapter의 거부 의미 일치를 보장하지는 않음 | [check_send_webhook_message](https://github.com/zulip/zulip/blob/366c9ba5dbf691bce76f87d27da9d1917bd711e2/zerver/lib/webhooks/common.py#L147-L217) | 소스 확인 |
| <a id="E08"></a>E08 | 저장 경로가 send_event_on_commit을 호출하고 helper는 transaction.on_commit에 발행 lambda를 등록 | [호출](https://github.com/zulip/zulip/blob/366c9ba5dbf691bce76f87d27da9d1917bd711e2/zerver/actions/message_send.py#L1451-L1464), [등록](https://github.com/zulip/zulip/blob/366c9ba5dbf691bce76f87d27da9d1917bd711e2/zerver/tornado/django_api.py#L275-L292) | 소스 확인 |
| <a id="E09"></a>E09 | Sequelize managed wrapper는 자신이 만든 tx만 commit하고 그 완료 뒤 result를 반환. 재사용 tx는 다시 commit하지 않음 | [wrappedCallback](https://github.com/sequelize/sequelize/blob/53d1e8a6199fff85a8d6cd7d9bf0f3487f0cf798/packages/core/src/sequelize-typescript.ts#L975-L1000) | 소스 확인 |
| <a id="E10"></a>E10 | commit은 finished guard 후 DB commit→hooks 순차 await. 원본 검사는 hook calledOnce·rollback hook0·두 번째 commit 거부를 assert. hook 오류도 commit catch로 전파됨 | [Transaction.commit](https://github.com/sequelize/sequelize/blob/53d1e8a6199fff85a8d6cd7d9bf0f3487f0cf798/packages/core/src/transaction.ts#L88-L118), [hook 검사](https://github.com/sequelize/sequelize/blob/53d1e8a6199fff85a8d6cd7d9bf0f3487f0cf798/packages/core/test/integration/transaction.test.js#L109-L162), [중복 검사](https://github.com/sequelize/sequelize/blob/53d1e8a6199fff85a8d6cd7d9bf0f3487f0cf798/packages/core/test/integration/transaction.test.js#L350-L398) | 소스 확인(테스트 미실행) |
| <a id="E11"></a>E11 | LangGraph interrupt는 index로 resume 값을 찾아 반환하거나 GraphInterrupt를 발생시킨다 | [interrupt](https://github.com/langchain-ai/langgraph/blob/e5e37b5d70dbfd93c7006bd90a658c6179a95946/libs/langgraph/langgraph/types.py#L1018-L1059) | 소스 확인 |
| <a id="E12"></a>E12 | sync/async 검사에 같은 topics→두 resume→같은 answers가 있고 functional 검사에는 세 interrupt 후 counter==3 assert가 있음. transport 비교 검사는 아님 | [sync](https://github.com/langchain-ai/langgraph/blob/e5e37b5d70dbfd93c7006bd90a658c6179a95946/libs/langgraph/tests/test_pregel.py#L6017-L6071), [async](https://github.com/langchain-ai/langgraph/blob/e5e37b5d70dbfd93c7006bd90a658c6179a95946/libs/langgraph/tests/test_pregel_async.py#L8340-L8391), [counter](https://github.com/langchain-ai/langgraph/blob/e5e37b5d70dbfd93c7006bd90a658c6179a95946/libs/langgraph/tests/test_pregel.py#L5777-L5809) | 소스 확인(테스트 미실행) |
| <a id="E13"></a>E13 | interrupt가 있던 노드는 재개 시 처음부터 실행되므로 앞선 side effect는 반복에 안전해야 한다는 공식 지침 | [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | 문서 주장 |

총 13개: 소스 10·실행 2·문서 1. 실행 2행은 같은 스크립트의 서로 다른 관찰 범위다. 메인이 결정에 쓴 worker 원문을 다시 열어 일치 여부를 확인했다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | transport 변환→공통 행동→도메인/저장 | E01/E02/E06/E07 | Zulip webhook은 일부 오류를 삼킴; 우리는 같은 의미의 거부 필요 | 목록 전달 누락·조립 drift 감소 | 공통 helper 밖의 사전 검증/오류 변환으로 다시 의미가 갈릴 수 있음 |
| <a id="P02"></a>P02 | 후처리 owner가 완료한 값만 반환 | E03/E05/E08–E10 | Sequelize는 객체 finished guard, 우리는 Stored와 Outcome 분리 | adapter 재후처리 경로 제거 | 타입/소유권만으로 crash·응답 유실 exactly-once가 생기지 않음 |
| <a id="P03"></a>P03 | 단계별 완료를 await하고 외부 호출 경계 보존 | E03/E11/E13 | LangGraph의 replay는 우리 순서의 반례 | 두 commit의 다른 효과를 잃지 않음 | 전체 retry·한 tx·한 complete로 축약하면 중복/장시간 잠금 위험 |
| <a id="P04"></a>P04 | 대응 입력의 영속 결과·효과 횟수 비교 | E04/E10/E12 | LangGraph는 sync/async, 우리는 웹/채널 | 코드 배치와 무관하게 의미 차이를 발견 | ID/시간 제거를 과하게 하면 조직 귀속 오류까지 숨길 수 있음 |

## 결정 권고

모든 행은 근거로부터의 권고/추론이다. #143에 확정된 사용자 선택을 재결정하지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 세 행동의 공통 모듈에 modelsFor→기존 DB→complete 순서를 둔다. adapter에는 파싱·알림/조직/대화 대상 식별·응답 변환을 유지 | P01/E04, #143 | 웹의 목록 조회 누락이 채널로 복제되지 않음. 선택 유효성·pending 우선순위는 DB/core 그대로 | Q1,Q3 |
| <a id="D02"></a>D02 | 채택 | 사용자 행동은 처리된 Outcome만 반환. adapter에서 complete 재호출·직접 publish/cancel/kick·raw Stored 반환 병행을 제거 | P02/E05 | 각 commit의 후처리 소유자가 하나. 전역 WeakSet·새 effect ID 체계 없이 조립 문제를 해결 | Q1,Q2 |
| <a id="D03"></a>D03 | 채택 | 메시지의 저장→complete→외부 steer→settle 저장→complete를 직렬 유지. 두 complete는 서로 다른 commit의 효과 | P03, #143·ADR-0002 | steer 거절 뒤 queue 정산을 보존. 외부 호출을 DB tx에 넣거나 전체 동작을 자동 replay하지 않음 | Q2,Q3 |
| <a id="D04"></a>D04 | 변형 채택 | 같은 시나리오를 웹/채널 fixture에 전달하고 영속 승인·팀·단계·Event·wake 및 fake 호출 수/순서를 비교 | P04/E04 | 선택 없는 승인 비교의 공백을 보완. helper 구조/호출 횟수만 복제하는 테스트는 피함 | Q1,Q2,Q3 |
| <a id="D05"></a>D05 | 채택 | 초기 승인·작업자 추가·결과 검토 transaction과 pause/resume 판단·조직 잠금은 기존 위치 유지. AfterCommit 순서·실패 취급도 유지 | E02/E03, #143·ADR-0005 | 조립 추출이 정책이나 강제 수단 변경이 되지 않음. #141 개선과 병행 시 현행 재대조 필요 | Q1,Q2,Q3 |
| <a id="D06"></a>D06 | 배제 | 범용 bus·새 workflow/ORM·outbox·exactly-once·전체 retry·commit 효과 전역 dedup을 도입하지 않음 | P02/P03, Out of Scope | 외부 library의 메커니즘은 설계 참고. 두 commit 합치기와 DB 판단의 adapter 이동도 범위 불일치 | Q2,Q3 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| transport가 공통 거부를 성공/무응답으로 바꿈 | Zulip webhook None(E07) | 웹·채널 같은 거부 의미 계약 위반 |
| callback/finished guard를 전달 exactly-once로 해석 | Sequelize(E10), Zulip(E08) | 객체/등록 소유권과 crash 이후 효과 보장은 다름 |
| 후처리까지 DB commit 실패로 취급해 저장/모델 호출 재시도 | Sequelize commit catch(E10) | #143은 기존 실패 의미 유지; 개선 필요 시 후속 #141 소유 |
| 저장·steer·정산 전체를 replay하거나 두 commit을 하나로 합침 | LangGraph 재개 모델(E13)의 무비판적 이식 | 이미 실행한 효과 반복 또는 두 번째 commit 효과 누락 |

## 구현 참고

권고 요약: 공통 사용자 행동 → 각 commit의 기존 complete → Outcome만 반환. 모델 목록은 잠금 밖에서 조회하고 검증·단일 결정은 DB/core에 남긴다.

- `apps/server/src/app.ts`: 공통 사용자 행동 의존성 생성/주입과 adapter 연결. 현행 sendOwnerMessage closure·승인/결과 handler의 조립을 추출할 출발점이다.
- `apps/server/src/channel-replies.ts`: 알림의 조직·원본·대화 식별, schema 검사, 응답 축약·로그를 유지하며 공통 행동 호출. 자기 서버 HTTP 재호출 없음.
- 새 사용자 행동 모듈의 파일명·주입 형태는 #143 구현에서 정한다. server 내부 조립 책임이며 core/DB가 server·transport를 import하지 않는다.
- `packages/core/src/approval.ts`, `packages/db/src/approvals.ts`·`results.ts`·메시지 저장/settle 경로와 `apps/server/src/after-commit.ts`의 기존 계약을 재사용한다. 사용자 행동 모듈에서 독립 상태 판정/transaction을 새로 만들지 않는다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 동일 제안의 두 조직 → 웹/채널 변경 유효 선택 → 같은 팀 provider/model·단계·결정 Event·Lead wake; 생략/제안 유지도 성공 | D01/D04 |
| V02 | 모르는 provider/model·선택 수 불일치 → 각각 두 경로 → 같은 거부 의미·팀/Event/wake 추가0. 이미 결정한 뒤 목록 변경/잘못된 선택 → already_decided 우선 | D01/D04/E02/E04 |
| V03 | 같은 pending에 웹/채널 동시 상반 결정 → 승자 하나·패자 already_decided·작업자/결정/Event/wake 한 번 | D02/D04 |
| V04 | 초기 승인 pause/stopped·작업자 추가 pause·결과 pause/stopped → 결정 → 초기 재개/중단 거부, 작업자 추가 pause 유지, 결과 재개/완료/중단 거부를 각각 비교 | D05 |
| V05 | 결과 complete/request_changes 반복·경합 → 양쪽 결과 검토 → 단일 확정·최종 완료 또는 수정 요청, 패자 추가 효과0 | D02/D04/D05 |
| V06 | 원래 대화 알림·다른 조직/원본·없는 알림 → 채널 답장 → 원래 대화만 기록·잘못된 대상 거부; 초기 승인 전 실행/조직 도구 최종 완료/교차 조직 쓰기는 기존대로 금지 | D01/D05 |
| V07 | 실행 중 queue/interrupt/steer 수락·거절 → 사용자 메시지 → 저장 Event 이후 취소/steer, 거절은 queue settle, 두 commit 각각의 효과만 적용. 가짜 provider gate와 기존 AfterCommit 전용 대역으로 순서 관찰 | D02/D03 |
| V08 | 거부·정상·후처리 실패 주입 → 사용자 행동/adapter 응답 → 거부 효과0, 정상 publish/cancel/kick 중복0, 기존 AfterCommit 순서/실패 의미 유지 | D02/D05 |

기존 `apps/server/test/notifications.test.ts`의 선택 없는 승인 효과 비교·원래 대화 답장·결과 결정, `providers.test.ts`의 선택 검증, `approvals.test.ts`의 동시 결정, `control.test.ts`의 pause/interrupt, `results.test.ts`, `src/after-commit.test.ts`를 보강할 검증 경계다. 기존 검사를 읽었으며 이번에 전체 suite를 실행하지는 않았다. ID/시간을 비교에서 정규화해도 각 조직·원본·대화 귀속 assertion은 별도로 남긴다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 파일명·함수형 factory/객체형 주입·메서드 인자 세부 | #143 구현 | 기존 closure를 추출하거나 작은 factory로 구성. 외부 행동·Outcome·후처리 소유권은 동일(D01–D03). 사용자 제품 정책 질문 없음 |
| 효과 실패 격리 개선·종료 저장 통합 | 후속 #141 | 기존 동작 유지 또는 별도 #141 구현 반영 후 재확인. 이번 blocker/추가 요구가 아님 |

## 한계와 미확인

- 실행은 원본 HTTP server+임시 PG+가짜 프로바이더의 초기 승인 선택 차이·반복 우선순위, 원본 completeStored+대역의 재적용에 한정된다. 실제 모델·계정·연구 데이터·유료 API는 사용하지 않았다.
- 동시 웹/채널 결정·결과 검토 parity·pause 전체·steer 수락/거절/복구·실제 Event stream 단일 전달은 이번 probe로 검증하지 않았다. 향후 V01–V08은 구현 완료 조건이며 조사 통과 결과가 아니다.
- 외부 OSS는 소스/테스트 읽기만 했으며 upstream 실행·전체 self-host·실제 채널은 미실행이다. 후보의 self-host 경로와 관찰된 동작을 구분한다. 읽은 범위에서 정확한 두 commit+외부 steer 사례는 찾지 못했고 E03의 현행 순서가 보존 근거다.
- LangGraph의 과거 interrupt 회귀 PR/blame 도입 이유는 미확인. Zulip 최신 해당 경로 변경은 presence 조회 최적화이며 경계의 역사적 도입 이유는 미확인. Sequelize는 afterRollback/afterTransaction 추가 PR #15837까지 확인했다.
- 로그인/유료 서비스에는 접근하지 않았다. 기본 shell sandbox는 bwrap 네트워크 초기화 오류로 실패하여 승인된 직접 실행을 사용했다. 자료 접근 차단으로 결론을 추정한 항목은 없다.
- commit 직후 crash·응답 유실의 새 전달 보장은 추가하지 않는다. Outcome 분리도 런타임 선형 타입이나 영속 exactly-once 보장이 아니다. upstream 변경 시 SHA 원문 재독, 코드 복사 시 별도 LICENSE/header/NOTICE/의존성 검토가 필요하다.
