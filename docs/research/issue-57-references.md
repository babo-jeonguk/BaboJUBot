# issue-57 레퍼런스 조사: 결과 제출과 최종 완료

조사일: 2026-10-21. 대상: [#57](https://github.com/babo-jeonguk/BaboJUBot/issues/57). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-57/`(git 무시).

## Brief

- 구현할 문제: Lead의 요약·근거 산출물 제출을 사용자 검토로 연결한다. 수정 요청은 의견과 함께 연구 진행으로 돌리고 Lead를 깨운다. 최종 완료는 사용자만 결정하고 이후 깨우기는 새 실행 시도로 admission되지 않는다.
- 동종 문제: 제출자와 결정권자를 분리한 불변 검토 대상, 수정·재제출, 닫힌 조직의 실행 admission 경합.
- 고정된 결정: [AGENTS](../../AGENTS.md), [용어](../../GLOSSARY.md), [기능](../features.md), [구조](../architecture.md), [ADR](../adr/)와 #49 stories61–66. 최종 완료는 일반 승인 요청과 구별한다. PG/Drizzle·Express·React/Query와 실제 모델 없는 가짜 실행기를 유지한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 요약·완료 기준·근거 산출물을 어떤 불변 검토 대상으로 묶고 수정·재제출·옛 화면을 구별하는가? | #57 범위, #49 stories61/63, #55 산출물 | Source Recon + persistence/recovery·프로토콜 계약 |
| Q2 | 결정 단일 적용과 단계·의견·Lead 깨우기·Event·Inbox 원본을 어떻게 함께 저장하는가? | #57 AC1/2, ADR-0002 | Source Recon + runtime/failure·PG 음성 대조 |
| Q3 | 완료와 claim·heartbeat·늦은 도구 경합에서 admission과 완료 권한을 어디서 강제하는가? | #57 AC3/4, AGENTS | Source Recon + adversarial scenario·동시성 |
| Q4 | Inbox→별도 결과 검토→요약·기준·산출물→수정/완료를 실패·중복·390px에서 어떻게 제공하는가? | #57 AC5, features, #53/55 상세 경로 결정 | Surface Capture + Behavioral Recon + Source Recon |
| Q5 | 현행 package·도구·가짜 실행기·query/Event를 어떻게 확장하고 무엇을 후속에 남기는가? | architecture, #49 검증 계약 | 현재 소스 대조 + 계약·실패 검증 |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#50](issue-50-references.md#brief)·[화면 후보](dashboard-references.md) | Inbox projection·읽음/보관과 업무 결정 구별, 후보 탐색 | 기존 캡처를 이번 실행으로 세지 않음 |
| [#53](issue-53-references.md#brief) | 영속 깨우기·agent admission·종료 토큰·fake gate | 현재 claim·dispatcher·인증 원문 재독 |
| [#54](issue-54-references.md#brief) | snapshot·단발 결정·거부 Event·사용자 경계 | 병합된 snapshot/새 요청 ID 선택을 열린 결정으로 반복하지 않음 |
| [#55](issue-55-references.md#brief) | 산출물 출처·단건 페이지·복합 FK | 현재 Markdown/text insert와 조회·Task 완료 정책 재독 |
| [#56](issue-56-references.md#brief) | 조직 잠금·사용자 지도 편집·Lead 깨우기 | 결과 검토 중 지도 편집과 제출물 고정의 구별 확인 |
| [비교](comparative-survey.md)·[Paperclip](paperclip.md)·[협력](agent-interaction-models.md) | 후보·메커니즘 탐색 | 옛 E를 새 E로 옮기지 않고 고정 원문으로 재확인 |

## 레퍼런스

관점별 saturation: 기록·재제출은 4라운드째 Review Board의 draft/publish가 이미 찾은 버전별 검토의 변형에 그쳤다. 실행 경계는 4라운드째 queue/controller·Paperclip 실패 이력이 admission, 취소 의도, 정리 완료의 구별로 수렴했다. 화면은 3라운드째 Gerrit·ERPNext가 기존 제출 버전·역할별 결정 패턴을 반복했다. 완전 탐색을 뜻하지 않는다. 전체 후보와 실행 경로는 `.reference-cache/issue-57/candidates.md`.

| 레퍼런스 | 분류 | 버전·SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| Paperclip | agent Control Plane OSS | `65f59e339a9fb6e0635bcbd8c36791bd610326a6` | MIT 원문 확인 | 소스·순수 정책 실행. 검토 actor·현재 상태 재검사·재개 예외가 가장 직접적인 비교/반례 |
| Gerrit | 인접 코드 검토 OSS | `5d66555e5eaa3189f0b7956e7ff168110a5652ef` | Apache-2.0 COPYING·파일 header 확인 | 소스·순수 helper 실행. 명시 revision, old/latest 명령 차이, 검토 후 stale 응답 회귀 |
| A2A | agent 프로토콜 명세 | `98279d62316361ba8451eaef300f72b72e169185` | Apache-2.0 원문 확인 | 문서·proto. Task 완료와 사용자 최종 완료의 의미 차이, refinement 이력 |
| PostgreSQL | 저장·동시성 엔진 | 18 공식 문서, 실행 18.4 / embedded-postgres18.4.0-beta.17 / pg8.23.1 | PostgreSQL License; 소스 복사 없음 | 독립 SQL 실행. 완료/claim·CAS·rollback·FK 잠금을 음성 대조와 비교 |
| assistant-ui | OSS UI 부품·공식 데모 | `a8db8497898fd22907151d5608b81f2b299e0328`; 공개 배포와 SHA 동일성 미확인 | MIT 원문 확인 | 소스·공개 실화면. 요청→결정 receipt·포커스의 작은 비교 단위 |
| handup | 상용 검토 Inbox의 공식 데모 | 2026-10-21 공개 client-only demo; 배포 SHA 미확인 | 코드 재사용 대상 아님 | 공개 실화면. Markdown 원문·의견 입력·Inbox→결정 이력 |

모두 설계 참고다. 신규 엔진·UI 의존성 채택이나 제품으로의 코드 복사를 권고하지 않는다. 소스 복사 시 그 SHA의 LICENSE·개별 header·NOTICE·동반 의존성을 다시 확인하고 AGENTS의 출처 고지를 적용해야 한다.

## 근거

현행 제품 소스는 조사 시작 HEAD `537714dabe4138e34c783d50d3c0372827091502`다. 아래 source는 메인이 직접 재열람했다. 기존 연구의 E 번호를 새 실행으로 옮기지 않았다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현재 admission은 agent UPDATE 잠금·active 확인·입력 묶음 고정 후 run을 생성하며 조직 단계 검사는 없다. pending 조회는 모든 미처리 wake를 반환하고 drain은 그 목록이 빌 때까지 반복한다. terminal wake를 보존할 때 runnable 판정도 필요하다 | [claimNextRun](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/db/src/runs.ts#L86-L147), [pending](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/db/src/runs.ts#L204-L212), [drain](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/apps/server/src/dispatcher.ts#L99-L107) | 소스 확인 |
| <a id="E02"></a>E02 | 현재 도구 쓰기는 running run SHARE→조직 NO KEY UPDATE→Role/단계 재검사다. 연구 쓰기는 researching에서만 열리며 완료·정책 변경 도구는 목록에 없다. wake는 조직+agent 복합 FK로 연결한다 | [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/db/src/tool-calls.ts#L87-L117), [toolRules](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/core/src/approval.ts#L36-L81), [wake FK](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/db/src/schema.ts#L737-L745) | 소스 확인 |
| <a id="E03"></a>E03 | Owner 승인 결정 route는 실행 토큰 middleware 밖에 있고 Owner 인증을 하지 않는다. 도구 namespace 분리만으로 임의 HTTP 접근을 막았다고 할 수 없다. #54 완료 댓글에도 같은 한계가 기록됐다 | [router 설치](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/apps/server/src/app.ts#L98-L108), [Owner 결정](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/apps/server/src/app.ts#L371-L395), [기존 기록](https://github.com/babo-jeonguk/BaboJUBot/issues/54#issuecomment-6258404693) | 소스 확인 |
| <a id="E04"></a>E04 | 현재 산출물은 같은 조직 task를 확인해 text/Markdown 본문과 작성 agent/run을 새 행으로 저장한다. 읽은 계약/handler에는 산출물 update/delete가 없다. 사용자 지도 편집은 result_review에서도 가능하므로 검토 중 전체 기록이 동결된다고 가정하면 안 된다 | [recordArtifact](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/db/src/tasks.ts#L193-L212), [형식·입력](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/contracts/src/task.ts#L69-L88), [지도 편집 단계](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/contracts/src/research-map.ts#L39-L52) | 소스 확인 |
| <a id="E05"></a>E05 | 현재 초기 승인 결정은 조직 lock+pending CAS 아래 단계·팀·wake·Event를 저장한다. Inbox는 pending approval만 조회한다. 웹은 결정 서버 응답 이후 갱신하며 조직별 query와 전역 Inbox를 Event/재연결로 재조회한다 | [decideApproval](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/db/src/approvals.ts#L131-L206), [Inbox](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/packages/db/src/approvals.ts#L246-L260), [mutation](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/apps/web/src/api.ts#L272-L302), [live query](https://github.com/babo-jeonguk/BaboJUBot/blob/537714dabe4138e34c783d50d3c0372827091502/apps/web/src/live-events.ts#L31-L50) | 소스 확인 |
| <a id="E06"></a>E06 | PG 행 잠금은 충돌하는 갱신을 직렬화한다. NO KEY UPDATE는 KEY SHARE와 호환한다. Read Committed에서는 잠금을 얻은 뒤 최신 조건을 재확인하고, FK는 조직을 포함한 키로 참조 범위를 표현할 수 있다 | [row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS), [isolation](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED), [FK](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-FK) | 문서 주장 |
| <a id="E07"></a>E07 | 독립 PG 실험10건39assertions PASS. 무잠금 완료/claim 반례, 조직 잠금 재검사, 이미 admission된 run, CAS·rollback·stale 제출·복합 FK를 확인했다. agent UPDATE→org와 org→wake FK는 실제40P01; agent NO KEY UPDATE 대조는 FK 호환과 동일 agent 직렬화를 함께 확인했다 | `probes/postgres-result.mjs`, `postgres-result-final-log.txt`, `recon/postgresql.md`. Node24.21·PG18.4·pg8.23.1. 제품 schema/API 실행 아님 | 실행 확인 |
| <a id="E08"></a>E08 | Gerrit 명시 revision submit은 SUBMIT 권한·열린 상태·current patch set을 검사한다. 반면 change-level submit은 그때 latest를 선택한다. 검토한 버전을 전송하는 것과 최신 항목을 결정하는 것은 다른 계약이다 | [explicit revision](https://github.com/GerritCodeReview/gerrit/blob/5d66555e5eaa3189f0b7956e7ff168110a5652ef/java/com/google/gerrit/server/restapi/change/Submit.java#L192-L242), [latest API](https://github.com/GerritCodeReview/gerrit/blob/5d66555e5eaa3189f0b7956e7ff168110a5652ef/java/com/google/gerrit/server/restapi/change/Submit.java#L552-L575) | 소스 확인 |
| <a id="E09"></a>E09 | Gerrit는 review와 attention 변경을 한 BatchUpdate에 넣는다. listener가 추가 변경한 뒤에는 meta ref를 비교해 reload하며, 동기 submit 직후 응답도 MERGED여야 한다는 회귀 테스트가 있다. 이 테스트는 읽기만 했다 | [batch](https://github.com/GerritCodeReview/gerrit/blob/5d66555e5eaa3189f0b7956e7ff168110a5652ef/java/com/google/gerrit/server/restapi/change/PostReview.java#L395-L463), [reload](https://github.com/GerritCodeReview/gerrit/blob/5d66555e5eaa3189f0b7956e7ff168110a5652ef/java/com/google/gerrit/server/restapi/change/PostReview.java#L352-L379), [regression](https://github.com/GerritCodeReview/gerrit/blob/5d66555e5eaa3189f0b7956e7ff168110a5652ef/javatests/com/google/gerrit/acceptance/api/change/PostReviewIT.java#L846-L867) | 소스 확인 |
| <a id="E10"></a>E10 | Gerrit 원본 getShaByPatchNum을 타입 제거만 하고 제한 실행해5assertions PASS. 명시 번호의 SHA는 새 revision 추가 후에도 유지되며 없는 번호·문자열 번호는 undefined다. 서버 권한/동시성 실행이 아니다 | [원본 함수](https://github.com/GerritCodeReview/gerrit/blob/5d66555e5eaa3189f0b7956e7ff168110a5652ef/polygerrit-ui/app/utils/patch-set-util.ts#L108-L116); `probes/gerrit-records.mjs`, `records-run-log.txt` | 실행 확인(제한) |
| <a id="E11"></a>E11 | A2A는 terminal Task 재개 대신 같은 context의 새 refinement Task를 설명한다. SendMessage 중복 제거는 MAY다. Task completed를 사용자 최종 완료로 간주하거나 프로토콜만으로 단일 적용을 보장할 수 없다 | [lifecycle](https://github.com/a2aproject/A2A/blob/98279d62316361ba8451eaef300f72b72e169185/docs/topics/life-of-a-task.md#L68-L92), [idempotency](https://github.com/a2aproject/A2A/blob/98279d62316361ba8451eaef300f72b72e169185/docs/specification.md#L490-L496) | 문서 주장 |
| <a id="E12"></a>E12 | Paperclip의 human_only는 authenticated user만 검토 결정하도록 검사하지만 기본 정책은 anyone이다. issue route는 변경 직전 잠금 아래 다시 검사한다. 조직 최종 완료를 선택 정책으로 가져올 수는 없다 | [actor guard](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/services/issue-review-policy.ts#L100-L125), [locked recheck](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/routes/issues.ts#L14510-L14542) | 소스 확인 |
| <a id="E13"></a>E13 | Paperclip stalled-review 결정은 행 lock 아래 note·상태·activity를 한 tx에 저장하며 동시 결정 test는200/409를 assert한다. 그러나 resume wake insert는 commit 뒤 best-effort이고 실패 시 liveness sweep을 기대한다고 명시한다 | [결정 tx](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/services/stalled-review-decisions.ts#L35-L132), [post-commit wake](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/routes/issues.ts#L13498-L13555), [test](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/__tests__/issue-stalled-review-decision-routes.test.ts#L590-L626) | 소스 확인 |
| <a id="E14"></a>E14 | Paperclip queued-run 정책의 terminal 검사에는 comment·resume·일부 onboarding wake 예외가 있다. tests도 resume terminal 우회를 허용한다. task의 done과 조직 최종 완료는 다른 의미다 | [terminalBypass](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/modules/run-dispatch/domain/policy.ts#L619-L632), [tests](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/modules/run-dispatch/domain/policy.test.ts#L411-L437) | 소스 확인 |
| <a id="E15"></a>E15 | 같은 Paperclip 원본 순수 정책을 Node24에서 import해 done/cancelled 각각 ordinary wake 거부·comment/resume 허용 총6건을 확인했다. 전체 dispatcher/HTTP 실행은 아니다 | E14의 고정 원본; `recon/fence.md` 실행 기록 | 실행 확인(제한) |
| <a id="E16"></a>E16 | Paperclip 취소 쓰기 guard는 cancelled 또는 cancellation requested를 차단한다. succeeded/failed/missing까지 모두 차단하는 running allowlist와 다르다. 기존 BaboJUBot 종료 토큰 검사를 이 helper로 대체할 이유가 없다 | [agentRunWritesRevoked](https://github.com/paperclipai/paperclip/blob/65f59e339a9fb6e0635bcbd8c36791bd610326a6/server/src/agent-run-cancellation.ts#L5-L31) | 소스 확인 |
| <a id="E17"></a>E17 | assistant-ui는 request 버튼을 status receipt로 교체하고 제거된 버튼의 포커스를 조건부로 이어 준다. 공식 데모는 timer로 request로 복귀하며 서버 단일 결정/실패 상태를 구현한 예제가 아니다 | [receipt](https://github.com/assistant-ui/assistant-ui/blob/a8db8497898fd22907151d5608b81f2b299e0328/packages/ui/src/components/react/assistant-ui/elements/approval-card.tsx#L144-L214), [focus](https://github.com/assistant-ui/assistant-ui/blob/a8db8497898fd22907151d5608b81f2b299e0328/packages/ui/src/components/react/assistant-ui/elements/receipt-focus.ts#L11-L28), [timer](https://github.com/assistant-ui/assistant-ui/blob/a8db8497898fd22907151d5608b81f2b299e0328/apps/docs/components/demo/elements/approval-card.tsx#L10-L31) | 소스 확인 |
| <a id="E18"></a>E18 | 공개 데모10캡처를 직접 조작하고 메인이 전부 재열람했다. handup은 원문·의견 입력→Inbox 감소·History→결정자/시각/사유/원문 receipt, assistant-ui는390px 요청→Denied/running/Finished를 보여준다. offline은 데모 배너만 확인했다 | [handup](https://gethandup.dev/), [ApprovalCard](https://www.assistant-ui.com/elements/approval-card); `captures/surface-captures.md`, `probes/surface-*-log.json`. handup의 서로 다른 의견 입력 run을 구별했고 Denied는 브라우저 clock 정지로 timer reset만 막아 재촬영 | 실행 확인(공개 데모) |

근거18개: **실행4·소스12·문서2**. 순수 helper 실행·독립 SQL·브라우저 로컬 데모는 제품 API나 전체 upstream 실행과 구별한다. 상세 호출 사슬·테스트·실패 경로·SHA 비교는 cache의 recon과 main-verification에 있다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 제출 기록과 결정 대상 버전 고정 | E04,E08–E11 | Gerrit patch set/A2A Task는 연구 조직이나 최종 완료가 아님 | 옛 제출과 새 제출·검토 당시 기준 보존 | latest만 결정하거나 같은 행을 초기화하면 다른 결과에 옛 결정을 적용 |
| <a id="P02"></a>P02 | 결정·의견·다음 행동 원본의 원자적 저장 | E05–E07,E09,E13 | Gerrit attention·Paperclip best-effort wake와 달리 영속 Lead wake는 같은 PG tx 필요 | 수정 결정만 남고 연구가 멈추는 실패 창 축소 | commit 뒤 외부 발행은 별도 복구 영역; 성공 DTO와 최신 query도 구별 |
| <a id="P03"></a>P03 | Owner 결정·조직 admission·실행 정리의 별도 경계 | E01–E03,E07,E12,E14–E16 | 선택 human_only·terminal resume는 최종 완료에 적용 불가 | agent 보고·성공 run이 조직 완료를 대신하지 않음 | 목록만 숨기기, 인증 없는 Owner route, 취소 신호만으로 권한 차단 가정 |
| <a id="P04"></a>P04 | 공통 조직 lock과 FK 잠금 호환성 | E01,E02,E06,E07 | 기존 agent UPDATE에 조직 lock을 단순 추가하면 wake FK와 역순 경합 | 완료/claim·수정 요청/wake를 함께 직렬화 | deadlock40P01, org→run 잠금 추가로 기존 run→org와 역전 |
| <a id="P05"></a>P05 | 원문·의견·명시 결정과 재방문 가능한 receipt | E05,E09,E17,E18 | 승인 카드의 always-allow나 지연 Undo는 제품 의미가 다름 | 사용자가 검토한 내용과 결정을 함께 확인 | 실패/응답 유실을 성공으로 표시, 초안 유실, 다른 제출로 stale mutation |

## 결정 권고

채택/배제는 조사 권고 분류이며 확정 계약을 바꾸지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 일반 Approval과 별도 결과 제출 기록. 제출 ID·조직·Lead/run·요약·서버가 읽은 목표/완료 기준 snapshot·제출 시각·같은 조직 산출물 ID 묶음 보존. 재제출은 새 ID와 직전 제출 연결 | P01,E04,E08,E11; GLOSSARY | 현재 insert-only 산출물 본문을 모두 복제하거나 새 저장 엔진을 들일 필요 없음. 지도 전체 snapshot/자동 품질 판정은 요구가 아님 | Q1,Q5 |
| <a id="D02"></a>D02 | 채택 | Lead의 researching 결과 제출은 token scope·산출물 관계 검사 후 제출+result_review 전이+Event를 한 tx에 기록. 수정 요청은 의견+결정+researching 복귀+출처 제출을 가리키는 Lead wake+Event를 한 tx에 기록. Inbox는 영속 pending 제출을 조회 | P02,E02,E05–E07,E13; ADR-0002 | DB commit 뒤 hub publish/kick만 수행. 필수 wake insert를 best-effort에 두지 않음. #61 전에도 #57 Inbox 조회가 동작해야 함 | Q1,Q2,Q5 |
| <a id="D03"></a>D03 | 변형 채택 | 두 Owner 결정은 조직 lock 아래 org+submission ID·current pending·result_review를 재검사하고 pending CAS 승자만 효과 생성. 중복/옛 제출409+재조회 권고. 응답 유실은 저장된 결정을 조회해 확인 | P01–P02,E05,E07–E09,E13 | 연구 진행으로 돌아갔다 새 제출이 생겨도 이전 버튼으로 완료할 수 없어야 함. 재제출 때 옛 의견·결정을 지우지 않음 | Q1,Q2,Q4 |
| <a id="D04"></a>D04 | 변형 채택 | completed는 모든 wake 원인에 예외 없는 공통 admission 거부. 완료 전이와 claim의 조직 stage 검사를 같은 잠금으로 직렬화하고 검사·run 생성·입력 membership을 한 tx에 둠. agent lock의 강도/순서와 FK를 함께 검토 | P03–P04,E01,E02,E06,E07,E14–E16 | 기존 agent UPDATE 뒤 조직 lock만 추가하면 실제 deadlock 반례. agent NO KEY UPDATE+조직 lock은 유력 대안이며 제품 제약으로 재검증. 늦은 연구 쓰기도 기존 stage 재검사 유지 | Q2,Q3,Q5 |
| <a id="D05"></a>D05 | 채택 | 제출은 Lead 도구, 최종 완료·정책 변경은 Owner 명령으로만 유지. 신뢰된 actor를 서버에서 정하고 직접 HTTP·worker·위조 scope·끝난 토큰까지 음성 대조. 사용자 신뢰경계는 아래 열린 결정으로 명시 | P03,E02,E03,E12,E16; AGENTS | bearer가 있다는 이유만으로 Owner로 처리하면 안 됨. bearer 거부만으로는 header 생략 우회도 해결되지 않음 | Q3,Q5 |
| <a id="D06"></a>D06 | 변형 채택 | Inbox의 result_submission 판별 항목→조직/제출 ID가 든 별도 상세 페이지. 제출 요약·당시 완료 기준·근거 링크와 작성 출처, 수정 의견, 수정 요청/최종 완료. 서버 결정 후 read-only receipt·제거된 버튼의 포커스 연결. pending 공통 잠금·실패 초안 유지·409 재조회·조직/제출별 draft 격리 | P01,P05,E05,E09,E17,E18; #57 AC5 | 산출물은 기존 단건 페이지로 연결. current 조직 상태와 해당 제출 결정은 별도 표시. event·ready/reconnect로 org/detail/Inbox 재조회. timer reset·지연 Undo·always-allow는 배제 | Q1,Q4,Q5 |
| <a id="D07"></a>D07 | 채택 | scripted 일반 call/gate·실제 token HTTP로 제출/수정/재제출/완료 시나리오를 만든다. 완료 뒤 pending wake도 runnable queue가 안정적으로 비었다고 판단할 수 있게 dispatcher/startup/drain의 의미를 함께 검토 | P02–P04,E01,E07,E14; #49 Testing Decisions | DB 직접 변경·고정 sleep·fake의 성공 문자열로 final 보장하지 않음. 일반 heartbeat/restart 정책은 후속이지만 completed gate 검증은 #57 책임 | Q2,Q3,Q5 |
| <a id="D08"></a>D08 | 배제 | 작업 완료·run 성공·산출물 존재·선택 승인 정책으로 자동 최종 완료, terminal comment/resume 예외, 새 workflow/queue/메모리 엔진, inline review/diff·오프라인 결정 전송까지 확장하지 않음 | P01–P05,E04,E11–E18; ADR1–4 | 연구 판단은 Lead, 완료 결정은 사용자, 강제는 Control Plane. 검증/취소/전송의 후속 경계를 보존 | Q1,Q3,Q4,Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 일반 task done·A2A completed를 조직 final에 매핑 | E11,E14 | 사용자 결정과 이후 admission 금지 계약이 없음 |
| final도 human_only 체크박스로 선택, 도구에서 stage 자유 수정 | E12; #57 | 초기 승인·최종 완료는 끌 수 없는 제품 규칙 |
| 완료 결정과 wake 삽입 분리 후 liveness sweep에 의존 | E13 | 기존 ADR의 영속 원인+wake 원자성에 맞지 않음 |
| latest endpoint만 결정·같은 제출 행 reset | E08,E11 | 사용자가 읽은 결과·이전 의견/결정 보존을 깨뜨림 |
| 기존 agent UPDATE→org lock 추가만으로 경합 해결 | E07 | org→wake의 agent FK 잠금과 실제 deadlock 발생 |
| 프론트 status·cancel 신호만 보고 권한 종료 | E03,E16,E17 | 서버 actor·run status·org stage 검사가 필요 |
| 승인 데모의 timer reset/YOLO/지연 Undo를 최종 완료에 적용 | E17,E18 | 서버 확정 결정 의미와 다름 |

## 구현 참고

권고의 중심은 **불변 제출 대상, 사용자 결정의 단발 적용, 영속 수정 의견·Lead wake, 최종 완료와 공통 admission의 직렬화**다.

| 책임·위치 | 구현 때 확인할 연결 |
|---|---|
| 계약 — packages/contracts | 제출/결정/상세·Inbox 판별 union·result wake reason/Event. actor·조직·작성 run·기준 snapshot은 agent가 선택하지 않도록 strict 입력. 실제 도구 이름/경로는 구현에서 확정 |
| 순수 규칙 — packages/core | Lead 제출·Owner 결정·단계 전이·admission 허용. core→contracts만 유지하고 DB/Express/React에 의존하지 않음 |
| 저장 — packages/db | 제출·근거 관계·결정 schema/migration·복합 FK·pending 방어·org lock/CAS·Event/wake tx. claimNextRun과 pending/runnable 조회를 함께 검토 |
| 서버 — apps/server | scoped 제출 도구와 Owner 결정/조회·Inbox. commit 뒤 EventHub/kick. Owner 인증·실행기 접근 경계는 명시적으로 선택. org lock 아래 기존 run 잠금을 역순으로 추가하지 않음 |
| 실행기 — packages/runtime | scripted call·wake/context 해석·gate로 검증 가능한 시나리오. 기존 adapter seam을 유지하며 자체 agent loop를 만들지 않음 |
| 화면 — apps/web | 별도 결과 검토 route·기존 artifact 단건 링크·query key·live invalidation·결정 폼/receipt·390px. 공개 데모 화면을 제품으로 복사할 필요 없음 |

| ID | 검증할 경계 — 입력 → 행동 → 기대 | 근거 |
|---|---|---|
| V01 | researching Lead가 같은 조직 산출물로 제출 → result_review·제출 snapshot/출처 저장·Inbox 항목·Event. 새로고침에도 같은 제출을 조회 | D01,D02; AC1 |
| V02 | Owner 수정 의견 → 결정/의견 보존·researching·그 제출을 가리키는 Lead wake. 다음 실행 시도에 의견 포함, 이후 재제출은 새 ID | D01–D03; AC2 |
| V03 | 최종 완료 후 사용자 메시지/작업 댓글 등으로 pending wake를 남기고 kick/startup/drain → 추가 run/adapter 호출 없음. heartbeat/restart가 생기는 #60에서도 같은 gate 소비 | D04,D07; AC3 |
| V04 | 완료와 claim을 gate로 양쪽 순서에 배치 → 완료 선행은 claim 거부. claim 선행은 이미 시작된 run을 아래 선택 정책대로 처리. run 성공을 조직 완료로 쓰지 않음 | D04; AC3 |
| V05 | worker 제출·Lead final/policy 도구·위조 stage/actor/scope·종료 토큰·직접 Owner route 호출 → 선택한 신뢰경계에서 거부·허용되지 않은 효과 없음 | D02,D05; AC4 |
| V06 | A 토큰에 B 산출물/제출 ID, A Owner 경로에 B 제출 ID → 없는 ID와 같은404·변경/깨우기 없음. 같은 조직의 여러 근거와 작성 run은 보존 | D01–D03,D05 |
| V07 | 두 결정 동시/동일 재요청·수정 후 새 제출에 옛 ID 완료·응답 유실 → 단일 효과,409/조회로 확정 결과 확인, 새 제출은 pending 유지 | D03 |
| V08 | 제출·결정·stage·Event·wake 사이 실패 주입 → 전부 rollback. org 전이와 wake FK/agent admission 경합 → deadlock 없는 직렬화 및 중복 run 방지 | D02–D04 |
| V09 | Inbox→결과 검토→산출물→복귀/직접 URL·390px·긴 요약, 빈/로딩/404/오류·의견 공백·전송 실패 → 내용 접근·초안 유지·명시 결정·서버 receipt | D06; AC5 |
| V10 | 다른 탭에서 결정/재제출·조직 전환·재연결 → 해당 제출/조직/Inbox 갱신, 다른 제출에 이전 의견이나 mutation 반영 없음. 옛 제출 원문·결정은 다시 읽을 수 있음 | D03,D06 |

위 V는 **구현 시 검증할 제품 시나리오**이며 이번 조사에서 제품 API/E2E를 실행한 결과가 아니다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 결과 검토 중 새 실행 시도 | 사용자 / #57 | 기존 #49 admission 금지 목록은 paused/stopped/completed이며 result_review는 포함하지 않는다. ① 기존대로 조회·Lead 답장 가능한 실행 허용(연구 쓰기는 닫힘) ② 검토 중 모든 admission 보류. ②는 사용자 지도 편집이 Lead를 깨우는 #56 계약과 함께 결정. 임의로 freeze를 추가하지 않음(E01,E02,E04) |
| 최종 완료 전에 이미 admission된 run | 사용자 / #57, 취소 기반 #59 | ① 새 admission·연구 쓰기는 막고 기존 run은 자연 종료 ② 완료 때 취소 요청하고 settle 관찰. claim 뒤 adapter 호출 전인 run도 이 범주다. 취소를 선택해도 stage fence를 대신하지 않으며 org→run 역순 잠금 주의(E07,E16) |
| Owner API의 실제 신뢰경계 | 사용자 / #57, 실제 adapter 도입 전 해결 | ① Owner credential/session과 agent 접근 차단을 제품에 구현 ② 가짜 실행기·신뢰된 로컬 운영 한계를 명시하고 실제 adapter 전에 인증/네트워크 격리를 별도 해결. ② 상태에서 임의 HTTP를 쓰는 agent까지 최종 완료 우회가 불가능하다고 보고할 수 없음(E03,E12) |

후속은 #58 선택 승인 정책, #59 일반 일시정지/중단/취소, #60 heartbeat·재시작 재처리, #61 outbox·읽음/보관·실패 Inbox, #63 전체 데모/E2E다. #57의 pending 결과 Inbox·영속 수정 wake·completed admission 거부는 후속으로 미루지 않는다.

## 사용자 API 신뢰경계 추가 조사

조사일 2026-10-21. 열린 결정 "Owner API의 실제 신뢰경계"를 위해 운영자 웹 UI를 가진 self-hosted 도구를 추가로 봤다. 상세는 `.reference-cache/issue-57/selfhost/owner-auth-survey.md`(git 무시)이며 아래는 고정 SHA 원문에서 확인한 요지다.

| 도구 | 관찰 | 출처 |
|---|---|---|
| Paperclip | `local_trusted`는 loopback bind·로그인 없음이고 bearer 없는 요청을 모두 board(관리자)로 본다. `authenticated`만 로그인한다. quickstart 기본은 `local_trusted` | `paperclipai/paperclip@78b833c` `doc/DEPLOYMENT-MODES.md`, `server/src/middleware/auth.ts` L240–250 |
| Jupyter Server | 시작 때 token을 만들어 URL→HttpOnly cookie로 넘기지만 token 파일을 같은 사용자 kernel이 읽을 수 있고, 문서가 "execute 권한 ≈ 모든 권한"이라고 적는다 | `jupyter-server/jupyter_server@f8169d7` `auth/identity.py` L209–280, `docs/source/operators/security.rst` L227–231 |
| Open WebUI·Ollama | 인증을 끄면(`WEBUI_AUTH=False`) 모든 접속이 관리자이고, Ollama는 인증 없이 Origin·Host 검사만 한다 | `open-webui/open-webui@91ea4e3` `routers/auths.py` L728–758; `ollama/ollama@2cd63f7` `envconfig/config.go` L21–91 |
| n8n·Home Assistant·OpenHands | 코드 실행 쪽은 별도 프로세스·컨테이너와 전용 토큰, env 허용 목록·비밀 제거로 나눈다. OpenHands 로컬 모드는 key를 HTML에 넣어 사실상 로컬 신뢰다 | `n8n-io/n8n@1ebe2cf` `task-runner-process-js.ts` L53–90; HA developers `docs/apps/communication.md` L18–30; `OpenHands/software-agent-sdk@0996c33` `sdk/utils/command.py` L16–67 |
| Claude Code sandbox·Codex | 실행기 sandbox를 켜면 Linux/WSL2에서 host loopback 연결이 기본 차단되거나(seccomp) 네트워크가 꺼진다 | code.claude.com/docs/en/sandboxing; `openai/codex@c7234c1` `linux-sandbox/src/seccomp.rs` L100–128 |

- 같은 OS 사용자로 shell을 가진 프로그램을 운영자와 구별하는 도구는 없었다. 로그인·token을 붙여도 그 프로그램은 cookie·파일·DB(현재 embedded Postgres는 loopback `postgres/postgres`, [client.ts](../../packages/db/src/client.ts))에 닿으므로, 실제 경계는 실행 환경 격리다.
- **사용자 결정(2026-10-21):** Paperclip `local_trusted`처럼 로그인 없이 로컬 신뢰 운영으로 둔다. #57은 조직 도구·실행 토큰 경로에 완료 수단이 없음을 검증하고 이 한계를 [README](../../README.md)에 적는다. 인증·격리는 실제 모델 실행기를 붙일 때 다시 정한다.
- 미확인: Paperclip이 로컬 모드에서 실행기를 sandbox로 감싸는지, n8n runner 코드의 HTTP 호출 차단 여부, 이 WSL2 기기에서의 cookie·`/proc` 실측.

## 한계와 미확인

- 제품 코드·테스트·설정 변경이나 커밋을 하지 않았다. 제품 API·migration·테스트/typecheck/lint/build/E2E, 실제 모델/계정/유료 API·실제 연구 데이터는 실행하지 않았다. 독립 SQL10건/39assertions·Gerrit helper5건·Paperclip pure policy6건·공개 UI10캡처만 실행 근거다.
- PG 실험은 독립 fixture다. 추가 org lock과 agent/wake FK의 deadlock 반례를 실제로 확인했지만 전체 제품 lock graph를 증명한 것은 아니다. agent NO KEY UPDATE 대안은 제품 FK·active unique·앞뒤 제어 경로로 다시 검증해야 한다. 이미 admission된 실행과 물리적 adapter 시작/종료는 별도 정책이다.
- Paperclip 전체 dispatcher/HTTP·취소, Gerrit Java acceptance suite·원자성 엔진, A2A SDK/서버를 실행하지 않았다. source test를 읽은 것과 실행한 것을 구별했다. 기존 Paperclip 소스의 파일별 blob 변경 여부는 cache에 기록하고 결정에 쓴 fresh 파일을 다시 읽었다.
- assistant-ui/handup은 공식 브라우저 로컬 데모다. upstream 배포 SHA 동일성·서버 저장·인증·중복·응답 유실·권한 없음·교차 조직 stale 실화면은 미확인이다. 처음 Denied로 이름 붙인 캡처가 timer로 요청 상태에 돌아와 제외했고, clock 정지로 올바른 Denied를 다시 촬영·재열람했다. handup의 두 다른 의견 입력 run을 같은 전이로 묶지 않았다.
- Crit 공개 데모는 Loading comments에 머물러 근거에서 제외했다. Agent Inbox는 빈 shell까지만 확인했고 backend가 필요한 정상 검토는 미확인이다. GOV.UK·Review Board·MLflow·Argo·상용 GitHub mutation·기타 queue/controller는 문서 비교 범위다. 로그인·유료 경로에 들어가지 않았다.
- 후보 목록의 saturation은 조사 질문 범위의 중단 근거다. 관찰하지 않은 기능을 부재로 단정하지 않는다. 신뢰경계·검토 중 실행·기존 run 처리의 열린 결정을 해결하기 전에는 전체 제품 불변 조건을 검증 완료했다고 할 수 없다.
