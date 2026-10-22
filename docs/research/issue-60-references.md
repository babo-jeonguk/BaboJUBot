# issue-60 레퍼런스 조사: Heartbeat, Memory port 최소 구현, 서버 재시작 복구

조사일: 2026-10-22(KST). 대상: [#60](https://github.com/babo-jeonguk/BaboJUBot/issues/60), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49), 완료된 blocker [#53](https://github.com/babo-jeonguk/BaboJUBot/issues/53). 구현 전 기술 권고이며 확정 계약이나 구현 완료가 아니다. 상세 자료: `.reference-cache/issue-60/`(Git 무시). 이 조사에서 제품 코드·테스트·설정은 변경하지 않았다. 아래 제품 관찰은 명시한 기준 SHA의 기록이다. 2026-10-22 추가 조사에서는 별도로 진행 중인 작업 폴더의 #60 구현 변경을 검증하지 않았다.

## Brief

- 구현할 문제: 에이전트별 선택적 heartbeat와 설정 화면, 조직/자기 에이전트 기억의 최소 write/recall, 서버 재시작 뒤 진행 중 실행 시도의 종료·입력 재처리를 제공한다.
- 동종 문제: **신원에 묶인 직렬 작업자가 주기 입력과 영속 inbox를 소비하고, 장애 후 입력을 재전달하면서 과거 실행 시도의 권한·부작용과 사적 맥락을 분리하는 메커니즘**이다. 여기서 heartbeat는 장애 감지 신호가 아니라 주기적 깨우기다.
- 고정된 결정: [AGENTS](../../AGENTS.md), [용어](../../GLOSSARY.md), [기능](../features.md), [구조](../architecture.md), [ADR1](../adr/0001-adapter-control-plane.md)·[ADR2](../adr/0002-durable-records-and-wakes.md)·[ADR3](../adr/0003-configurable-approval-policy.md)·[ADR4](../adr/0004-paperclip-aligned-stack.md)를 따른다. 단일 서버·Postgres·가짜 실행기·에이전트당 실행 시도 하나·미처리 깨우기 전체 병합·실행 중 입력의 다음 실행 반영을 유지한다. 조직 → 에이전트 → 실행 시도 잠금 순서와 종료/취소 토큰 거부를 보존한다.
- 조직/자기 에이전트 Memory scope는 실행 시도 신원에서 정한다. 연구 기록을 기억으로 대체하지 않는다. 특정 메모리 제품·기법·저장 엔진, 실제 모델, 일반 재시도 정책·worker 분리는 이번 선택 대상이 아니다. 초기 승인·사용자 최종 완료·pause/stop admission을 주기 입력이나 복구가 우회해서는 안 된다.
- [#53 인계](https://github.com/babo-jeonguk/BaboJUBot/issues/60#issuecomment-6249545547)는 입력 membership·기존 종료 사유·이미 발생한 답장의 멱등성을 요구한다. 메모리의 미저장 실행 결과는 crash 뒤 복구되지 않는다는 제한을 유지한다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 주입 시계의 due heartbeat를 기존 wake와 병합하면서 중복 tick·실행 중·긴 downtime·설정 변경·pause/stop/completed 경계를 어떻게 다루는가? | #60 heartbeat·AC1; ADR2; 구조 admission | Source Recon + runtime/failure + persistence/recovery |
| Q2 | 실행 시도 신원에서 조직/에이전트 Memory scope를 강제하고 출처를 검증하며 최소 최근순·문자열 회수를 제공하는 port/DB 경계는? | #60 Memory·AC2/3; 용어; 조직 경계 | Source Recon + adversarial scenario + persistence/recovery |
| Q3 | startup에서 running attempt를 서버 재시작 사유로 닫고 원래 입력 membership·기존 종료/취소 사유를 보존하며 pending을 원자적으로 복원하는 방법은? | #60 복구·AC4; #53 인계 | Source Recon + persistence/recovery + failure probe |
| Q4 | 재전달로 새 attempt가 생길 때 과거 token·늦은 완료·이미 발생한 답장/기억 쓰기의 중복을 어떻게 제한하고 무엇을 보장하지 못하는가? | #53 인계; #60 AC4; ADR1/2 | Source Recon + runtime/failure + adversarial probe |
| Q5 | 에이전트 상세의 heartbeat 켜기/끄기·간격·다음 예정 시각·저장 실패·pause·좁은 폭을 어떻게 표시하고 테스트하는가? | #60 화면·AC5; features 화면 지도; #49 Testing Decisions | Surface Capture + Behavioral Recon + Source Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인·판단 |
|---|---|---|
| [#53](issue-53-references.md#brief) | inbox·실행 슬롯·토큰·재시작 인계, PG 실험 방법 | 현행 제품 코드 우선. pg-boss는 당시와 같은 SHA이며 파일별 blob 비교; Paperclip/Graphile은 새 ref 확인 |
| [#59](issue-59-references.md#brief)·[#57](issue-57-references.md#brief)·[#58](issue-58-references.md#brief) | 취소 정리·pause/stop/completed gate·잠금과 승인 경계 | 현행 코드에서 확인. 승인·생애주기 자체를 재설계하지 않음 |
| [실행 모델](agent-runtime-models.md)·[상호작용](agent-interaction-models.md)·[Paperclip](paperclip.md) | 후보와 파일 위치 | 새 SHA 원문/파일 blob 비교. 검색 index의 옛 OpenClaw heartbeat 설명을 현재 정책으로 쓰지 않음 |
| [#52](issue-52-references.md#brief) | embedded PG·실행 fixture | 이미 설치된 PG18.4 사용; 스택 재선정 없음 |
| [#1](issue-1-references.md#brief)·[#50](issue-50-references.md#brief)·[#51](issue-51-references.md#brief)·[#54](issue-54-references.md#brief)·[#55](issue-55-references.md#brief)·[#56](issue-56-references.md#brief), [비교 목록](comparative-survey.md)·[코드 구조](reference-code-structure.md)·[화면](dashboard-references.md)·[Paperclip 화면](paperclip-dashboard.md) | 기존 조사 탐색·후속 범위 확인 | 후보/경계만 사용. 지도·하네스·작업·연구 방법론 결정은 재선정하지 않음 |

기존 Evidence ID를 새 번호로 옮기지 않았다. Paperclip/Hermes heartbeat 관련11파일과 OpenClaw 기억 관련3파일은 #59 ref 대비 blob 동일, Paperclip recovery는 #53 대비 변경되어 새 원문을 재독했다. pg-boss는 #53과 같은 SHA의3파일, Graphile은 새 ref의2파일이 동일하다. LangGraph store는 새 조사다. 외부 소스의 재확인은 `recon/`과 `main-verification.md`에 기록한다.

## 레퍼런스

초기 후보49행(heartbeat18·기억21·복구8·공개 UI 보충2, 관점별 중복 포함)에 사용자 지정 저장소2행을 추가해 총51행, 심층 OSS8종이다. 추가 저장소의 내부 플러그인/경로 후보는 별도 Discovery 메모에 기록했고 저장소 수에 중복 합산하지 않았다. 전체 후보와 실행 경로는 `candidates.md`, 원문과 라운드는 `notes/*-discovery.md`에 있다. 후보 수는 관점별 중복을 포함한다. 검색 범위에서의 패턴 포화이며 생태계 전수조사는 아니다.

| 관점 | 마지막 라운드와 saturation 근거 |
|---|---|
| 주기 깨우기·설정 UI | 4라운드. agent→scheduler 부품→CronJob/Hangfire→실패 이슈. 마지막 node-cron/Bree 등은 due 선점·busy drop/defer·misfire coalesce·anchor·설정 경합의 기존 변형. 추가 공개 부품은 토글/입력 오류의 실화면을 보충 |
| 기억 port·신원/출처 | 4라운드. BaseStore/agent 기억→namespace advisory·stale overwrite→credential namespace→대안 교차검색. 마지막 후보는 신원 강제·명시 scope·출처·멱등 기록의 변형이며 새 최소 port 메커니즘 없음 |
| 재시작·부작용 | 4라운드. PG queue→transactional completion/outbox→stale settle 실패→복구 시간/relay crash. 마지막은 원자 복구·실행 소유권 검사·취소 우선·effect ledger·외부 unknown outcome의 기존 실패 유형 |

| 레퍼런스 | 분류 | 고정 SHA·버전 | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| Paperclip | agent control plane | `043f2514e67c50320433a0013fb228a75a51325c` | MIT | 소스. timer claim·일반 wake 경로·startup·복구 부작용 기록과 계약 불일치 반례 |
| Hermes | agent heartbeat | `8237c7f8ec179c88857f24a174509d985af704b7` | MIT | 소스·원본 module 실행. 주입 now·due coalesce·pause/reanchor·영속 실패의 한계 |
| LangGraph | Memory port·DB adapter | `3cd57c038ad827d05f80c6488adea9994156c58c` | MIT | 소스·제한 원본 실행. namespace/key/value와 무embedding 경로, backend 간 검색 의미 차이·namespace 누출 반례 |
| OpenClaw | Memory 쓰기 provenance | `7fe2460b6f1547606b0e790f2876cb2f77b77af4` | MIT | 소스. 원 호출 소유권을 commit 전에 재확인하고 출처 기록 실패를 처리하는 경계 |
| pg-boss | PG attempt recovery | `d4400859eed280b58c346f5289a0312913d558bd` | MIT | 소스·테스트 읽기. active+attempt fence와 transactional effect rollback; id-only/restore 예외 |
| Graphile Worker | PG stale lock 반례 | `7a2405bdd3b6322fb6b0d48dc0543bcc89166930` | MIT | 소스. job/queue 동시 unlock, 완료 DELETE의 id-only 경계 |
| ai-memory | hook 기억 수집·세션 인계 | 조사 `ae7b8bba8c056e478592c0972669c8371152bac9`; 실행 v3.2.0 `1c86aebc14addccc7ac875913d565c681bfa4a50` | MIT | 추가 소스·공식 바이너리 실행. 입력/후속 완료 분리·recovery key 보관·scope 차이 |
| knowledge-work-plugins | 업무 지침·검색 결과 합성 | `33d3dea41a341b341d4f5da2e8801ae0c89be2b8` | 대상 productivity/enterprise-search는 Apache-2.0; root는 비정형 후문 포함 | 추가 지침·HTML 소스. 출처/상충 보존, 단계적 조회와 제품 격리 경계 구별 |
| PostgreSQL18 | 저장·검색 명세 | 공식 18 문서; 독립 실험18.4 | PostgreSQL License | 문서·독립 SQL 실행. 원자성·문자열 일치·조직/에이전트 equality predicate |
| Radix Themes·shadcn/ui | 공개 부품 예제 | 2026-10-22 공개 배포; 배포 SHA 미공개 | 사이트 코드/이미지 재배포 안 함 | 공개 실화면 조작. 1440/390px 토글·설명 배치, 390px 입력 오류 표시 |

소스 심층 OSS의 root LICENSE를 읽었다. 추가 knowledge-work-plugins는 root LICENSE의 Apache-2.0 본문 뒤 비정형 문구와 대상 두 플러그인 LICENSE를 각각 확인했으며 저장소 전체를 단일 SPDX 표기로 단정하지 않는다. **설계 참고만 하며 소스 복사·새 라이브러리/메모리 제품 도입을 권고하지 않는다.** 구현 때 복사한다면 해당 SHA 파일 header·NOTICE·함께 들어오는 의존성을 다시 확인하고 AGENTS의 출처·루트 고지를 적용해야 한다.

## 근거

확인일은 모두 2026-10-22. 메인이 결정에 쓰는 원문·실행 로그·최종 캡처5장을 다시 열었다. 테스트는 실행 표시가 없으면 읽기만 했다. 제품 기준 SHA는 `c4dda344f6f56c37930b71f632e386f0cff15553`이다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현재 startup은 running을 finishRun으로 끝내지만 입력을 pending으로 돌리지 않는다. finish는 running 행만 잠가 종료하므로 늦은 중복 종료를 막고, 기존 cancelReason을 우선한다. | [failInterruptedRuns/finishRun](https://github.com/babo-jeonguk/BaboJUBot/blob/c4dda344f6f56c37930b71f632e386f0cff15553/packages/db/src/runs.ts#L217-L278), [planRunFinish](https://github.com/babo-jeonguk/BaboJUBot/blob/c4dda344f6f56c37930b71f632e386f0cff15553/packages/core/src/run.ts#L205-L239) | 소스 확인 |
| <a id="E02"></a>E02 | 현재 실행 상세의 wakeReasons·wakeCount와 대화 전달 경계가 wakes.run_id에 의존한다. 이 값만 NULL로 만들면 옛 상세/맥락의 입력 귀속을 잃는다. | [상세](https://github.com/babo-jeonguk/BaboJUBot/blob/c4dda344f6f56c37930b71f632e386f0cff15553/packages/db/src/runs.ts#L520-L540), [대화](https://github.com/babo-jeonguk/BaboJUBot/blob/c4dda344f6f56c37930b71f632e386f0cff15553/packages/db/src/runs.ts#L740-L777), [count](https://github.com/babo-jeonguk/BaboJUBot/blob/c4dda344f6f56c37930b71f632e386f0cff15553/packages/db/src/runs.ts#L800-L808) | 소스 확인 |
| <a id="E03"></a>E03 | Paperclip은 lastHeartbeatAt의 DB 조건부 갱신 후 별도로 enqueue한다. 선점 predicate는 enabled/interval 최신값을 재검사하지 않는다. 선점+영속 wake의 한 transaction이라는 근거가 아니다. | [tickTimers](https://github.com/paperclipai/paperclip/blob/043f2514e67c50320433a0013fb228a75a51325c/server/src/services/heartbeat/scheduling.ts#L1252-L1279), [claimDueTimerHeartbeat](https://github.com/paperclipai/paperclip/blob/043f2514e67c50320433a0013fb228a75a51325c/server/src/services/heartbeat/queue.ts#L614-L642) | 소스 확인 |
| <a id="E04"></a>E04 | Paperclip의 coalesced 경로는 실행 중 run에도 context를 merge할 수 있다. #60의 실행 중 새 입력을 다음 시도로 미루는 계약과 다르다. | [merge into existing run](https://github.com/paperclipai/paperclip/blob/043f2514e67c50320433a0013fb228a75a51325c/server/src/services/heartbeat/queue.ts#L4384-L4461) | 소스 확인 |
| <a id="E05"></a>E05 | Hermes due_prompt는 now로 anchor를 옮겨 missed tick을 합친다. resume은 재anchor, abandon_fire는 더 최근의 pause/clear 변경을 보존한다. 하지만 저장 예외를 삼키고 cached state를 쓴다. | [HeartbeatManager](https://github.com/NousResearch/hermes-agent/blob/8237c7f8ec179c88857f24a174509d985af704b7/hermes_cli/heartbeat.py#L135-L247) | 소스 확인 |
| <a id="E06"></a>E06 | Hermes 원본 module을 SessionDB stub으로 실행했다. due·pause/resume·abandon과 함께 stale manager2개 중복 발화·저장 실패 뒤 prompt 반환을 확인했다. gateway 전체 중복 버그 재현은 아니다. | `probes/hermes-heartbeat.py`, `heartbeat-run-log.txt`; Python3.12.3·18checks PASS, 설치/모델 호출 없음 | 실행 확인 |
| <a id="E07"></a>E07 | LangGraph Item은 namespace/key/value/시각을 갖고 PG 비vector 경로는 updated_at DESC로 회수한다. 호출자가 namespace를 전달하는 store API 자체는 토큰 기반 권한 강제가 아니다. | [Item](https://github.com/langchain-ai/langgraph/blob/3cd57c038ad827d05f80c6488adea9994156c58c/libs/checkpoint/langgraph/store/base/__init__.py#L51-L85), [PG query](https://github.com/langchain-ai/langgraph/blob/3cd57c038ad827d05f80c6488adea9994156c58c/libs/checkpoint-postgres/langgraph/store/postgres/base.py#L549-L565) | 소스 확인 |
| <a id="E08"></a>E08 | LangGraph PG namespace 조건은 equality와 구분자 경계가 있는 escaped LIKE를 함께 사용한다. prefix flattening·wildcard 누출 실패를 고려한 구현이다. | [escape/prefix condition](https://github.com/langchain-ai/langgraph/blob/3cd57c038ad827d05f80c6488adea9994156c58c/libs/checkpoint-postgres/langgraph/store/postgres/base.py#L1279-L1309) | 소스 확인 |
| <a id="E09"></a>E09 | LangGraph 공식 advisory는 namespace prefix 검색의 sibling/_/% 누출과 수정 버전을 설명한다. 이번 SHA의 취약성 재현이라는 뜻은 아니다. | [GHSA-47pj-3jcm-6whg](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-47pj-3jcm-6whg) | 문서 주장 |
| <a id="E10"></a>E10 | OpenClaw는 원 호출의 execution guard를 capture하고 실제 파일 commit 직전 assert한다. provenance 기록 뒤 commit 실패 시 rollback을 시도한다. 프로세스 내 guard·파일 rollback을 PG 영속 격리 보장으로 옮길 수 없다. | [writeFile](https://github.com/openclaw/openclaw/blob/7fe2460b6f1547606b0e790f2876cb2f77b77af4/src/agents/memory-write-provenance.ts#L52-L69), [provenance/rollback](https://github.com/openclaw/openclaw/blob/7fe2460b6f1547606b0e790f2876cb2f77b77af4/src/agents/memory-write-provenance.ts#L130-L158), [원 guard](https://github.com/openclaw/openclaw/blob/7fe2460b6f1547606b0e790f2876cb2f77b77af4/src/agents/agent-tool-source-execution-guard.ts#L69-L92) | 소스 확인 |
| <a id="E11"></a>E11 | pg-boss는 active+id:retry_count로 오래된 실행의 settle/touch를 막는다. plain ID 경로는 선택적 fence이며 public restore 후 counter 재사용 예외를 주석으로 명시한다. | [attemptFence](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L2828-L2897), [touch](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L3287-L3299) | 소스 확인 |
| <a id="E12"></a>E12 | pg-boss 회귀 테스트는 오래된 transactional handler가 ledger에 쓴 뒤 settle하면 해당 쓰기까지 rollback하고 최신 attempt를 유지함을 assert한다. 이번 테스트 실행은 안 했다. | [attemptFenceTest transactional](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/test/attemptFenceTest.ts#L261-L310) | 소스 확인 |
| <a id="E13"></a>E13 | Graphile은 오래된 job/queue 잠금을 한 SQL로 풀지만, completeJobs의 job DELETE는 id만 검사하고 poolId는 queue unlock에만 적용한다. 완전한 stale-completion 방어의 근거로 채택할 수 없다. | [resetLockedAt](https://github.com/graphile/worker/blob/7a2405bdd3b6322fb6b0d48dc0543bcc89166930/src/sql/resetLockedAt.ts#L17-L36), [completeJobs](https://github.com/graphile/worker/blob/7a2405bdd3b6322fb6b0d48dc0543bcc89166930/src/sql/completeJobs.ts#L30-L58) | 소스 확인 |
| <a id="E14"></a>E14 | Paperclip orphan 경로는 running→failed를 CAS하고 wake 실패·retry enqueue를 별도로 처리한다. startup 전체가 #60 입력 복원의 원자적 예시는 아니다. | [orphan recovery](https://github.com/paperclipai/paperclip/blob/043f2514e67c50320433a0013fb228a75a51325c/server/src/services/heartbeat/recovery.ts#L2385-L2445) | 소스 확인 |
| <a id="E15"></a>E15 | Paperclip은 복구 계보에서 같은 operationId/digest의 성공 결과를 회수하며 이전 변경의 결과가 unknown이면 새 키만으로 재실행하지 않는다. 외부 효과에는 별도 결과 재조정이 필요하다. | [priorRecoveryApiReceipt](https://github.com/paperclipai/paperclip/blob/043f2514e67c50320433a0013fb228a75a51325c/server/src/services/recovery-effect-receipts.ts#L9-L78) | 소스 확인 |
| <a id="E16"></a>E16 | PostgreSQL LIKE의 %/_는 wildcard다. literal substring은 position으로 분리할 수 있고, Read Committed에서는 잠금 아래 조건 재검사가 필요하다. | [pattern](https://www.postgresql.org/docs/18/functions-matching.html), [position](https://www.postgresql.org/docs/18/functions-string.html), [isolation](https://www.postgresql.org/docs/18/transaction-iso.html) | 문서 주장 |
| <a id="E17"></a>E17 | 독립 PG 모형13시나리오·42assertions PASS: 동시 due, pending 병합, downtime/disabled, pause/terminal, membership 유실 음성 대조, 복구 rollback/반복, stale token/finish, stable effect key와 payload conflict, attempt별 key 중복, 기존 취소 보존, Memory 격리/출처/literal query, 복구 client SIGKILL rollback. | `probes/postgres-foundations.mjs`, `postgres-foundations-log.txt`; Node24.21.0·PG18.4·pg8.23.1. 제품/queue OSS schema·API를 실행한 결과가 아님 | 실행 확인 |
| <a id="E18"></a>E18 | Paperclip agent 설정은 heartbeat toggle과 seconds 입력을 묶고 off면 입력을 숨긴다. 읽은 구간만으로 next 예정·저장 실패·390px 동작은 입증되지 않는다. | [AgentConfigForm](https://github.com/paperclipai/paperclip/blob/043f2514e67c50320433a0013fb228a75a51325c/ui/src/components/AgentConfigForm.tsx#L2119-L2130) | 소스 확인 |
| <a id="E19"></a>E19 | 공개 Radix switch와 shadcn preferences를 1440/390px에서 클릭해 상태 전환을 확인했다. shadcn 잘못된 1자 입력의 오류도 390px에서 보인다. 서버 저장/실패·heartbeat 예정·pause는 이 예제로 확인하지 않았다. | [Radix 실예제](https://www.radix-ui.com/themes/docs/components/switch), [shadcn 실예제](https://ui.shadcn.com/docs/forms/react-hook-form); `captures/captures.md`, `probes/surface-capture-log.json`; 5장 직접 열람 | 실행 확인 |
| <a id="E20"></a>E20 | LangGraph index 없는 InMemoryStore는 query를 substring 조건으로 쓰지 않고 후보를 순회 순서로 slice한다. 따라서 PG의 updated_at DESC와도 계약이 같지 않다. | [filter](https://github.com/langchain-ai/langgraph/blob/3cd57c038ad827d05f80c6488adea9994156c58c/libs/checkpoint/langgraph/store/memory/__init__.py#L238-L266), [no-vector branch](https://github.com/langchain-ai/langgraph/blob/3cd57c038ad827d05f80c6488adea9994156c58c/libs/checkpoint/langgraph/store/memory/__init__.py#L304-L373); E07 | 소스 확인 |
| <a id="E21"></a>E21 | 원본 InMemoryStore import15checks PASS: exact namespace 분리·sibling/_/% 음성 대조·빈 prefix 전체 회수·query 미필터링·최근순 아님·동일 key overwrite. 실제 PG/제품 권한 검증은 아니다. outbound network 차단·요청0 확인. | `probes/langgraph-memory.py`, `memory-run-log.txt`; Python3.12.3·index 없음·langchain-core 실제 import, 모델/embedding 호출 없음 | 실행 확인 |
| <a id="E22"></a>E22 | OpenClaw 원본 TS2modules를 transpile하고 authority/fs/provenance imports를 doubles로 대체한5checks PASS: 정상 쓰기·await 중 revoke·retained callback의 다음 호출 권한 차용·unclassified 쓰기·EACCES pre-read 경계. | `probes/openclaw-memory-guard.cjs`, `openclaw-memory-run-log.txt`; Node24.21.0·TS6.0.3, 전체 gateway/session DB 실행 아님 | 실행 확인 |
| <a id="E23"></a>E23 | ai-memory는 keyed observation과 키를 같은 SQLite tx에 저장하고 기존 key를 미완료/완료로 나눈다. live admission은 session owner/agent를 검사한 뒤 입력을 저장한다. | [insert_observation_keyed](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/ops.rs#L3031-L3117), [admission](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/ops.rs#L3155-L3207) | 소스 확인 |
| <a id="E24"></a>E24 | 완료 key는 replay로 반환하고 미완료 key는 후속 처리를 재시도한다. 완료 marker 저장은 후속 효과 뒤 별도 갱신이다. 따라서 이 구조만으로 전체 효과의 exactly-once는 도출되지 않는다(추론). | [resume 분기](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-hooks/src/router.rs#L4321-L4332), [tail 완료](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-hooks/src/router.rs#L4775-L4785), [marker](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/ops.rs#L3759-L3793) | 소스 확인 |
| <a id="E25"></a>E25 | 일반 ingest key는30일 후 sweep 대상이고 recovery key는 session/agent/event/content identity와 결합해 보관 예외를 둔다. 일반 key에는 같은 key/다른 payload를 거부하는 일반 digest 검사가 없다. | [TTL·identity](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/ops.rs#L2996-L3030), [claim·binding](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/ops.rs#L3270-L3343) | 소스 확인 |
| <a id="E26"></a>E26 | 프로젝트 scope는 cwd/override와 연결되며 root는 사용자 grant 검사를 생략한다. handoff는 scope/open/owner 조건부 UPDATE로 claim한다. owner는 개인 operator, agent_kind는 harness 종류이므로 Babo 연구 agent와 같지 않다. | [authorize_scope_for](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/scope.rs#L486-L522), [session scope](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/ops.rs#L3155-L3207), [claim](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/src/ops.rs#L5164-L5214) | 소스 확인 |
| <a id="E27"></a>E27 | ai-memory PageEvidence는 source kind/id와 재인용 unique를 두지만 source_id는 opaque다. 이 스키마는 참조 원본의 동일 조직 소속을 검증하는 FK가 아니다. | [PageEvidence](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-core/src/page.rs#L84-L123), [V63](https://github.com/akitaonrails/ai-memory/blob/ae7b8bba8c056e478592c0972669c8371152bac9/crates/ai-memory-store/migrations/V63__page_evidence.sql#L1-L31) | 소스 확인 |
| <a id="E28"></a>E28 | 공식 ai-memory3.2.0 바이너리의 격리 HTTP probe16개 PASS. 완료 입력의 실제 서버 SIGKILL/재시작, 주입한 미완료 상태 재개, key TTL·무키·다른 payload 음성 대조, handoff 재전달, root의 project 선택을 확인했다. | `probes/ai-memory-runtime.py`, `ai-memory-runtime-log.json`, `selfhost/ai-memory.md`; Docker network=none·2GiB·합성 데이터. 배포 checksum 일치, 재현 빌드 미확인 | 실행 확인 |
| <a id="E29"></a>E29 | productivity memory-management는 cwd의 CLAUDE.md → memory/glossary.md → 세부 파일의 단계적 조회를 지시한다. 조직 신원을 강제하는 런타임 계약으로 해석할 수 없다. | [기억 구조·조회·위치](https://github.com/anthropics/knowledge-work-plugins/blob/33d3dea41a341b341d4f5da2e8801ae0c89be2b8/productivity/skills/memory-management/SKILL.md#L27-L76) | 문서 주장 |
| <a id="E30"></a>E30 | enterprise-search는 같은 내용의 모든 출처를 남기고 결론/관점/시점이 다른 항목은 보존하도록 지시한다. 출처 위치·시점·저자·제목 및 상충 표시 지침은 표현 참고이며 source ID 권한 검사는 아니다. | [합성·출처](https://github.com/anthropics/knowledge-work-plugins/blob/33d3dea41a341b341d4f5da2e8801ae0c89be2b8/enterprise-search/skills/knowledge-synthesis/SKILL.md#L35-L100), [확신·상충](https://github.com/anthropics/knowledge-work-plugins/blob/33d3dea41a341b341d4f5da2e8801ae0c89be2b8/enterprise-search/skills/knowledge-synthesis/SKILL.md#L102-L163) | 문서 주장 |
| <a id="E31"></a>E31 | productivity dashboard는 사용자가 고른 디렉터리의 file handle에 직접 쓴다. 조사한 load/save 함수에서 조직/attempt 검증·동시 쓰기 조정을 확인하지 못했다. 정적 probe18개 PASS는 소스 구조 확인이며 플러그인 실행 검증이 아니다. | [load](https://github.com/anthropics/knowledge-work-plugins/blob/33d3dea41a341b341d4f5da2e8801ae0c89be2b8/productivity/skills/dashboard.html#L2574-L2624), [saveModal](https://github.com/anthropics/knowledge-work-plugins/blob/33d3dea41a341b341d4f5da2e8801ae0c89be2b8/productivity/skills/dashboard.html#L3019-L3086); `probes/knowledge-work-plugins-static.log` | 소스 확인 |

## 패턴

아래 패턴과 결정 권고는 근거 E에서 도출한 추론이다. 외부 제품의 동작 보장을 BaboJUBot의 보장으로 옮기지 않는다.

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 주기 상태 갱신+영속 wake를 한 transaction으로 만들고 일반 admission을 소비 | E03–E06,E17 | Paperclip은 claim/enqueue 분리, Hermes는 세션 cache와 driver acceptance. Babo는 PG 영속 입력 | 설정/중복 tick/crash 경계가 한곳 | claim 뒤 crash gap·stale 설정·busy cadence 폭주. 단일 서버라도 DB 원자성 필요 |
| <a id="P02"></a>P02 | token에서 권한 scope를 도출하고 검색 조건과 분리 | E07–E10,E16,E17,E20,E21 | namespace API는 caller-trusted. Babo는 조직·자기 agent ID equality와 출처 검증을 강제 | 조직/개인 기억 구별·비vector 최소 port | namespace prefix/wildcard·metadata 덮어쓰기·외부 source ID로 우회 |
| <a id="P03"></a>P03 | 입력 identity·과거 membership·현재 pending을 분리 | E01,E02,E13,E14,E17 | queue unlock는 과거 run 입력 이력 보존을 대신하지 않음 | 동일 입력을 새 시도에 전달하면서 옛 상세 유지 | pointer만 NULL이면 이력·대화 전달 경계 손실. migration/backfill 필요 |
| <a id="P04"></a>P04 | 실행 소유권 검사와 논리적 효과 중복 방지를 각각 적용 | E10–E15,E17,E22 | pg-boss attempt fence는 오래된 settle 방어, Paperclip receipt는 성공/unknown outcome 구분 | 새 시도는 허용하면서 오래된 token·중복 효과 방지 | run ID는 effect key로 부적절. 다른 payload의 같은 key는 충돌. 외부 효과까지 exactly-once는 아님 |
| <a id="P05"></a>P05 | 설정·다음 예정과 실행 가능 상태를 구별해 표시 | E05,E18,E19 | CLI next-in/paused, agent toggle+interval, 공개 부품은 local state만 확인 | off·pause·저장 오류를 사용자가 구별 | 브라우저가 임의 계산한 다음 시각/저장 성공으로 오인, 좁은 폭 버튼 접근성 |

## 사용자 지정 저장소 추가 조사

2026-10-22에 두 저장소를 추가했다. 초기49행과22개 근거를 보존하고 E23–E31을 이어 붙였다. 총31개 근거는 소스 확인21·실행 확인6·문서 주장4다. 기존 조사용80개 검사에 ai-memory 동작16개를 추가했으며, 플러그인 정적18개는 별도로 센다. 재실행은 중복 합산하지 않는다.

- **ai-memory:** hook 수집 → session 귀속 검사 → 입력/키 원자 저장 → 후속 처리 → 완료 marker 경로를 추적했다. HEAD와 실행 release는 다르지만 LICENSE·ops/scope/router/payload/init/ARCHITECTURE의7개 파일 blob이 동일함을 대조했다. 재시작 뒤 미완료 처리를 이어가는 패턴은 Q3/Q4에 유용하다. 일반 키 TTL 이후 같은 입력이 다시 저장되고, 일반 키의 다른 payload도 replay로 인정되는 음성 대조가 있어 D07의 보관/충돌 계약을 더 명확히 해야 한다.
- **knowledge-work-plugins:** productivity와 enterprise-search를 심층 조사하고 인접 업무 skill을 교차 탐색했다. 출처와 상충 보존은 Q2의 기억 표현에 참고한다. 프롬프트의 fuzzy/content dedup은 답장/기억 쓰기 재전달의 멱등성이 아니다. host·connector·파일 권한 전체를 조사한 것으로 일반화하지 않는다.
- 두 추가 Discovery의 마지막 라운드는 각 저장소에서 찾은 입력/완료·scope·출처 패턴의 변형이었다. 검색 경로와 국소 포화는 `notes/ai-memory-discovery.md`, `notes/knowledge-work-plugins-discovery.md`에 남겼다. Q1/Q5에는 새 heartbeat 메커니즘 근거를 추가하지 않았다.

| 추가 패턴 | 근거 | #60 적용 판단 |
|---|---|---|
| 입력이 저장됐다는 사실과 모든 후속 효과가 완료됐다는 사실을 구별 | E23–E25,E28 | D07 보강. 효과와 결과를 같은 DB tx에 넣을 수 있으면 그 경계로 해결한다. 다단계 처리가 실제 필요할 때만 durable pending/complete와 단계별 멱등성을 둔다 |
| 출처의 종류/ID·표시 필드와 원본 접근 권한을 각각 검증 | E26,E27,E30 | D03/D04 보강. 권한은 신원·동일 조직 참조 검사로 강제하고, 출처 시점/저자·상충 정보는 후속 표현에서 보존한다 |
| cwd hot/deep 기억·wiki/FTS/RRF·내용 유사성 병합 | E26,E29–E31 | D09와 후속 기억 조사. #60의 DB port·조직 격리·효과 ledger를 대체하는 방식으로 채택하지 않는다 |

## 결정 권고

권고의 owner는 #60 구현 담당자다. 아래 정책 선택의 열린 항목은 사용자 결정 전 확정 계약으로 쓰지 않는다.

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 변형 채택 | 주입 clock의 tick에서 조직→agent 잠금 아래 최신 enabled/interval/nextDue를 읽고, due 진행·heartbeat wake·필요 Event를 한 tx로 저장한다. commit 뒤 기존 dispatcher를 촉진한다. 모든 wake는 같은 admission을 지난다. | P01; E03,E17; #60 AC1 | Paperclip의 claim→enqueue crash gap을 복사하지 않음. heartbeat는 source FK가 있는 기존 wake와 다른 종류라 kind/source CHECK도 확장 필요 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | downtime은 한 번으로 합치고 pending heartbeat를 무한히 쌓지 않는 방향을 권고한다. 실행 중에는 다음 실행 입력으로 보존하고 다른 pending wake와 합친다. due는 실행 종료나 다른 message wake가 아니라 주기 상태에서 정한다. 구체 anchor/off 정책은 열린 결정 | P01; E04–E06,E17 | 모든 missed tick 재생은 비용/폭주 위험. pending heartbeat coalesce가 작업·메시지 wake를 버리면 안 됨 | Q1 |
| <a id="D03"></a>D03 | 채택 | core에 저장 엔진 의존 없는 `write(scope, entry, 출처)`/`recall(scope, query)` port를 두고 db가 구현한다. 공개 scope는 organization/self-agent 구분만 받으며 조직/소유 agent/작성자 run은 인증 신원에서 도출한다. 각 행과 모든 읽기·쓰기·출처 참조에 조직 경계를 강제한다. | P02; E26,E27,E31; #60 AC2/3; AGENTS | namespace 문자열이나 모델 metadata를 authority로 쓰지 않음. 다른 agent 기억은 조회에서 제외하고 타조직·없는 출처 ID는 동일한 응답 계약으로 거부 | Q2,Q4 |
| <a id="D04"></a>D04 | 변형 채택 | 기억은 최소 entry·server-derived provenance·저장 순서를 보존한다. scope equality 뒤 제한된 literal 문자열 회수와 안정적인 최근순을 구현한다. 입력의 %/_/역슬래시는 검색 연산자로 해석하지 않는 방향을 권고하며 query의 세부 계약은 열린 결정 | P02; E07–E09,E16,E17,E20,E21,E27,E30 | BaseStore 형태만 참고. 무embedding store가 자동으로 문자열 검색/동일 정렬을 제공한다고 가정하지 않음. embedding·ranking·consolidation·명시적 공유는 후속 기억 범위 | Q2 |
| <a id="D05"></a>D05 | 채택 | startup은 scheduler/dispatcher admission 개방 전에 이전 running을 닫는다. 실행 시도별 tx에서 terminal 전이·서버 재시작 원인·pending 복원·Event를 함께 저장한다. 기존 취소 사유는 보존하고 미저장 성공을 추정하지 않는다. 재호출은 no-op이어야 한다. | P03; E01,E14,E17; #60 AC4 | 한 번에 모든 조직을 잠글 필요 없이 tx 단위 재개 가능. 같은 run/토큰을 다시 활성화하지 않음. 단일 서버 소유 전제 밖 lease/worker 복구는 범위 밖 | Q3,Q4 |
| <a id="D06"></a>D06 | 변형 채택 | 불변 run-input membership을 추가/분리하고 현재 pending 표시는 별도로 되돌린다. 구현 형태는 join table+현재 pointer 또는 replay delivery+원본 입력 ID 중 선택 가능. 기존 데이터 backfill, 상세·count·대화 bounds·맥락 조회도 이력을 읽게 정합화 | P03; E02,E17; #53 인계 | run_id NULL 갱신만으로 AC4를 만족했다고 하면 옛 실행 기록이 깨진다. 새 입력이 동시에 쌓여도 원래 입력 identity는 유지 | Q3 |
| <a id="D07"></a>D07 | 변형 채택 | 재시작 뒤 새 run ID/토큰을 발급하고 읽기·쓰기·종료 모두 원래 run의 active/cancel fence를 재검사한다. 로컬 DB 효과는 논리적 원본 입력/작업+operation key+도구+범위로 식별하고 request digest·결과를 효과와 같은 tx에 저장/재반환하는 최소 멱등성 경계를 마련한다. | P04; E10–E12,E15,E17,E22–E25,E28 | 최소한 가짜 시나리오의 답장·기억 쓰기 replay를 검증. attempt ID·전체 batch ID·본문 동일 여부만으로 dedupe하면 새 입력 병합/의도적 같은 본문에서 깨진다. 범용 모든 도구 journal 확장은 별도 선택. 입력 dedup과 후속 완료를 구별하며 같은 DB tx로 해결 가능하면 새 다단계 상태 기계를 도입하지 않음 | Q3,Q4 |
| <a id="D08"></a>D08 | 변형 채택 | agent 상세에 enabled·간격/단위·Role 기본값/사용자 값·서버의 다음 예정/보류 상태를 함께 둔다. 저장 중 제어, 실패시 입력 보존과 저장값 표시, 다른 탭 Event 재조회, off/pause/종료를 구별한다. 다음 due는 실행 시작 보장시각으로 쓰지 않는다. | P05; E05,E18,E19; #60 AC5 | 공개 부품은 토글/오류 배치만 근거. 저장 실패·예정·pause의 실제 사용자 흐름과390px는 #60 구현에서 검증해야 함 | Q5 |
| <a id="D09"></a>D09 | 배제 | 새 Redis/queue/workflow/메모리 제품, heartbeat=즉시 모델 호출, 실행 중 입력의 현재 run merge, namespace global search, 과거 run 부활, 일반 실행 재시도·외부 효과 exactly-once 보장을 도입하지 않는다. | P01–P05; ADR1/2/4; #49 범위 | 초기 승인·최종 완료·조직 격리를 제품 코드에서 유지. 연구 판단/모델 품질을 이번 스케줄링·저장 조사로 확정하지 않음 | Q1–Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| lastHeartbeatAt 선점 후 별도 enqueue / cached manager만으로 선점 | E03,E05,E06 | 영속 wake 누락·저장 실패·stale 상태의 반례. tx 없이 제품 보장으로 쓰지 않음 |
| running run context에 새 wake merge | E04 | ADR2의 다음 실행 반영 위반 |
| raw namespace prefix·_/% 검색을 권한 경계로 사용 | E08,E09,E16 | 검색 범위 확대·사적 기억 누출 |
| wake pointer만 reset / 오래된 attempt ID로 완료 | E02,E11,E13 | 과거 입력 이력 손실·최신 실행 침범 |
| 같은 본문이면 무조건 중복 / 새 run 키면 멱등 | E15,E17 | 의도적 반복을 지우거나 crash 재전달 효과가 중복됨 |
| 모델 지침/하네스가 조직 기억·승인·완료 권한을 강제 | AGENTS; D03,D09 | 제품 코드 강제를 대체할 수 없음 |

## 구현 참고

권고 요약은 **영속 주기 입력 → 기존 admission, 신원 기반 최소 Memory port, 불변 입력 이력+원자 복구+새 실행 권한, 논리적 효과 멱등성**이다. 다음은 위치 안내이며 스키마·파일명 확정이나 구현 착수가 아니다.

| 위치 | #60의 책임·주의 |
|---|---|
| `packages/contracts` | heartbeat 설정/응답·wake kind·Memory 도구/응답/출처·복구 원인/Event. run stopReason과 사용자 cancelReason과 interruption 원인을 혼동하지 않음 |
| `packages/core` | Memory port/scope 규칙·heartbeat due 계획. 기존 admitsRuns/checkToolCall/acceptsToolCalls 소비. DB·웹 의존 없음 |
| `packages/db` | agent 주기 상태·Memory adapter·출처/소유권 복합 참조·run-input 이력·migration/backfill·복구/도구 결과 transaction. 최신 상태는 잠금 아래 재검사 |
| `apps/server` | clock/scheduler 수명주기·startup recovery 순서·기억 도구 handler·commit 뒤 dispatch/Event. 설정 변경은 사용자 경로·조직/agent 범위 강제 |
| `apps/web` | `agents.tsx` 상세·API query/Event invalidation·저장 폼·서버 예정 상태. 조직 설정 화면으로 옮기지 않음 |
| `packages/runtime`, `harness` | 가짜 실행기의 heartbeat/기억·crash replay 시나리오, Role 기본 간격 metadata. 실제 모델 호출 없음. 사본 편집 UI/revision은 후속 #64 |

다음 검증은 **#60 구현의 완료 조건을 구체화하는 참고**이며 이번에 제품에서 통과한 테스트 목록이 아니다. 주 seam은 #49의 HTTP API+가짜 실행기+주입 시계이고 고정 sleep·DB 직접 조작으로 성공을 대신하지 않는다. 실제 process crash는 별도 subprocess fixture가 필요하다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | heartbeat on→시계를 간격만큼 이동→heartbeat wake/run. 같은 now의 중복 tick·동시 호출→한 due만 소비; off→새 주기 입력0 | D01,D02; AC1 |
| V02 | 실행 중 message+여러 tick→현재 입력 불변·다음 run 하나에 pending 모두. 긴 downtime→선택한 catch-up 수·nextDue, 다른 wake가 cadence를 임의 연장하지 않음 | D01,D02 |
| V03 | tick과 off/간격 수정 경합·중간 저장 실패→선택한 설정 선형화/rollback. 서버 재시작→저장된 due로 재개; Role 기본과 사용자 override 구별 | D01,D02,D08 |
| V04 | 조직/agent pause 중 tick·복구→새 adapter 호출0·pending 보존; resume→병합. stopped/completed→어떤 heartbeat/replay도 새 run0. 승인 전 worker 생성/연구 쓰기는 기존 gate 거부 | D01,D05,D09 |
| V05 | A.agent1 write self→agent2 recall0; A 조직 기억→agent1/2 회수. B ID·owner override·scope 누락·교차 출처 참조→우회 불가. 종료/취소 token은 읽기·쓰기 모두 거부 | D03,D04; AC2/3 |
| V06 | 같은 시각 entry 여러 개·빈 query·%/_/역슬래시·한글/대소문자·limit→선택한 문자열/최근순 계약. source의 작성 run은 server-derived, 원본 연구 기록은 유지 | D03,D04 |
| V07 | 실행 중 앱 subprocess SIGKILL→재시작→옛 run에 재시작 원인·원래 입력/count 보존, 새 run/새 token에 동일 입력 전달. 기존 취소 사유/다른 terminal run은 보존 | D05,D06; AC4 |
| V08 | 복구 tx 전/중/commit 직후 crash·startup 반복→run 종료와 wake 복원이 함께 rollback/commit·중복 복구 Event0. adapter 시작 전 복구 완료 | D05,D06 |
| V09 | 답장/Memory commit 뒤 결과 응답 전 crash→새 run replay→같은 effect key는 기존 결과1회, 동시 중복 호출도 한 결과, 다른 payload는 충돌. 새 message가 병합돼도 옛 효과는 반복0·새 효과는 생성 | D07 |
| V10 | 옛 token/늦은 종료/늦은 Memory commit·다른 조직의 같은 key→최신 실행·다른 조직을 변경하지 않음. 한 원본 입력의 서로 다른 operation과 의도적 동일 본문2개는 보존 | D03,D07 |
| V11 | agent 상세1440/390px→on/off·간격/단위 수정·저장 실패/재시도·다른 탭 갱신·pause/종료→서버 저장값/예정 상태 구별, 폼·오류·버튼 접근 가능 | D08; AC5 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 기본 heartbeat on/off·Role 간격·허용 범위·설정 변경 anchor | 사용자 / #60 | off 기본+Role 간격 vs Role별 enabled 기본. enable/간격 변경 때 now+interval vs 기존 phase 유지. 사례의 숫자를 제품 기본값으로 복사하지 않음(E03,E05,E18) |
| downtime·pause·끄기 이후 이미 생성된 heartbeat | 사용자 / #60 | 한 pending으로 합치기 권고 vs miss 모두 보존. off는 미래 생산만 중지+기존 pending 보존 vs 아직 미전달 heartbeat 취소(기록은 보존). pause 중 일반 wake 보존은 확정; tick 생산/anchor의 자세한 정책은 분리(D02,V02–04) |
| 출처·query의 최소 계약 | #60 | provenance는 run/agent 자동 기록+같은 조직의 typed record refs 권고 vs 추가 사용자 설명 허용. query는 literal case-sensitive+빈 값 최근순+상한/순서 명시 vs ILIKE/casefold. 검색 의미를 adapter 기본값에 맡기지 않음(D03,D04) |
| 멱등성 공개 범위·표현·보관 | #60 | 최소 reply/Memory의 안정 operation key+결과 ledger 권고 vs 모든 변경 도구 공통 journal. 재처리 가능 기간 동안 결과를 보존해야 하며 임의 TTL 삭제는 중복을 다시 허용(D07,E25,E28). ai-memory의30일을 Babo 기본값으로 복사하지 않는다. 새 모델이 다른 의도를 만드는 문제까지 해결했다고 하지 않음 |
| crash 전 취소 요청이 저장된 running의 재전달 | 사용자 / #60 | #60 문언대로 모든 잔여 running 입력 복원+기존 취소 사유 보존 vs 명시 취소 입력은 재전달 제외(현행 #60 문언과 **상충 — 사용자 판단**, 이슈 수정 전 미적용). #59 일반 취소를 자동 retry로 바꾸지 않도록 구별. 어느 경우든 stopped/completed admission은 닫힘(D05,V04,V07) |

후속 #61은 알림 outbox·채널/Inbox 전송, #63은 전체 흐름 데모/E2E, #64는 하네스 사본 편집/revision이다. #60의 durable wake·복구 Event·기억 격리·agent 설정 화면을 그쪽으로 미루지 않는다. 명시적 조직 간 기억 공유·기억 기법/저장 엔진·외부 job/예산·실제 adapter crash 이후 외부 프로세스 종료 증거는 #49의 후속 판/기억 이슈이며 현재 별도 번호가 없어 열린 범위로 둔다.

## 한계와 미확인

- 추가 ai-memory 실행은 공식 바이너리·합성 root bearer·네트워크 없는 컨테이너에 한정한다. pending/age는 서버 정지 중 테스트 SQLite에 주입했으며 정확한 후속 효과 중간 crash·동시 key 경합·multi-user grant·실제 hook/UI·전체 cargo suite는 미실행이다. root의 project override는 upstream 권한에 맞는 동작이며 취약성 주장이 아니다.
- 추가 knowledge-work-plugins는 원문·정적18개 검사만 확인했다. 실제 host·모델·인증 connector·브라우저 실행과 저장 복구/조직 격리는 미확인이다. 단계적 조회·wiki/검색/정리 기법과 자동 요약 품질은 후속 기억 조사에 남긴다.
- 이 조사에서는 실제 BaboJUBot #60 기능·API·migration·대시보드/E2E를 구현·실행하지 않았다. PG13시나리오/42검증은 독립 모형이고 SIGKILL도 DB client 프로세스에 대한 것이며 제품 서버/PG 자체의 crash 검증이 아니다.
- Hermes는 원본 작은 module+stub 실행이다. LangGraph 원본15checks·OpenClaw 제한5checks도 adapter 전체/PG 보안의 증명이 아니다. Paperclip·OpenClaw·pg-boss·Graphile 전체 앱/테스트는 실행하지 않았다. 공개 예제는 local UI 동작이며 저장 실패·nextDue·pause 실화면은 미확인이다.
- 공개 GitHub read는 기본 sandbox network 실패 뒤 허용된 escalation으로 확인했다. 공식 페이지/이슈의 검색 요약만 본 후보는 결정 근거에서 제외했다. 유료 Graphile Pro heartbeat·관리형 memory·로그인 서비스·실제 모델·자격 증명 경로는 실행하지 않았다.
- 외부 효과/프로세스는 DB transaction만으로 취소·exactly-once를 보장하지 않는다. 단일 서버의 교체 프로세스가 이전 실제 adapter를 확실히 종료했는지는 실제 adapter 판에서 확인한다. unknown outcome을 성공/실패로 추정하지 않는다.
- 후보 운영 상태는 확인일 기준이다. 새 버전에서는 source/blob·검색/복구 계약을 다시 확인한다. 코드 복사 시 root LICENSE 외 header/NOTICE/의존성 고지는 별도 확인한다.
- 열린 정책은 위 owner가 결정할 때 갱신한다. 이 조사는 이슈 본문·제품 불변 조건·ADR을 변경하거나 일반 재시도 정책을 확정하지 않는다.
