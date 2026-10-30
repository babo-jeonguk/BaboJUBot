# issue-59 레퍼런스 조사: 일시정지·재개·중단과 중단하고 반영

조사일: 2026-10-22(KST). 대상: [#59](https://github.com/babo-jeonguk/BaboJUBot/issues/59), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 완료된 blocker [#53](https://github.com/babo-jeonguk/BaboJUBot/issues/53). 구현 전 조사·권고이며 확정 계약이나 구현 완료가 아니다. 상세 자료: `.reference-cache/issue-59/`(Git 무시).

## Brief

- 구현할 문제: 조직·에이전트의 일시정지와 재개, 되돌릴 수 없는 조직 중단, Lead 대화의 `중단하고 반영`을 사용자 API·Event·대시보드에서 일관되게 제공한다.
- 동종 문제: **영속 inbox를 가진 직렬 작업자의 admission을 닫고, 이미 시작한 attempt를 취소한 뒤 보존한 입력으로 재개하는 제어 프로토콜**이다. 작업자 중지, 실행 시도 취소, 조직 생애주기 종료는 서로 다른 범위다.
- 고정된 결정: [AGENTS](../../AGENTS.md), [용어](../../GLOSSARY.md), [기능](../features.md), [구조](../architecture.md), [ADR-0001](../adr/0001-adapter-control-plane.md)·[0002](../adr/0002-durable-records-and-wakes.md)를 따른다. 단일 서버·Postgres·에이전트당 실행 시도 하나·미처리 깨우기 전체 병합·기본 다음 실행 반영·가짜 프로바이더는 확정이다. 조직 잠금 → 에이전트 잠금 순서와 종료 토큰 거부를 유지한다. #57 인계에 따라 최종 완료 전에 시작한 실행 시도는 자연 종료한다. 외부 job·예산은 판 4, 재시작 입력 재처리·heartbeat는 #60, steer·실제 모델은 판 2다.
- [#58의 후속 사용자 결정](https://github.com/babo-jeonguk/BaboJUBot/issues/58#issuecomment-6333244951): 기존 작업자 추가 승인 요청은 연구 단계가 바뀌어도 결정할 수 있고, 조직 단계는 바뀌지 않는다. 과거 #58 조사 문서의 「researching에서만 worker 생성」 권고는 이 결정으로 대체됐다. 일시정지·중단 admission 차단과 기존 요청에 대한 사용자 결정은 구분한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 조직·에이전트 pause/resume/stop과 admission·깨우기 병합을 어떻게 직렬화하고 취소의 claim→등록 틈을 막는가? | #59 실행 시도 admission·AC1/3/4; #57 인계 댓글; #49 깨우기 | Source Recon + runtime/failure + 독립 동시성 probe |
| Q2 | 어느 단계에서든 pause한 뒤 직전 단계로 복귀하고 stopped를 되돌리지 않으려면 어떤 상태를 보존하고 승인·결과 결정과 어떻게 경합하는가? | #59 조직 일시정지·AC2/4; architecture 생애주기; #57 결과 검토 인계 | Source Recon + persistence/recovery + 상태 전이 비교 |
| Q3 | 취소 요청·프로바이더 종료·토큰 차단·늦은 결과를 구별하면서 겹치는 실행 시도를 막는 계약은? | #59 취소·즉시 효력; #53 프로바이더 계약·종료 토큰; AGENTS 조직 경계 | 프로토콜/계약 + Source Recon + adversarial/failure probe |
| Q4 | `중단하고 반영`의 제어 기록·메시지·깨우기를 원자적으로 남기고 후속 실행에 메시지를 전달하는 방법은? | #59 해당 항목·AC5; architecture Surface seam | Source Recon + persistence/failure + 동작 비교 |
| Q5 | 조직 대시보드·에이전트 상세·Lead 대화에서 제어 범위·전이 중·실패·좁은 폭·실시간 상태를 어떻게 구별해 보여 주는가? | #59 화면·AC6; features 화면 지도 | Surface Capture + Behavioral Recon + Source Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인·판단 |
|---|---|---|
| [#53](issue-53-references.md#brief) | admission·inbox membership·취소 settlement·종료 토큰·화면 진입점 | 후보와 파일 위치만 재사용. 이번 결정 근거는 새 SHA 원문과 blob 비교로 확인한다. |
| [#57](issue-57-references.md#brief)·[#58](issue-58-references.md#brief) | 결과 검토·최종 완료와 정책/조직 잠금의 경계 | 현재 코드와 #59 인계 댓글을 우선하며 승인·정책 자체의 재설계는 범위 밖이다. |
| [실행 모델](agent-runtime-models.md#기준-버전과-조사-방식)·[상호작용](agent-interaction-models.md#조사-방법과-표기) | Paperclip·Hermes·OpenClaw의 실행 제어 후보 | 과거 상태를 현재 보장으로 옮기지 않고 최신 고정 SHA를 읽는다. |
| [Paperclip 화면](paperclip-dashboard.md#한계)·[기타 화면](dashboard-references.md#한계)·[#50](issue-50-references.md#brief)·[#52](issue-52-references.md#brief) | 제어와 대화 화면 후보·Event 갱신 | #59/현행 features가 화면 위치의 기준이다. 캡처는 이번 직접 조작분만 근거로 쓴다. |
| [#1](issue-1-references.md#brief)·[#51](issue-51-references.md#brief)·[#54](issue-54-references.md#brief)·[#55](issue-55-references.md#brief)·[#56](issue-56-references.md#brief)·[비교 목록](comparative-survey.md)·[코드 구조](reference-code-structure.md) | 기존 조사 탐색 | 후보·경계 확인만 사용. 지도·하네스·작업의 세부 권고는 이 조사에서 재선정하지 않는다. |

## 레퍼런스

후보23행(관점·부품별 중복 포함), 심층 OSS6종·명세/공식문서2종이다. 세 관점의 전체 후보·검색 라운드는 `candidates.md`, `notes/control.md`, `notes/cancellation.md`, `notes/surface.md`에 보존한다. 포화는 이번 질문·검색 범위의 판단이며 생태계 전수조사를 뜻하지 않는다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 조직·에이전트 제어 / 큐·controller | 4라운드. agent→큐→Kubernetes/Temporal→실패 이슈로 확장. 마지막 Graphile graceful abort, pg-boss job resume, paused workflow 취소는 admission·협력 취소·종료 확인의 기존 변형이며 새 실패 유형 없음 |
| 취소 프로토콜 / 프로바이더 | 4라운드. Hermes/OpenClaw/ACP→공식 실패 이슈→Temporal/논문→소유권·settlement 이슈. 마지막 후보는 정확한 실행 소유권·늦은 결과·종료 대기 유형을 반복. 초록만 읽은 논문은 결정 근거에서 제외 |
| 운영 화면 / 대화 | 3라운드. agent 제품→workflow/retry 화면→접근성·실패/연결 표시로 확장. 마지막 W3C alert/status·연결 demo는 범위·전이·오류 알림의 기존 조합이며 새 실패 유형 없음 |

| 레퍼런스 | 분류 | 버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| Paperclip | OSS control plane | `4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f` | MIT | 소스·원문 정책 module 실행. 회사/agent hold·직전 상태·늦은 완료·종료 증거와 같은 스택의 UI를 함께 비교 |
| BullMQ | 큐 부품 | `3cd77f97f9afd3b6dfcb4fe0e1310ef660090fad` | MIT | 소스·테스트 읽기. pause가 active drain이라는 반례, 등록 전 cancel 유실·resume 뒤 실행 루프 깨우기 |
| Hermes | 프로바이더 | `4e58c721c8cf9b51c46636ea84ea6a5cb540880a` | MIT | 소스·테스트 읽기. interrupt/redirect/child scope·generation claim·비협조 도구 abandon 반례 |
| OpenClaw | gateway·프로바이더 | `1b93d1ea5dee6deaf91c28140571ba5eda00dd68` | MIT | 소스·원문 queue gate 실행. 캡처한 owner의 취소·종료 대기·빈 slot 반례 |
| ACP TypeScript SDK | adapter 계약·fixture | `c2b1a8633745dd859a2732b4e17d5ed61e869bb6` / 2.0.0 | Apache-2.0 | 소스·제한 원문 handler 실행. no-op cancel fake와 명세의 차이 |
| assistant-ui | 공개 UI 부품·scripted demo | `0dd293a8ed894f84bdd32097f841bea5dd52ae71` | MIT | 소스·공개 실화면 조작. 실패/처리중·사용자 중단·연결 복구의 표시를 비교. 공개 배포의 commit은 미공개 |
| ACP v1 명세 | 프로토콜 | `8e29db79548af94b467dcbb0cc5ffacfe68c90ab` | Apache-2.0 | 문서. cancel notification·최종 cancelled 응답·그 사이 update의 의미 |
| PostgreSQL 18 | 저장·동시성 명세 | 공식 18 문서; 실험 PG18.4 | PostgreSQL License | 문서·독립 SQL. 행 잠금 충돌·재검사·교착을 직접 비교 |

OSS와 ACP 명세의 root LICENSE를 읽었다. **설계 참고만 하며 코드 복사·새 라이브러리 도입을 권고하지 않는다.** 복사할 경우 해당 SHA의 파일 header·NOTICE·함께 들어오는 의존성을 확인하고 AGENTS의 출처·고지 규칙을 적용해야 한다.

기존 근거 재확인: Paperclip #53 대비 core/control 10파일은 동일3·변경6·과거 경로 없음1, UI5파일은 동일2·변경3이다. 추가로 `agent-run-cancellation.ts` 변경·`agent-execution-stop.ts` 동일을 메인이 확인했다. Hermes2파일·OpenClaw2파일·SDK fake는 변경되어 재독했고 ACP 취소 명세 blob은 동일했다. assistant-ui 비교 범위와 신규 파일은 surface 메모에 기록한다. 기존 문서의 Evidence ID를 이번 E로 옮기지 않았다.

## 근거

확인일은 모두 2026-10-22다. 테스트는 실행 표시가 없으면 **읽기만** 했다. 메인이 아래 결정에 쓰는 원문·실행 로그·8개 캡처를 다시 열었으며 `main-verification.md`에 대조·정정을 남겼다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 행 잠금에도 교착이 생긴다. 충돌하는 잠금은 일관된 순서로 취득해야 한다. Read Committed의 잠금 대기 뒤에는 갱신된 행과 조건을 다시 확인한다. | [PG18 row locks/deadlocks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-DEADLOCKS) · [Read Committed](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) | 문서 주장 |
| <a id="E02"></a>E02 | 독립 SQL 7시나리오·36assertions PASS. pause/claim 양방향, wake 보존·2개 병합, agent pause 독립성, 직전 5단계 복귀, terminal 거부, 두 Event와 메시지 rollback, cancel 동안 slot 유지·이후 새 메시지 전달을 확인했다. run→org 도구와 org→run 취소의 실제 `40P01` 교착도 재현했다. | `probes/postgres-control.mjs`, `postgres-control-log.txt`; Node24.21.0·PG18.4·pg8.23.1. 제품/upstream schema·API가 아닌 독립 모형 | 실행 확인 |
| <a id="E03"></a>E03 | Paperclip은 pausing→paused→resuming을 구별하고 재개 완료 시 저장한 preparing/verifying/ready로 복귀한다. 종료 단계의 resume은 conflict다. pending_approval pause는 허용하지 않아 #59의 모든 비종료 단계 요구와 그대로 같지 않다. | [transition](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/modules/agent-lifecycle/domain/policy.ts#L17-L45) | 소스 확인 |
| <a id="E04"></a>E04 | agent resume은 회사/budget hold를 남긴다. 회사 pause transaction에서 활성 agent의 stop 소유권을 기록해 빠른 재활성화가 진행 중 pausing을 지우지 못하게 한다. | [holds·resumeState](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/modules/agent-lifecycle/adapters/postgres.ts#L33-L81) · [company fence](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/modules/agent-lifecycle/adapters/company-policy.ts#L53-L72) | 소스 확인 |
| <a id="E05"></a>E05 | lifecycle 완료는 version·lease owner·host/plugin 완료를 검사한다. terminal run도 provider/process·lease·취소 확인이 남으면 실제 종료가 아니다. ready commit 뒤 backlog dispatch를 별도로 호출한다. late completion 거부 테스트가 있다. | [completion guard](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/modules/agent-lifecycle/adapters/postgres.ts#L17-L24) · [stop proof](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/services/agent-execution-stop.ts#L9-L64) · [onReady](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/modules/agent-lifecycle/application/worker.ts#L61-L70) · [late completion test](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/modules/agent-lifecycle/__tests__/lifecycle.test.ts#L670-L683) | 소스 확인 |
| <a id="E06"></a>E06 | 비활성 회사에서 user wake는409, system wake는 skipped 기록 후 반환한다. #59의 미처리 wake 보존 경로로 그대로 쓸 수 없다. | [inactive wake](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/services/heartbeat/queue.ts#L2481-L2497) | 소스 확인 |
| <a id="E07"></a>E07 | BullMQ pause는 active 작업을 취소하지 않는다. cancelJob은 등록된 controller에만 abort하며 등록 전이면 false다. resume은 paused=false와 별도로 main loop를 깨운다. 이 깨우기가 없던 회귀를 테스트한다. | [pause](https://github.com/taskforcesh/bullmq/blob/3cd77f97f9afd3b6dfcb4fe0e1310ef660090fad/src/classes/worker.ts#L1254-L1294) · [cancelJob](https://github.com/taskforcesh/bullmq/blob/3cd77f97f9afd3b6dfcb4fe0e1310ef660090fad/src/classes/lock-manager.ts#L187-L200) · [resume kick](https://github.com/taskforcesh/bullmq/blob/3cd77f97f9afd3b6dfcb4fe0e1310ef660090fad/src/classes/worker.ts#L1322-L1331) · [test](https://github.com/taskforcesh/bullmq/blob/3cd77f97f9afd3b6dfcb4fe0e1310ef660090fad/tests/pause.test.ts#L445-L493) | 소스 확인 |
| <a id="E08"></a>E08 | Paperclip은 취소 requested/cancelled의 쓰기를 실행 시도 행 FOR SHARE 아래 차단한다. 그러나 성공/실패/없는 run을 이 predicate가 모두 거부하는 것은 아니며 특정 stop mutation 예외도 있다. BaboJUBot의 종료 토큰 읽기 포함 거부보다 약한 계약이다. | [agentRunWritesRevoked·assertAgentRunWriteAllowed](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/server/src/agent-run-cancellation.ts#L5-L37) | 소스 확인 |
| <a id="E09"></a>E09 | Hermes interrupt는 generation claim을 최종 mutation에서 재확인하고 실행 thread·tool worker·child로 취소를 전한다. redirect는 같은 logical turn의 모델 요청만 취소하거나 도구 중 steer/yield로 낮춘다. 오래된 redirect는 새 turn의 reply anchor를 바꾸지 못한다. | [interrupt](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/agent/interrupt_control.py#L163-L270) · [redirect](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/agent/interrupt_control.py#L323-L384) · [identity guard](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/gateway/run_busy.py#L741-L769) | 소스 확인 |
| <a id="E10"></a>E10 | 비협조 도구는 grace 뒤 synthetic cancelled를 돌려주고 daemon worker를 기다리지 않는다. 테스트는 30초 sleep 도구를 10초 이내 abandon함을 assert하며 물리 도구 종료를 보장하지 않는다. | [tool executor](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/agent/tool_executor.py#L938-L1003) · [test](https://github.com/NousResearch/hermes-agent/blob/4e58c721c8cf9b51c46636ea84ea6a5cb540880a/tests/agent/test_sequential_tool_interrupt.py#L52-L129) | 소스 확인 |
| <a id="E11"></a>E11 | ACP cancel은 notification이다. ongoing 작업 abort와 pending update 전송 뒤 원래 prompt에 cancelled로 응답해야 한다. 그 응답 전 update는 올 수 있다. | [v1 Cancellation](https://github.com/agentclientprotocol/agent-client-protocol/blob/8e29db79548af94b467dcbb0cc5ffacfe68c90ab/docs/protocol/v1/prompt-turn.mdx#L549-L586) | 문서 주장 |
| <a id="E12"></a>E12 | SDK fake는 chunk loop 뒤 end_turn을 반환하고 cancel handler는 no-op이다. SDK 예제는 별도 AbortController를 써야 cancelled로 끝난다. | [fake](https://github.com/agentclientprotocol/typescript-sdk/blob/c2b1a8633745dd859a2732b4e17d5ed61e869bb6/src/test-support/test-agent.ts#L57-L122) · [example cancel](https://github.com/agentclientprotocol/typescript-sdk/blob/c2b1a8633745dd859a2732b4e17d5ed61e869bb6/src/examples/agent.ts#L263-L295) | 소스 확인 |
| <a id="E13"></a>E13 | 원본 fake handler 실행 2cases·6assertions PASS. 첫 chunk 뒤 cancel을 전달해도 나머지 chunk와 end_turn이 나왔다. builder·상수만 stub했으며 실제 transport/HTTP·모델은 실행하지 않았다. | `probes/acp-fake-cancel.mjs`, `acp-fake-cancel-log.txt`; Node24.21.0 | 실행 확인(제한) |
| <a id="E14"></a>E14 | OpenClaw는 정확히 캡처한 owner를 중단하고 owner/native attempt 종료를 기다린다. 빈 slot도 writer 종료 증거가 아니므로 unsettled면 새 입력을 거부하고, settled 뒤에도 busy를 다시 검사한다. | [captured admission](https://github.com/openclaw/openclaw/blob/1b93d1ea5dee6deaf91c28140571ba5eda00dd68/src/auto-reply/reply/get-reply-run-admission.ts#L588-L644) · [queue gate](https://github.com/openclaw/openclaw/blob/1b93d1ea5dee6deaf91c28140571ba5eda00dd68/src/auto-reply/reply/get-reply-run-queue.ts#L9-L35) | 소스 확인 |
| <a id="E15"></a>E15 | 원본 queue gate 직접 import 3cases·6assertions PASS. unsettled+빈 slot 거부, settled+busy 거부, settled+idle 허용과 interrupt→refresh→recheck 순서를 확인했다. callback은 stub이며 실제 controller/process 종료 실행은 아니다. | `probes/openclaw-cancellation.mjs`, `probes/run-log.txt`; Node24.21.0 | 실행 확인(제한) |
| <a id="E16"></a>E16 | Paperclip 순수 정책 module 직접 import 21assertions PASS. pause·직전 3상태 복귀·종료4상태 resume 거부·pending_approval pause 거부를 확인했다. DB/host와의 통합 보장은 아니다. | `probes/paperclip-lifecycle-policy.mjs`, `control-run-log.txt`; Node24.21.0 | 실행 확인(제한) |
| <a id="E17"></a>E17 | Paperclip UI는 요청중·lifecycle 전이 중 pause/resume을 막고 성공 뒤 상세/list/run query를 재조회한다. 대시보드 bulk resume는 agent별 실패를 허용하는 순차 호출이다. composer stop과 draft 제출도 별도이며 이 UI만으로 중단+메시지 원자성을 만들 수 없다. | [action·invalidate](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/ui/src/components/AgentActionButtons.tsx#L242-L298) · [gate](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/ui/src/components/AgentActionButtons.tsx#L372-L376) · [bulk resume](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/ui/src/pages/Dashboard.tsx#L96-L118) · [stop hook](https://github.com/paperclipai/paperclip/blob/4dfcb4c9b8043d7fadaaed5f6cbab0c1e5cf8f2f/ui/src/hooks/useComposerStop.ts#L3-L26) | 소스 확인 |
| <a id="E18"></a>E18 | assistant-ui의 실패와 재시도중은 alert/status로 분리된다. demo Retry는 로컬1600ms timer, StoppedRun Continue/Discard는 callback 없음, ConnectionState는 timer다. 장식 Pause 도형은 버튼이 아니다. | [error element](https://github.com/assistant-ui/assistant-ui/blob/0dd293a8ed894f84bdd32097f841bea5dd52ae71/packages/ui/src/components/react/assistant-ui/elements/error-state.tsx#L26-L73) · [retry demo](https://github.com/assistant-ui/assistant-ui/blob/0dd293a8ed894f84bdd32097f841bea5dd52ae71/apps/docs/components/demo/elements/error-state.tsx#L6-L22) · [stopped demo](https://github.com/assistant-ui/assistant-ui/blob/0dd293a8ed894f84bdd32097f841bea5dd52ae71/apps/docs/components/demo/elements/stopped-run.tsx#L6-L12) · [connection demo](https://github.com/assistant-ui/assistant-ui/blob/0dd293a8ed894f84bdd32097f841bea5dd52ae71/apps/docs/components/demo/elements/connection-state.tsx#L9-L20) · [Pause span](https://github.com/assistant-ui/assistant-ui/blob/0dd293a8ed894f84bdd32097f841bea5dd52ae71/packages/ui/src/components/react/assistant-ui/elements/agent-status.tsx#L65-L77) | 소스 확인 |
| <a id="E19"></a>E19 | 공개 demo를 직접 조작해 1440/390px에서 8캡처를 확인했다. Retry→처리중→실패 복귀, 부분 답장·사용자 중단 이유, 연결 상실/복구 표시를 관찰했다. Continue/Discard 클릭은 변화가 없었다. 실제 backend 재개·취소나 socket 복구의 증거는 아니다. | [error-state](https://www.assistant-ui.com/elements/error-state) · [stopped-run](https://www.assistant-ui.com/elements/stopped-run) · [connection-state](https://www.assistant-ui.com/elements/connection-state); `captures/captures.md`, `probes/surface-capture-log.json` | 실행 확인(표시·scripted 조작) |

근거19개: 문서 주장2·소스 확인12·실행 확인5. 실행 확인 행마다 범위가 다르므로 upstream 통합 테스트 통과로 합산하지 않는다.

## 패턴

아래 패턴과 결정은 근거에서 도출한 **추론·권고**다.

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | admission을 영속 상태로 닫고 입력은 보존 | E02,E04,E06,E07 | Paperclip inactive wake는 skipped, BullMQ pause는 active drain. BaboJUBot은 pending wake 보존+active 취소 | 재개 때 입력 복원·병합 가능 | flag만 메모리에 두거나 wake 생성을 막으면 유실. resume 저장만 하고 dispatch를 깨우지 않으면 정체 |
| <a id="P02"></a>P02 | 직전 단계와 정지 원인을 별도 보존 | E02–E04,E16 | Paperclip의 executor lifecycle와 우리 연구 생애주기는 상태 집합이 다름 | pause 반복·org/agent pause 중첩에도 정확한 복귀 | 조직 resume이 개별 pause까지 해제하거나 prior를 paused로 덮으면 잘못 실행 |
| <a id="P03"></a>P03 | 취소 요청·권한 차단·프로바이더 종료를 분리 | E05,E08,E10–E15 | ACP는 최종 응답 전 update 허용, Hermes는 도구 abandon, OpenClaw는 owner 종료 대기 | 즉시 제품 효력과 프로바이더 정리 시간을 함께 표현 | abort 호출·terminal DB 상태·빈 Map을 실제 종료 증거로 쓰면 겹침·늦은 쓰기 가능 |
| <a id="P04"></a>P04 | 취소 대상을 정확한 실행 시도·소유권으로 고정 | E04,E05,E07,E09,E14 | generation/version/owner는 구현 수단이며 연구 판단을 맡는 프롬프트가 아님 | 오래된 제어/완료가 새 실행을 건드리지 못함 | claim commit→controller 등록 틈에서 취소 유실; 빠른 resume이 기존 취소를 지울 위험 |
| <a id="P05"></a>P05 | 중단 제어와 새 입력을 각각 기록하되 함께 저장 | E02,E09,E14,E17; #59 AC5 | Hermes redirect는 same-turn, UI stop hook은 별도 호출. 두 방식 모두 #59의 두 기록+후속 실행과 동일하지 않음 | 입력·제어·감사 기록의 원자성, 메시지 유실 방지 | stop HTTP 성공 뒤 message HTTP 실패하면 방향 전환 내용 유실; 새 실행을 먼저 깨우면 기존 실행과 중첩 |
| <a id="P06"></a>P06 | 명령 범위·요청중·확정 상태·연결 상태를 구별 | E17–E19 | bulk agent resume와 조직 resume, retry와 resume, stream 복구와 연구 재개는 서로 다름 | 사용자에게 제어가 어디에 적용됐는지 명료 | 장식 icon·no-op callback·scripted 배너를 실제 제어 동작으로 오해 |
| <a id="P07"></a>P07 | 새 취소 경로를 포함해 전체 잠금 순서를 검토 | E01,E02; 현행 `toolWrite` | 기존 claim은 org→agent, tool write는 run→org. org→run 취소를 단순 추가하면 역순 | admission/쓰기/취소 경합을 DB에서 강제 | 단순 transaction 분리는 교착만 피하고 권한 차단 원자성의 빈틈을 남길 수 있음 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 현재 `claimNextRun`의 조직 잠금→agent 잠금·미처리 wake 전체 묶음을 유지하고 agent pause 검사를 추가한다. 조직 paused/stopped/completed 또는 agent paused에서는 wake를 소비하지 않는다. 조직 제어를 agent API 순회로 구현하지 않는다. | P01,P02; #59 AC1/3/4 | 조직 상태 하나로 즉시 admission을 닫아 부분 성공을 피함. 다른 agent·다른 조직은 계속 진행 | Q1,Q2 |
| <a id="D02"></a>D02 | 변형 채택 | 조직 pause는 비종료 단계와 prior stage를 원자적으로 기록하고 반복 pause로 prior를 덮지 않는다. resume은 그 단계만 복원하며 개별 agent pause는 유지한다. stopped는 재개 불가다. 단계 변경을 동반하는 초기 승인·결과 결정의 paused 동작은 아래 선택을 명시한다. | P02; #59 AC2/4; #58 후속 결정 | Paperclip 상태 이름/허용표를 복사하지 않음. 기존 add_worker pending의 단계무관 사용자 결정은 유지하고 그 wake는 admission에서 막음 | Q1,Q2 |
| <a id="D03"></a>D03 | 변형 채택 | 제어 transaction에 대상 run ID·취소 요청·Event를 영속화하고 commit 뒤 해당 controller로 보낸다. controller 등록 시 취소 의도를 재확인해 claim→등록 틈을 닫는다. 빠른 resume도 이미 요청한 취소를 지우지 않는다. 프로바이더 정리·종료 저장 전에는 그 agent의 실행 slot을 유지한다. | P03,P04; E05,E07,E14–E16 | 단일 서버에 필요한 최소 intent·run identity를 우선. Paperclip 전체 lease/plugin/provider 상태기를 들여오지 않음. 취소 무응답을 정상 종료로 간주하지 않음 | Q1,Q3 |
| <a id="D04"></a>D04 | 채택 | 취소를 추가하기 전에 도구·admission·제어·종료의 잠금 graph를 정리한다. org→agent→run 순서를 선택한다면 충돌하는 기존 run→org 도구 쓰기도 함께 조정하고 잠금 뒤 신원/권한/상태를 다시 검사한다. 대안으로 단계를 나누려면 같은 시점부터 모든 읽기·쓰기 권한을 막는 별도 검증 근거가 필요하다. | P07; E01,E02 | org 잠금 안에서 run UPDATE만 추가하는 안은 실제 교착. SQL 모형의 org commit→run fence 분리는 교착 해소만 확인했으며 완전한 취소 프로토콜 권고가 아님 | Q1,Q3,Q4 |
| <a id="D05"></a>D05 | 채택 | `중단하고 반영`은 사용자 전용 한 명령 경로에서 run 취소 제어 기록·사용자 메시지·wake와 제어/메시지 두 Event를 같은 transaction에 남긴다. commit 전 취소 신호를 보내지 않는다. 다음 실행은 정리 완료 뒤 새 메시지를 wake reason으로 받는다. org stop이나 영속 agent pause로 바꾸지 않는다. | P05; #59 AC5; E02 | 별도 두 HTTP 호출의 부분 실패 방지. 정상 run.finished/activity Event는 두 필수 Event와 별도로 생길 수 있음. 실행 중인 run이 없을 때의 제어 결과도 명시적으로 기록 | Q1,Q3,Q4 |
| <a id="D06"></a>D06 | 변형 채택 | 취소가 확정된 실행 시도의 조직 도구 권한은 즉시 닫고 기존 종료 토큰의 읽기 포함 거부를 유지한다. 인증만 통과한 오래된 요청도 실제 쓰기 시 재검사한다. 늦은 adapter 결과가 수락된 취소를 성공으로 덮거나 새 실행의 상태를 바꾸지 못하게 한다. 이미 commit된 부작용을 취소가 되돌린다고 표시하지 않는다. | P03,P04; E08–E15; #53 계약 | 취소 전달과 제품 권한 차단은 다른 보장. 공개 활동·usage 수집 허용 범위는 명시하되 provider 내부 추론을 공개 로그로 옮기지 않음 | Q3,Q4 |
| <a id="D07"></a>D07 | 채택 | resume commit 뒤 실행 가능한 agent를 다시 촉진하고, 아직 취소 정리 중이면 정리 완료 뒤 재검사한다. pending wake 전체를 하나로 묶는다. 중단 조직의 wake는 새 실행을 만들지 않는다. 취소된 run에 이미 묶인 입력을 자동 복제하는 재시도 정책은 이번에 추정하지 않는다. | P01,P03,P04; E02,E05,E07,E14 | 상태만 active로 보여 주고 dispatcher가 잠드는 회귀 방지. 재시작 입력 재처리·자동 재시도/부작용 중복은 후속 #60 | Q1,Q3,Q4 |
| <a id="D08"></a>D08 | 변형 채택 | 고정된 화면 위치에서 조직·agent·run 제어 범위를 이름으로 표시한다. 요청중·서버 확정 pause/stop·프로바이더 취소중을 구별하고, 응답/Event/재연결 뒤 관련 조직 query를 재조회한다. 실패시 메시지 초안·전달 방식을 유지한다. 390px에서도 명령 이름/접근성 이름과 중단 이유·부분 공개 활동을 읽을 수 있게 한다. | P06; E17–E19; features | 실제 캡처는 실패/부분 답장/연결 표시의 참고다. 조직 dashboard·agent pause·mode selector의 구체 배치와 서버 동작은 구현 때 검증. stream 재연결을 연구 재개로 표시하지 않음 | Q4,Q5 |
| <a id="D09"></a>D09 | 채택 | 가짜 프로바이더의 실제 조직 도구 HTTP와 제어 API로 pause/resume/stop·중단하고 반영·조직 경계를 검증한다. cancellation gate로 종료를 보류하고 그 사이 새 실행0·늦은 쓰기 거부를 관찰한다. 응답유실·rollback·양방향 경합도 같은 API seam에서 확인한다. | P01–P07; #49 Testing Decisions; AGENTS | 독립 probe·OSS source test를 제품 AC 통과로 대신하지 않음. 아래 V는 제안이며 이번 제품 테스트 실행 결과가 아님 | Q1–Q5 |
| <a id="D10"></a>D10 | 배제 | 새 queue/workflow/메모리 제품, 같은 turn steer/redirect, agent subtree 일괄 취소, pause=drain, 임의 timeout 뒤 성공 간주, stopped 조직 Continue/Undo를 들여오지 않는다. 외부 job 취소는 판4, heartbeat·재시작 복구는 #60, 실제 adapter·steer는 판2다. | P01–P06; ADR1/2; #49 범위 | 예산·provider/process kill·재시도 정책과 이번 가짜 실행 제어를 섞지 않음. 사용자 최종 완료·승인·조직 경계를 우회하는 정책 없음 | Q1–Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| paused 입력을 skipped 처리하거나 active를 자연 종료만 시킴 | Paperclip E06·BullMQ E07 | #59는 깨우기 보존+진행 중 실행 시도 취소 |
| paused=false 또는 active Map 부재만으로 다음 실행 시작 | E05,E07,E10,E14 | dispatcher kick·프로바이더 종료는 별도 확인 필요 |
| run→org 도구를 둔 채 org→run 취소 추가 | E01,E02 | 실제 `40P01` 교착; 기존 조직 잠금만의 해결 범위를 넘음 |
| UI의 stop과 submit을 별도 요청으로 이어 붙임 | E17; #59 AC5 | 메시지 실패 뒤 취소만 적용되는 부분 성공 |
| 같은 logical turn redirect·비협조 도구 abandon을 완전 취소로 채택 | E09,E10 | 새 실행 시도 계약·물리 종료와 의미가 다름 |
| 회사/agent archive를 영구 조직 stop으로 전용 | E03,E04 | 우리 stopped는 되돌릴 수 없는 종료. 최종 완료 전 active run 자연 종료 결정도 별도 보존 |
| bulk resume·no-op Continue·장식 Pause를 조직 명령으로 사용 | E17–E19 | 부분 성공·표시용 callback·잘못된 제어 범위 |

## 구현 참고

권고의 핵심은 **영속 admission·취소 요청·입력 보존 → 프로바이더 정리 → 다음 실행**의 순서다. 상태 이름·추가 열·API URL은 구현 계약에서 정하되 아래 책임 경계를 유지한다.

| 위치 | #59에서 검토할 책임 |
|---|---|
| `packages/contracts`·`packages/core` | 제어 명령·메시지 전달 방식·Event·취소 사유·agent pause/조직 prior stage의 계약과 전이. 종료 토큰 규칙 유지 |
| `packages/db` | 현재 `runs.ts`, `rows.ts`, `tool-calls.ts`의 admission/쓰기/종료 잠금 graph; 제어·메시지·wake·Event 원자성, 교차 조직 참조 거부. schema/migration은 여기서 소유 |
| `packages/db/src/approvals.ts`·`results.ts` | paused/stopped에서 pending 초기 승인·결과 결정의 정상 거부/전이 처리. 기존 stage mismatch throw500 조정. add_worker의 단계무관 결정은 보존 |
| `apps/server`·`packages/runtime` | 사용자 전용 제어 route·dispatcher의 exact run 취소·등록 후 의도 재검사·정리 후 촉진. fake의 abort/gate·실제 조직 도구 HTTP. Control Plane이 상태 변경 원본이며 Runtime이 연구 상태를 직접 바꾸지 않음 |
| `apps/web` | 조직 dashboard·agent 상세·Lead 대화와 기존 Event→query invalidation. Surface에 승인·admission·조직 경계 강제를 맡기지 않음 |

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 조직A 실행 중 pause → 취소 관측·새 run0 → 여러 종류 pending wake → resume/정리 완료 뒤 agent별 한 실행에 전체 전달. 조직B는 계속 실행 | D01,D03,D07 |
| V02 | 비종료 5단계 각각 pause/pause/resume → 원래 단계 정확 복귀, 반복 pause가 prior 훼손0. resume 중 다시 pause/stop도 늦은 완료가 되돌리지 않음 | D02,D03,D06 |
| V03 | agent A만 pause → A active 취소·A wake 보존, 같은 조직 B 실행 유지. 조직 pause/resume 뒤 A의 개인 pause 유지, agent resume만으로 조직 pause 해제0 | D01,D02 |
| V04 | claim 직전/commit 직후/controller 등록 전/adapter 호출 직전 pause·stop·interrupt → 취소 유실0, 이미 끝난 run 대상 제어가 새 run 취소0 | D03,D06 |
| V05 | stop 이후 모든 wake 종류·직접 API·서버 재시작·resume → 새 run0·복귀 불가. stopped·타조직 ID·없는 ID의 선택한 응답 계약 일치 | D01,D02,D09 |
| V06 | 실행 중 `중단하고 반영` → 제어/메시지 두 필수 Event·같은 조직 귀속·메시지1/wake1; 기존 run 정리 뒤 다음 wake reason에 본문. 조직/agent는 사용 가능한 상태 유지 | D05,D07 |
| V07 | 제어/메시지/wake/Event 각 저장 실패 → 전체 rollback·취소 미전달. commit 뒤 publish/kick/응답 유실 → 저장된 결과 조회로 확인, 선택한 재전송 계약대로 중복 제어/메시지 방지 | D03,D05,D09 |
| V08 | 취소된 run이 old token으로 읽기/답장/작업/결과 쓰기·인증 후 지연된 도구 tx·늦은 adapter completed → 권한 차단·제품 상태/새 run 불변. 이미 완료된 쓰기는 유지 | D04,D06 |
| V09 | 조직 도구에 사용자 pause/resume/stop 우회 명령 없음·A 토큰+B run/agent ID·body org/actor 위조 → scope 거부. local_trusted 사용자 API에 같은 OS 프로그램이 임의 요청하는 행위까지 차단한다고 주장하지 않음 | D06,D09; architecture 사용자 API 경계 |
| V10 | 도구 쓰기↔조직 pause·agent pause·interrupt 양방향 경합, control↔finish·resume↔stop 경합 → 교착0·한 번의 일관된 승자, 불완전한 취소/늦은 성공 없음 | D03,D04,D06 |
| V11 | awaiting_approval/result_review pause 중 초기 승인·결과 결정·resume 경합 → 선택한 계약의 충돌/전이와 Event, 정상 사용자 동작500 없음. add_worker pending 결정은 단계무관 유지·paused/stopped/completed 새 run0 | D02,D07; #57 인계·#58 결정 |
| V12 | adapter가 취소 후 정리 gate에서 지연/오류 → 제어 상태 즉시 관측·기존 slot 유지·다음 run0. gate 해제 뒤 한 번 종료 저장 후 전달. DB 종료 저장 재시도도 adapter 재실행0 | D03,D06,D07 |
| V13 | dashboard/agent 상세/Lead 대화에서 범위별 제어·1440/390px·요청중/실패/409 → 명령 식별·초안/전달방식 보존·terminal 재개 없음·접근성 이름과 오류/상태 알림 | D08,D09 |
| V14 | 두 탭·Event 재연결·조직A→B 이동 중 늦은 응답 → 해당 조직 query만 확정값으로 수렴, 연결 복구를 연구 재개로 표시0. 기존 최종 완료 자연 종료 결정 회귀0 | D02,D06,D08 |

### 열린 결정

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| paused 중 초기 연구 승인·결과 검토 결정 | 사용자 / #59 | **권고:** 해당 단계 변경 결정은409로 보류하고 재개 후 결정. **대안:** 결정은 저장하되 조직 paused는 유지하고 prior stage·승인 적용을 함께 갱신. 후자는 승인/사본/결과와 복귀 목표의 원자성·중단 경합을 더 검증해야 한다. 기존 add_worker pending 단계무관 결정은 이 선택의 대상이 아니다(D02) |
| 「어느 단계」에 최종 완료까지 포함하는가 | 사용자 / #59 | **권고:** 모든 비종료 단계에서 pause/stop을 제공하고 completed/stopped에서는 종료를 보존. **대안:** completed 위 표시용 정지 상태를 허용하되 completed의 admission 차단과 #57 active run 자연 종료는 유지. stopped의 재개·재활성화는 어느 안에서도 허용하지 않음 |
| 취소된 run의 기존 입력 재처리·비협조 프로바이더 timeout | #60 / 실제 adapter 판2 | #59의 미처리 wake 보존은 확정. 이미 run에 묶인 wake 자동 복제는 재시도 정책을 정하기 전 도입하지 않는 안을 권고. 재처리하려면 부작용 중복/멱등성 계약 필요. 실제 adapter의 grace/강제 process 종료·실패 보고도 종료 확인을 생략하는 근거로 쓰지 않음 |

## 한계와 미확인

- 실행한 것은 독립 SQL 모형과 제한 원문 module/handler **4개 probe·69assertions**, 공개 scripted UI **8캡처**다. PG36·ACP fake6·OpenClaw gate6·Paperclip policy21이며 제품/API·OSS 전체 통합 테스트 통과를 뜻하지 않는다.
- Paperclip 전체 앱/DB suite·BullMQ Redis suite·Hermes/OpenClaw 전체 실행·ACP 실제 transport·실제 process/외부 job 취소·강제 crash·부하·외부 PG는 실행하지 않았다. 제품 코드·테스트·설정은 변경하지 않았고 제품 test/typecheck/lint/build/E2E도 실행하지 않았다.
- 화면은 공개 demo의 실패·처리중·부분 답장·연결 상태만 직접 확인했다. 조직 pause/resume/stop, agent 제어, 전달방식 selector의 실제 API 동작·권한없음·빈/로딩 상태·다른 탭 실시간 갱신·구체 배치는 미확인이다. assistant-ui 공개 배포 SHA는 미공개여서 고정 참조 소스와 완전 일치를 주장하지 않는다. Continue/Discard no-op, 장식 Pause, timer 연결복구를 실제 제품 제어로 세지 않았다.
- 최초 sandbox PG 실행의 빈 로그는 성공에서 제외했다. 공개 UI의 systemd bus/브라우저 library 오류는 Docker2GiB·무키셸·기존 Chromium의 읽기 전용 library mount로 해결했고, desktop Retry 캡처는 상태가 실제 보이도록 1장 정정했다. provider 사용량 한도로 중단된 기존 작업자 세 명을 사용자 요청 후 같은 ID로 재개했다. 자동 승인 검토의 사용량 오류였던 공개 read도 복구 뒤 정상 재시도했으며 미해결 정책 거부는 없다.
- 신규 설치는 브라우저용 임시 디렉터리의 Playwright(ignore-scripts)에 한정했다. DB·브라우저/container는 정리했다. 실제 모델·로그인·유료 API·실제 연구 데이터·비밀 자격 증명은 사용하지 않았다.
- 구현 계약을 확정할 때 위 열린 정책을 Issue에 기록한다. upstream 변경 시 고정 SHA와 비교하고, 코드 재사용을 선택하면 header/NOTICE/의존성과 출처 고지를 별도로 확인한다. 이 문서는 커밋하지 않고 구현 변경과 함께 검토하도록 남긴다.
