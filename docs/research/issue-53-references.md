# issue-53 레퍼런스 조사: Lead 대화로 첫 실행 시도

조사일: 2026-10-18(KST). 대상: [#53](https://github.com/babo-jeonguk/BaboJUBot/issues/53), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 완료된 blocker [#52](https://github.com/babo-jeonguk/BaboJUBot/issues/52). **구현 전 권고이며 확정 계약이나 구현 완료가 아니다.** 상세 자료: `.reference-cache/issue-53/`(Git 무시). 제품 코드·테스트·설정은 변경하지 않았다.

## Brief

- 구현할 문제: 사용자 메시지를 저장하고 Lead를 깨워 가짜 프로바이더를 호출한다. 가짜 프로바이더는 실행 시도별 토큰으로 실제 조직 도구 HTTP를 호출해 답장한다. 채팅·활동·실행 시도 상세·에이전트 상세에서 같은 기록을 관찰한다.
- 동종 문제: **영속 입력 inbox를 에이전트 키로 직렬화하고 실행 단위 권한으로 부작용을 기록하는 비동기 작업 처리**다. 큐의 중복 제거, 입력 보존, 실행 직렬화는 서로 다른 보장이다.
- 고정된 결정: [AGENTS](../../AGENTS.md), [용어](../../GLOSSARY.md), [기능](../features.md), [구조](../architecture.md), [ADR](../adr/)를 따른다. Postgres 행 잠금·에이전트당 동시 실행 시도 하나·미처리 깨우기 전체 묶음·실행 중 입력의 다음 실행 이월은 #53 계약이다. scope는 토큰에서만 정하고 종료 토큰은 읽기 포함 조직 도구에서 거부한다. 타조직 기록 ID와 없는 ID는 구별하지 않는다.
- Node24/TypeScript/Express/ws/Postgres/Drizzle/React/Query/zod와 단일 서버 프로세스는 확정이다. 실제 모델·자체 agent loop·새 queue 인프라를 도입하지 않는다. 승인 전 Lead 목표 대화는 가능하지만 연구 작업·작업자 생성은 승인 이후다. 화면 C와 별도 상세 경로는 유지한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 여러 dispatcher에서도 agent당 실행 하나, 전체 미처리 묶음, 실행 중 입력 이월을 어떻게 보장하는가? | #53 깨우기 범위·AC2; #49 stories31/32/35 | Source Recon + runtime/failure + PG 동시성 실행 |
| Q2 | 메시지·깨우기·실행 시도·활동의 원자성과 실패/종료 경계, 후속 복구에 필요한 최소 기록은? | #53 AC1/2; #49 영속 기록·Testing Decisions; #60 | Source Recon + persistence/recovery |
| Q3 | 요청·활동·종료·취소 계약과 fake/clock/drain을 실제 HTTP 경로에서 어떻게 검증하는가? | #53 실행 계약·가짜 프로바이더·테스트 도구; #49 Testing Decisions | protocol/contract + Source Recon + Behavioral Recon |
| Q4 | 종료 토큰·신원 위조·교차 조직 참조·로그 노출을 어디서 거부하는가? | #53 조직 도구·AC3/4; AGENTS | Source Recon + adversarial scenario + 제한 token 실행 |
| Q5 | 채팅 저장/처리 상태·활동·실행 transcript·agent 상태/최근 run 연결을 어떻게 구별하는가? | #53 화면·AC5/6/7; features 화면 지도 | Source Recon + 공개 실화면 조작 |
| Q6 | 중복·역순·재연결·조직 전환·취소/오류에도 공개 활동만 일관되게 표시하는가? | #53 공개 활동 AC; AGENTS 관찰; #52 WS | Source Recon + protocol/failure + 공개 상태 표시 조작 |

| 재사용한 조사 | 쓰는 범위 | 재확인·판단 |
|---|---|---|
| [실행 모델](agent-runtime-models.md#기준-버전과-조사-방식)·[상호작용](agent-interaction-models.md#조사-방법과-표기) | Paperclip adapter/JWT·deferred wake, Hermes/OpenClaw 대안의 탐색 출발점 | 최신 고정 SHA 원문으로 다시 확인. 기존 동작을 현재 보장으로 옮기지 않음. 최신 Hermes room grant도 확인해 과거 단일 key 설명의 일반화를 피함 |
| [#52](issue-52-references.md#brief)·[Paperclip](paperclip.md)·[코드 구조](reference-code-structure.md) | PG fixture·WS snapshot, 기존 checkout·파일 위치 | Paperclip의 queue4·surface14·runtime6파일을 각각 과거 ref와 blob 비교. 78b833c 대비 auth middleware 변경·나머지 해당 파일 동일, 1b4c803 대비 runtime/queue 일부 변경 또는 당시 경로 미존재. 모두 새 SHA 재독; 상세 cache 기록 |
| [#50](issue-50-references.md#brief)·[Paperclip 화면](paperclip-dashboard.md)·[화면 후보](dashboard-references.md) | scope/cache/상세 진입 질문 | 이후 C 확정과 #53 agent 상세 추가가 우선. 옛 배치 제안을 재선정하지 않음 |
| [#1](issue-1-references.md#brief) | strict 계약·가짜 clock/runtime 검증 방법 | 이전 backlog·저장 엔진·승인 권고는 현행 #49/ADR에 대체됨 |
| [비교 목록](comparative-survey.md)·[#51](issue-51-references.md#brief) | 후보·범위 확인 | 연구 지도는 이번 실행 메커니즘의 직접 근거가 없어 심층 재사용 안 함 |

기존 `.reference-cache/issue-{1,50,51,52}/`, `wayfinder-foundation/`은 소스/도구 위치에만 재사용했다. 기존 문서의 Evidence ID는 위 anchor로 인용하고 아래 E는 이번 원문·실행에만 부여한다.

## 레퍼런스

관점별 후보 항목 **33개**(queue18·runtime7·surface8, 관점 간 중복 포함)를 기록했다. 전체 표와 검색 라운드는 `candidates.md`, `notes/discovery-*.md`에 있다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 영속 inbox·동시성 | 5라운드. PG queue·workflow·FIFO/visibility·transactional inbox·인접 agent를 확장. 마지막 후보는 키 직렬화·명시 입력 membership·후속 wake·attempt fence의 기존 조합이며 새 실패 유형 없음 |
| 실행 계약·권한 | 4라운드. adapter→ACP fixture→job/object-bound token→공식 실패 이슈. 마지막 미종료/오류를 성공으로 표시/event 미발행 보고는 명시 result·취소 settlement·event 발행 검증의 기존 실패 유형을 반복 |
| 채팅·활동·관찰 | 3라운드. 제품/부품→transport 실패→trace/workflow UI. 마지막 Langfuse/Phoenix/Temporal은 메시지·run·history 구별의 변형이며 새 실패 유형 없음 |

검색 범위에서의 패턴 포화이며 생태계 전수조사를 뜻하지 않는다. 검색 결과만 본 후보는 결정 근거에서 제외했다.

| 심층 대상 | 버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| Paperclip | `4415665d67b16ffefbe4519c4bdd521f37bb87b9` | MIT | 소스·제한 원본 module 실행. 같은 스택·adapter control plane·wake/run·scope·화면과 계약 불일치 반례 |
| Graphile Worker | `4cda192c5df254392a1dff350e5d73f7d2c18a85` | MIT | 소스·테스트 읽기. named queue 직렬화와 job_key 병합, batch 내부 동일 key 중복 반례 |
| pg-boss | `d4400859eed280b58c346f5289a0312913d558bd` | MIT | 소스·테스트 읽기. active partial unique와 stale attempt fence, id-only 우회 반례 |
| ACP TypeScript SDK | `1db4d43286d993545e729376346b7f9098748159` | Apache-2.0 | 소스·테스트 읽기. model-free fake+실제 HTTP fixture와 no-op cancel 반례 |
| assistant-ui | `69bf91a6d5eb3c652ed6f2188dc6fb6934178e9b` | MIT | 소스·공개 scripted UI 조작. 명시 공개 활동/답장 분류, transport와 run 상태 구별 |
| PostgreSQL18·ACP v1 명세 | `PG18 문서; ACP `b260d9992fea68f3f89890f96a4f5bb8c64fd69c`` | PostgreSQL License; ACP 명세 고지 별도 미확인 | 공식 명세·PG18.1 독립 SQL 실행. lock/snapshot/취소 최종 응답 규칙 |

OSS5종 root LICENSE를 고정 SHA에서 읽었다. **설계 참고만 하며 코드 복사나 라이브러리 도입을 권고하지 않는다.** 복사하면 파일 header/NOTICE/의존성까지 다시 확인하고 출처 SHA·경로와 루트 고지를 남겨야 한다. BullMQ/Temporal/Redis/Kubernetes는 비교 자료이며 새 의존성 후보가 아니다.

## 근거

모든 확인일은 2026-10-18이다. 테스트는 별도 실행 표시가 없으면 읽기만 했다. 메인이 결정에 쓰는 원문과 모든 채택 캡처를 다시 열었고 `main-verification.md`에 대조 결과를 남겼다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | SKIP LOCKED는 일관된 전체 view를 제공하지 않는다. Read Committed는 statement마다 snapshot이 달라진다. 활성 일부 상태만 unique로 제한하는 partial index가 가능하다. | [SELECT](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE) · [isolation](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) · [partial index](https://www.postgresql.org/docs/18/indexes-partial.html) | 문서 주장 |
| <a id="E02"></a>E02 | 독립 PG probe 8cases/18assertions PASS. wake 행만 잠그면 두 tx가 같은 agent의 다른 입력을 획득한다. agent lock+busy 검사·active unique·묶음 고정·rollback·종료/쓰기 lock 충돌을 확인했다. | `probes/postgres-inbox.mjs`, `postgres-inbox-log.txt`; Node24.21·PG18.1·pg8.16.3. 제품 schema/API나 queue OSS 실행 아님 | 실행 확인 |
| <a id="E03"></a>E03 | Paperclip은 agent 행 잠금 뒤 wake+queued run+연결을 한 tx에 쓰고 commit 후 발행한다. deferred 승격도 상태 CAS와 새 run/연결을 tx로 묶는다. | [enqueueWakeup](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/services/heartbeat/queue.ts#L4239-L4350) · [promotion](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/modules/wake-queue/adapters/postgres.ts#L449-L525) | 소스 확인 |
| <a id="E04"></a>E04 | Paperclip start lock은 프로세스 Map이며 30초 후 우회한다. 종료 상태 저장 뒤 cleanup/finally와 다음 run 시작이 별도여서 terminal만으로 프로바이더의 정리를 보장하지 않는다. | [withAgentStartLock](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/services/agent-start-lock.ts#L3-L48) · [executeRun finally](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/services/heartbeat.ts#L3888-L3938) | 소스 확인 |
| <a id="E05"></a>E05 | Graphile은 queue 행을 잠그지만 batch 한 번에 같은 queue job 여럿이 선택되는 문제를 별도 distinct로 막는다. 이 회귀는 같은 queue 작업을 하나씩 resolve하는 테스트로 다룬다. | [constructQuery](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/src/sql/getJobs.ts#L145-L251) · [queue tests](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/__tests__/main.runTaskList.test.ts#L144-L236) | 소스 확인 |
| <a id="E06"></a>E06 | Graphile은 실행 중 job_key를 비워 새 job을 만들고 pending payload는 양쪽이 배열일 때만 append한다. 객체는 교체한다. key dedupe가 모든 입력 보존을 뜻하지 않는다. | [add_jobs](https://github.com/graphile/worker/blob/4cda192c5df254392a1dff350e5d73f7d2c18a85/sql/000020.sql#L120-L190) | 소스 확인 |
| <a id="E07"></a>E07 | pg-boss singleton은 active 상태 partial unique로 중복 실행을 방어한다. worker settle는 active+id+retry_count를 검사하지만 plain id API는 fence를 우회한다. restore가 같은 attempt 수를 재사용하는 예외도 명시한다. | [active unique](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L1366-L1368) · [attemptFence](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L2828-L2853) · [stale object/id-only tests](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/test/attemptFenceTest.ts#L159-L218) | 소스 확인 |
| <a id="E08"></a>E08 | Paperclip의 입력·onEvent/onLog/onUsage·AbortSignal·종료 usage/session/summary는 분리된다. eventType/string·generic payload는 공개 활동의 엄격한 schema가 아니다. | [result](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/packages/adapter-utils/src/types.ts#L102-L175) · [context/event](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/packages/adapter-utils/src/types.ts#L222-L285) | 소스 확인 |
| <a id="E09"></a>E09 | JWT 서명·exp 검사에는 현재 run status 조회가 없다. HTTP middleware는 run+company+agent를 읽지만 cancelled/requested 쓰기만 차단하고 GET/HEAD/OPTIONS를 예외 처리한다. 성공/실패/timeout/없는 run은 취소 predicate에서 false다. | [verifyLocalAgentJwt](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/agent-auth-jwt.ts#L167-L264) · [actorMiddleware](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/middleware/auth.ts#L368-L458) · [run guard](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/agent-run-cancellation.ts#L5-L34) | 소스 확인 |
| <a id="E10"></a>E10 | 원본 JWT와 취소 predicate import probe를 메인도 재실행해 9개 검사 묶음 PASS. 변조·다른 instance·만료·secret 부재 거부와 terminal predicate 반례를 확인했다. 일반/strict verifier의 만료초 경계도 다르다. | `probes/runtime-token-probe.mjs`, `runtime-token-main-log.txt`; standard scope/instance 공급자 stub, DB/error 경로는 실행시 throw하는 stub. 실제 HTTP auth 미실행 | 실행 확인(제한) |
| <a id="E11"></a>E11 | 타조직 ID와 없는 ID를 같은404로 반환하는 helper가 있다. 일반 company403 검사만 쓰면 존재 oracle가 생긴다고 명시한다. 쓰기 guard는 caller tx에서 run FOR SHARE를 잡는다. | [getAccessibleResource](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/routes/authz.ts#L123-L194) · [assertAgentRunWriteAllowed](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/server/src/agent-run-cancellation.ts#L15-L34) | 소스 확인 |
| <a id="E12"></a>E12 | ACP fake는 지정 chunk를 내고 종료한다. 실제 localhost HTTP/WS fixture·HTTP POST/SSE 테스트가 있지만 fake cancel은 빈 handler이고 delay는 실제 timer다. until은 단순 polling이며 DB drain이 아니다. | [createTestAgentApp](https://github.com/agentclientprotocol/typescript-sdk/blob/1db4d43286d993545e729376346b7f9098748159/src/test-support/test-agent.ts#L158-L228) · [startTestServer](https://github.com/agentclientprotocol/typescript-sdk/blob/1db4d43286d993545e729376346b7f9098748159/src/test-support/test-http-server.ts#L19-L70) · [HTTP test](https://github.com/agentclientprotocol/typescript-sdk/blob/1db4d43286d993545e729376346b7f9098748159/src/server-permission.test.ts#L46-L205) · [until](https://github.com/agentclientprotocol/typescript-sdk/blob/1db4d43286d993545e729376346b7f9098748159/src/test-support/until.ts#L1-L20) | 소스 확인 |
| <a id="E13"></a>E13 | ACP 명세는 cancel 이후에도 최종 cancelled 응답 전까지 update를 허용한다. 취소 요청 전달과 프로바이더 종료 확인은 다른 단계다. | [v1 Cancellation](https://github.com/agentclientprotocol/agent-client-protocol/blob/b260d9992fea68f3f89890f96a4f5bb8c64fd69c/docs/protocol/v1/prompt-turn.mdx#L549-L584) | 문서 주장 |
| <a id="E14"></a>E14 | ACP schema는 thought chunk도 포함하고 Paperclip transcript는 thinking/stdout/stderr를 정규화한다. 원본 stream 전체를 공개 transcript로 복사하는 정책의 근거가 될 수 없다. | [thought variant](https://github.com/agentclientprotocol/typescript-sdk/blob/1db4d43286d993545e729376346b7f9098748159/src/schema/zod.gen.ts#L2714-L2732) · [thinking merge](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/adapters/transcript.ts#L19-L32) · [buildTranscript](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/adapters/transcript.ts#L102-L154) | 소스 확인 |
| <a id="E15"></a>E15 | assistant-ui run은 안정 part ID와 명시 commentary/tool/answer/attention 분류를 받아 활동과 답장을 나눈다. unknown은 attention으로 표시하므로 공개 여부 enforcement를 UI에 맡길 수 없다. | [conversion](https://github.com/assistant-ui/assistant-ui/blob/69bf91a6d5eb3c652ed6f2188dc6fb6934178e9b/apps/docs/components/demo/elements/run-activity.tsx#L30-L85) · [renderer](https://github.com/assistant-ui/assistant-ui/blob/69bf91a6d5eb3c652ed6f2188dc6fb6934178e9b/apps/docs/components/demo/elements/run-activity.tsx#L144-L231) | 소스 확인 |
| <a id="E16"></a>E16 | assistant-ui queue core는 메모리 FIFO이며 공개 예제는 상수3행을 useState로 제거한다. connection 예제는 phase timer다. 서버 inbox·전체 묶음·socket 복구를 보장하는 컴포넌트가 아니다. | [memory queue](https://github.com/assistant-ui/assistant-ui/blob/69bf91a6d5eb3c652ed6f2188dc6fb6934178e9b/packages/core/src/runtime/queue/message-queue.ts#L123-L150) · [advance](https://github.com/assistant-ui/assistant-ui/blob/69bf91a6d5eb3c652ed6f2188dc6fb6934178e9b/packages/core/src/runtime/queue/message-queue.ts#L224-L262) · [queue demo](https://github.com/assistant-ui/assistant-ui/blob/69bf91a6d5eb3c652ed6f2188dc6fb6934178e9b/apps/docs/components/demo/elements/message-queue.tsx#L1-L35) · [connection demo](https://github.com/assistant-ui/assistant-ui/blob/69bf91a6d5eb3c652ed6f2188dc6fb6934178e9b/apps/docs/components/demo/elements/connection-state.tsx#L1-L23) | 소스 확인 |
| <a id="E17"></a>E17 | Paperclip은 agent.status와 live/최근 run을 구별하며 항상 run 상세 링크를 만든다. 최근 목록에 없는 오래된 run도 개별 조회하는 테스트가 있다. | [run navigation](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/pages/AgentDetail.tsx#L1550-L1598) · [agent status](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/pages/AgentDetail.tsx#L1760-L1766) · [history test](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/pages/AgentDetail.history.test.tsx#L22-L40) | 소스 확인 |
| <a id="E18"></a>E18 | Paperclip structured event는 company+run guard/seq 중복 제거 후 append한다. raw-log merge의 seq 정렬과는 다른 경로다. 전역 provider는 첫 연결/재연결 모두 HTTP query invalidate로 누락을 복구한다. | [structured event](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/pages/AgentDetail.tsx#L4341-L4408) · [raw log merge](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/lib/run-log-chunks.ts#L187-L260) · [reconnect](https://github.com/paperclipai/paperclip/blob/4415665d67b16ffefbe4519c4bdd521f37bb87b9/ui/src/context/LiveUpdatesProvider.tsx#L2028-L2041) | 소스 확인 |
| <a id="E19"></a>E19 | 공개 scripted UI를 직접 조작하고 7개 캡처를 재열람했다. 실행 중 활동 펼침→완료 답장 분리, 390px 완료 활동, 대기3→2→1 표시를 확인했다. connection 배너는 자동 phase 표시만 확인했다. | [run-activity](https://www.assistant-ui.com/elements/run-activity) · [message-queue](https://www.assistant-ui.com/elements/message-queue) · [connection-state](https://www.assistant-ui.com/elements/connection-state); `captures/captures.md`, `probes/ui-capture-log.json`. 서버 영속성/실제 모델/WS복구 미검증 | 실행 확인 |

19개 근거: 실행 확인3(그중 token은 dependency stub을 둔 제한 실행)·소스 확인14·문서 주장2다. 명세/후보별 한계는 `recon/`에 남겼다. PostgreSQL probe는 과거 #52의 임시 설치(embedded18.1 beta, locale/env/native alias 보정)를 재사용했고 최신 제품 embedded18.4 실행 확인을 뜻하지 않는다. 브라우저는 공식 상수/timer 예제이며 공개 배포 SHA와 source SHA의 일치는 미확인이다.

## 패턴

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| P01 | 영속 입력 보존과 실행 묶음의 명시 연결 | E03,E06 | Paperclip wake↔run, Graphile 배열/객체 merge | 입력 사유·복구·화면의 원본을 보존 | 객체 last-wins, 수집 뒤 최신 전체 대화를 다시 읽어 다음 입력이 현 run에 섞임 |
| P02 | agent 단위 admission과 DB active 제약 | E01,E02,E04,E05,E07 | Graphile named queue, pg-boss singleton, Paperclip process start lock | agent별 직렬화와 다른 agent 병렬 처리를 분리 | wake 행 잠금만 사용, batch 내부 중복, 짧은 lock 해제 뒤 active 재검사 누락 |
| P03 | 실행 단위 권한과 terminal fence | E07,E09–E11 | signed TTL·현재 run 상태·attempt 조건은 별개 | 늦은 호출/옛 프로바이더의 부작용 차단 | 종료 GET 허용, id-only settle, 인증 후 종료와 쓰기의 경쟁 |
| P04 | 입력·공개 활동·종료 결과·취소의 별도 계약 | E08,E12–E14 | Paperclip callback, ACP stopReason/cancel/fake | runtime 교체와 실패 분류가 쉬움 | no-op cancel, abort 전달만 하고 종료 완료 처리, process exit0=성공 추측 |
| P05 | 명시 공개 projection과 도메인 메시지/상태 구별 | E14–E17,E19 | raw transcript와 props-only 공개 활동 UI의 목적이 다름 | 내부 추론 노출 방지·답장과 진행 표시 구별 | unknown을 UI에서 그대로 노출, 활동 텍스트를 답장으로 추측, run 성공을 연구 완료로 표시 |
| P06 | 안정 ID·순서와 HTTP snapshot 복구 | E16,E18,E19 | raw chunk 정렬과 structured event append를 구별 | 중복/재연결/조직 전환에도 기록 복원 | 텍스트로 dedupe, socket 종료를 run 취소로 오인, stale 응답이 다른 조직에 합쳐짐 |

## 결정 권고

아래 “채택”은 **이 조사에서의 권고 분류**다. Issue·ADR의 고정 결정에 우선하지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| D01 | 채택 | 사용자 메시지+깨우기+그에 해당하는 Event를 같은 DB tx에 기록하고 commit 뒤 발행. 실행 시도/입력 연결·최종 상태/종료 결과도 각각 원자적으로 보존 | P01,E02,E03; #52 구현 | 메모리 enqueue만 성공하거나 메시지만 남는 dual-write 방지. WebSocket은 영속 원본 아님 | Q1,Q2 |
| D02 | 변형 채택 | 조직/agent 행을 짧게 잠그고 active 여부 재검사→당시 pending 전체 수집→run과 membership 저장. 활성 run 부분 unique 또는 동등 DB 제약을 방어선으로 두고 runtime은 commit 뒤 호출 | P02,E01–E07 | wake row SKIP LOCKED/process mutex만으론 부족. runtime을 기다리는 동안 DB tx를 열어 두지 않음. 종료 결과를 쓰고 adapter가 settle/정리된 뒤 slot 반환·다음 claim | Q1,Q2 |
| D03 | 채택 | 묶음의 wake/message ID와 순서를 run에 고정. 이후 입력은 pending으로 남기고 다음 run 하나에 모두 전달. context도 그 경계까지의 기록으로 조립 | P01,E02,E06; #53 AC2 | count나 마지막 payload만 합치면 사유 유실. 같은 내용의 서로 다른 메시지는 서로 다른 입력. 실행 중 context 조회에도 새 입력을 현 run에 섞지 않음 | Q1,Q2,Q3 |
| D04 | 변형 채택 | request/public activity/result/cancel 네 면을 strict zod로 정의. token은 실행 전용 비저장 필드, bundle version·workspace·session과 공개 result를 구별. bundle 버전 변경 시 session 초기화 | P04,E08,E12,E13; ADR-0001 | 외부 ACP 전체 schema나 generic event를 내부 계약으로 복사하지 않음. result는 명시 종료 사유를 포함하고 한 번만 확정 | Q3,Q4 |
| D05 | 변형 채택 | token의 유효성뿐 아니라 현재 run·org·agent·허용 상태를 매 조직 도구에서 검사. 모든 terminal/없는 run은 읽기 포함 fail closed. 도구 쓰기는 검증과 부작용을 같은 tx/run 잠금 아래 두어 종료와 직렬화 | P03,E02,E09–E11; #53 AC3 | JWT TTL/삭제된 메모리 token만으로 수명 보장 불충분. 초기에는 digest 저장 opaque token이 단순한 후보, JWT도 online 상태 검사가 필수 | Q2,Q4 |
| D06 | 채택 | 도구 입력에 scope 선택 필드를 허용하지 않고 token actor로 범위를 도출. 기록 조회는 org+ID 조건, 타조직/없는 ID는 같은404·본문. user 권한 fallback으로 agent 요청을 처리하지 않음 | E09,E11; #49/AGENTS | 도구 목록 노출/프롬프트는 권한이 아님. 현재 첫 도구2개만 열며 사용자 승인·정책·최종 완료 경로는 agent 도구로 노출 안 함 | Q4 |
| D07 | 변형 채택 | adapter가 명시 공개로 낸 허용 종류/필드만 저장·반환·WS 발행. 조직/agent/run 귀속·상태 Event는 서버가 부여. 비공개/unknown/raw output은 공개 경로에 넣지 않음 | P05,E08,E14,E15; #53 공개 활동 AC | thinking/stdout parser, 마지막 text=답장, unknown→attention 자동 공개를 배제. token/Authorization/전체 실행 context를 transcript나 API result에 넣지 않음 | Q3,Q4,Q5,Q6 |
| D08 | 변형 채택 | fake는 agent/Role·wake에 맞춘 scripted 단계에서 실제 token HTTP를 호출. 시계와 단계 gate를 주입하고 abort를 기다림/HTTP/후속 이벤트에 전파. drain은 pending0뿐 아니라 claim/in-flight/finalizer/후속 wake가 없는 안정 상태까지 대기 | P04,E02,E12,E13; #49 Testing Decisions | 가짜 DB 직접 쓰기·고정 sleep·빈 cancel handler·메모리 queue 길이만 보는 helper를 배제. HTTP API/조회/WS로 외부 동작 검증 | Q1,Q2,Q3 |
| D09 | 변형 채택 | 채팅의 전송 중/저장됨/다음 실행 대기와 run 진행/종료를 구별. 실행 중 새 메시지를 보낼 수 있고 기본 다음 실행 반영을 안내. agent 상세는 agent 상태·최근 run·명시 run 링크, run 상세는 사유·공개 활동·종료 사유·요약 | P05,E15–E19; #53 화면 | 답장은 조직 도구로 남긴 도메인 메시지다. 활동/요약 텍스트를 답장으로 자동 전환하지 않음. run 성공과 사용자 최종 연구 완료는 다름. 독립 상세 route 유지 | Q5,Q6 |
| D10 | 변형 채택 | query key/응답/WS에 org·필요한 agent/run 범위를 유지. 안정 Event/활동 ID와 run 내 seq를 쓰고 정렬·중복 제거. 첫 ready/재연결 때 HTTP snapshot 재조회, 화면 연결 끊김을 run 취소로 처리하지 않음 | P06,E18,E19; #52 | 기존 WS+Query 복구를 확장. replay/exactly-once를 새로 약속하지 않고 늦은 응답·구독 정리·중복 Event를 검증. 문자열 dedupe 금지 | Q5,Q6 |
| D11 | 보류 | queue/workflow/ACP SDK 신규 도입, latest-only/exclusive dedupe, 취소/재정렬/steer UI, 복구/재시도 정책 확장은 이번에 채택하지 않음 | P01–P06; #49 Out of Scope | PG와 adapter 계약만으로 첫 관통 검증. fake 취소 seam은 #53, 사용자 중단 제어는 #59, heartbeat/재시작 복구는 #60 | Q1,Q2,Q3,Q5,Q6 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| wake 행 잠금·프로세스 mutex만으로 agent1run 보장 | E02,E04,E05 | 입력 단위와 실행 직렬화 단위가 다름. batch 내부/다른 dispatcher를 별도 방어 |
| 중복 wake insert 무시·객체 덮어쓰기·last-wins | E06,E07; BullMQ 비교 후보 | 미처리 입력 사유 전부 보존 계약과 충돌 |
| JWT TTL만 신뢰·cancelled 쓰기만 거부·id-only 완료 | E07,E09,E10 | 모든 종료 토큰 거부와 늦은 부작용 차단에 부족 |
| raw/thinking stream 전체 공개·unknown 출력 자동 표시 | E14,E15 | 비공개 추론은 공개 로그 전제가 아니며 unknown payload는 공개 승인이 아님 |
| 브라우저 FIFO queue·socket 상태를 서버 영속 실행 상태로 취급 | E16,E18,E19 | 새로고침/탭/재연결과 실행 종료 경계를 보장하지 않음 |
| cancel 통지만 전달하고 프로바이더 정리를 기다리지 않음 | E04,E12,E13 | 늦은 HTTP/이벤트와 다음 run의 중첩 위험 |

## 구현 참고

권고 경로는 **메시지 저장 → 영속 wake → agent admission → 고정된 run 입력 → fake → scoped tool HTTP → 메시지/공개 활동 저장 → terminal/revoke → 정리 후 다음 묶음**이다. 상태 저장소는 Control Plane이 소유한다.

구현 위치는 [구조](../architecture.md#패키지-구성)와 [코드 지도](../agents/code-map.md)를 기준으로 찾는다. `packages/contracts`는 run/tool/public event 계약, `packages/core`는 admission·scope·종료 권한 규칙, `packages/db`는 inbox/run/membership·트랜잭션/제약, `packages/runtime`은 scripted adapter, `apps/server`는 조립·dispatcher·인증/도구 HTTP·WS, `apps/web`은 채팅/활동/agent/run 상세와 query projection을 맡는다. core가 DB/Express를 import하거나 runtime이 DB를 직접 쓰는 구조는 권고하지 않는다.

현재 #52는 `apps/server/src/app.ts`의 사용자 HTTP와 EventHub, `packages/db/src/client.ts`의 임시 PG 수명, `apps/server/test/support.ts`의 ready barrier를 제공한다. 이 seam을 넓혀 #49 지침대로 **사용자 HTTP 입력 → 실제 token 도구 HTTP → 조회/WS 확인**으로 검증한다. 운영에 시나리오/clock 테스트 제어 endpoint를 공개하지 않고 서버 구성으로 주입한다.

| ID | 검증할 경계: 입력 → 행동 → 기대 | 근거 |
|---|---|---|
| V01 | 사용자 메시지 → gated fake의 맥락조회/메시지 보내기 HTTP → run1개·동일 답장 ID가 조회/WS, 공개 활동과 요약/종료 사유 연결 | D01,D04,D08; AC1 |
| V02 | run1을 gate에서 멈추고 메시지 여러 개 → run1 종료 후 drain → run2 하나에 모든 사유/ID, run1 입력/맥락 불변·동일 agent 중첩0 | D02,D03,D08; AC2 |
| V03 | 두 dispatcher가 같은 agent backlog를 동시에 claim, 다른 agent도 준비 → 한 agent run1개·다른 agent 진행 가능, 모든 입력 보존 | D02; E02,E05 |
| V04 | message/wake/Event 또는 claim 중 강제 실패 → 조회/WS → 부분 메시지·유실 wake·고아 run 없음, 미처리 입력 재수집 가능 | D01,D02 |
| V05 | 성공·실패·timeout·cancelled 후 옛 token, 없는 run·변조·누락 token → 두 도구의 읽기/쓰기 → 거부·새 기록/Event0 | D05; AC3 |
| V06 | A token+ B의 message/agent/run ID 또는 없는 ID, body scope 주입 → 조회/메시지 도구 → 동일404 또는 strict 입력거부, B조회/쓰기/Event0 | D06; AC4 |
| V07 | 인증 직후 terminal과 tool 쓰기 경합, 취소 뒤 늦은 callback → 확정 순서 검증 → terminal 뒤 새 부작용/활동 없음, 다음 run 영향0 | D05,D07,D08 |
| V08 | fake public activity와 private/unknown/귀속 위조 event, token-bearing context → API/DB/WS/화면 → 허용 공개 필드만, 토큰/내부 추론 노출0 | D04,D07; 공개 활동 AC |
| V09 | fake 지연/오류/빈 출력/abort → drain → 무한대기 없이 종료 사유, 요약 부재 표시, slot 정리. cancel 이후 다음 run은 이전 fake settlement 뒤 시작 | D04,D08 |
| V10 | 채팅 전송 실패·중복 클릭·run 진행 중 새 입력 → 저장/실행 상태 구별, 실패시 입력 유지·재시도, 새 입력은 다음 실행 안내 | D09; 대시보드 AC |
| V11 | desktop/390px에서 Lead 대화→활동→run 상세, agent 상세→최근/오래된 run 직접 링크 → 같은 org/run의 사유·공개 활동·종료/요약, agent/run 상태 구별 | D09,D10; AC6/7 |
| V12 | 최초 ready 직전/WS 끊김 중 기록, 중복·역순 Event, A→B 전환 중 A응답 도착 → HTTP 재조회로 복원, 행 중복/교차조직 표시0, disconnect가 run cancel을 만들지 않음 | D10 |

이 표는 **구현 시 검증할 시나리오**다. 위 제품 API/E2E는 이번 조사에서 실행하지 않았다. 임시 PG와 제한 token probe의 성공으로 제품의 조직 격리·승인·복구 완료를 주장하지 않는다.

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| token 표현·저장 | #53 | digest 저장 opaque token: DB run 검사와 단순 결합. JWT: adapter간 서명 검증 편의, online run 검사·키 수명·claim 검증은 추가 필요. 둘 모두 terminal 읽기 거부 필수(D05) |
| 메시지/도구 요청의 응답 유실 후 재전송 | #53 | 안정 client request ID+org별 멱등 기록 또는 중복 가능성을 명시하는 단순 전송. 같은 텍스트로 dedupe하면 안 됨. #60 재처리 때 이미 보낸 답장 중복도 별도 고려 |
| API/상태 이름·활동 종류·seq·페이징 상한 | #53 | 의미와 검증 경계를 먼저 정하고 수치/이름은 구현에서 선택. raw log5천행 같은 upstream 수치를 근거 없이 복제하지 않음 |
| user Surface와 agent 도구의 신뢰 경계 | #53 / 실제 adapter 판2 | agent bearer를 사용자 implicit 권한으로 fallback시키지 않음. 현재 self-host 사용자 API의 네트워크 접근 경계는 별도 확인 필요. scoped tool 검증만으로 프로바이더 shell/network 전체 격리를 주장하지 않음(ADR-0001) |
| 재시작 후 입력 재처리·side effect 멱등성 | 후속 #60 | 현재 run/입력 membership·종료 사유를 남기되 자동 복구는 #60. stale attempt를 같은 run 권한으로 재사용하지 않는 fence 필요. 재시도 정책 일반화는 #49 범위 밖 |

초기 계획·팀·환경 승인과 사본은 후속 #54, 작업/작업자는 #55, 지도 #56, 결과 검토/최종 완료 #57, 작업자 추가 승인 정책 #58, 일시정지/중단/중단하고 반영 #59, heartbeat/기억/재시작 #60, outbox/Inbox #61, 지표 #62, 전체 데모 #63, 하네스 편집 #64다. #53의 fake 취소 지원·agent 상세·공개 활동 검증을 그쪽으로 미루지 않는다.

## 한계와 미확인

- 실행한 것: 독립 PG18.1 SQL8cases/18assertions, 원본 JWT/취소 predicate 제한 import9검사 묶음(메인 재실행), 공식 scripted UI7개 실화면 캡처의 직접 조작·재열람. 실제 모델·계정·유료 API·실제 연구 데이터는 사용하지 않았다. 기동한 PG와 브라우저는 종료했다.
- 미실행: BaboJUBot 제품 구현/테스트/typecheck/lint/build/E2E, Paperclip/Graphile/pg-boss/ACP/assistant-ui 전체 앱·upstream suite, 실제 token HTTP 인증/교차조직 거부, 실제 adapter/process 취소, 서버 crash/restart·부하·외부 PG. fake HTTP 왕복·clock/drain은 소스/설계 참고이며 이번 제품 실행 결과가 아니다.
- UI 미확인: 실제 backend 채팅 저장/권한 없음/오류 실화면, 실제 조직 전환·WS 복구, 스크린리더/다른 브라우저. connection demo는 배너 표현만 확인했다. assistant-ui queue 삭제는 상수 state 조작이며 제품 메시지 취소 기능 채택 근거가 아니다.
- 실패 기록: 기본 sandbox의 GitHub 연결 실패·Chromium launch EPERM, env-i의 DBus 환경 누락, 예제 Pause가 cancelled로 바뀐 뒤 Resume selector timeout을 cache에 보존했다. 수정/공개 read escalation 후 확인했고 이 실패들을 upstream 기능 부재 근거로 쓰지 않았다.
- token probe는 standard scope와 instance ID 공급자를 stub했다. 실제 DB guard와 HTTP middleware를 실행하지 않았고 암호학적 검증 전체 감사가 아니다. PG probe의 terminal/write rowlock은 별개 최소 SQL 메커니즘 검증이다.
- 모든 source는 표의 고정 SHA 기준이다. 일반 최신 버전의 보장은 아니다. 공식 실패 이슈는 당시 보고이지 이번 HEAD 재현 결과가 아니다. 코드 복사 시 고지·의존성/NOTICE·upstream 변경을 재확인한다.
- 조사 문서는 미커밋으로 남긴다. 기존 사용자 변경인 문서 지도·코드 리뷰 조사도 보존한다. Issue를 닫거나 ADR·확정 기능·제품 정책을 변경하지 않는다.
