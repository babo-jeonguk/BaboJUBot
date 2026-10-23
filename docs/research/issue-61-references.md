# issue-61 레퍼런스 조사: 알림 outbox, 가짜 채널, Inbox 완성

조사일: 2026-10-23 (Asia/Seoul). 대상: [#61](https://github.com/babo-jeonguk/BaboJUBot/issues/61), parent [#49](https://github.com/babo-jeonguk/BaboJUBot/issues/49). 구현 전 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-61/`(git 무시). 제품 코드·테스트·설정은 변경하지 않았으며 이 문서는 커밋하지 않고 구현 변경과 함께 커밋되게 둔다.

[이슈 receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/61#issuecomment-6363457996)를 게시하고 원문과 결정 표의 일치를 확인했다.

권고의 중심은 **업무 원본, Inbox 정리 상태, 채널 전송 상태를 분리**하는 것이다. 업무 쓰기와 전송 의도를 한 transaction에 남기고, 가짜 채널 입력은 기존 사용자 HTTP 명령으로 보낸다. 전송 성공이나 읽음·보관으로 승인·최종 완료를 대신하지 않는다.

## Brief

- 구현할 문제: Lead 보고·질문, 승인 요청, 결과 제출, 실패한 실행 시도의 알림 outbox와 가짜 채널; 실패 항목·읽음·보관·구분을 갖춘 Inbox; 전역 설정 자리와 셸 진입점.
- 동종 문제: 영속 업무 사건을 사용자 대기열과 재전송 가능한 외부 알림으로 투영하고, 응답을 같은 사용자 명령으로 환원하는 메커니즘.
- 고정된 결정: [AGENTS](../../AGENTS.md)의 조직 경계·필수 초기 승인·사용자 최종 완료, [용어](../../GLOSSARY.md), [기능](../features.md), [전체 구조](../architecture.md), [ADR-0001](../adr/0001-adapter-control-plane.md)·[0002](../adr/0002-durable-records-and-wakes.md)·[0003](../adr/0003-configurable-approval-policy.md)·[0004](../adr/0004-paperclip-aligned-stack.md)를 따른다. TS·Postgres·단일 서버와 영속 기록/깨우기는 유지하며 새 Redis·broker·메모리 제품을 고르지 않는다.
- [#50 사용자 결정](https://github.com/babo-jeonguk/BaboJUBot/issues/50#issuecomment-6161637737)이 화면 배치의 기준이다. Inbox는 패널 하나(1280px 이상 오른쪽 340px, 아래 drawer), 전체/현재 조직 범위, 주의 필요·안 읽음·작업 중·전체·보관됨 필터와 개수다. 768px 미만 상단 Inbox, 레일 전역 설정, 상세 본문과 읽음/보관·도메인 결정 분리도 유지한다.
- 현재 Inbox는 pending 승인/결과를 업무 원본에서 조회한다. 이슈 이월 댓글과 달리 레일 Inbox 버튼은 이미 있다. 별도 임시 목록 페이지·모바일 진입점·전역 설정·패널의 현재 상태를 구분해 이어 붙여야 한다(E01–E04).

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 네 사건의 업무 쓰기와 outbox를 원자적으로 남기고 누락·중복을 통제하는가? | #61 What to build 1·AC1, ADR2/4 | Source Recon + persistence/recovery·PG failure probe |
| Q2 | 가짜 채널의 claim·lease·재시도·재시작·중복 전송·성공 기록은 어떤 계약인가? | #61 What to build 2·AC1 | Source Recon + runtime/failure·mock delivery |
| Q3 | 채널 승인 입력을 같은 HTTP 명령에 연결하면서 조직·권한·중복·오래된 결정의 경계를 지키는가? | #61 What to build 2·AC2, AGENTS | Source Recon + adversarial scenario·원본 guard 실행 |
| Q4 | 주의 필요/작업 중, 읽음·보관, 실패 항목·badge를 어떻게 분리·저장하는가? | #61 What to build 3·AC3/4, #57 인계 | Source Recon + persistence/recovery |
| Q5 | Inbox 진입점·상세 이동·필터·읽음/보관과 빈/로딩/실패/다른 탭/390px, 전역 설정 자리를 어떻게 제공하는가? | #61 AC4, #52 이월, #50 결정 | Surface Capture + Behavioral Recon + Source Recon |

| 재사용한 조사 | 쓰는 범위 | 재확인 |
|---|---|---|
| [#50](issue-50-references.md#brief)·[Paperclip 화면](paperclip-dashboard.md) | 고정 배치, 실패 최신화·local read 반례의 탐색 | #50 댓글과 prototype 고정 소스 재독. upstream은 이번 SHA 원문으로 재조사하며 옛 캡처를 새 실행으로 세지 않음 |
| [#52](issue-52-references.md#brief) | 셸·global/org 범위·event invalidation | 현행 shell/live-events 원문 재독 |
| [#54](issue-54-references.md#brief)·[#57](issue-57-references.md#brief) | pending approval/result 원본과 단일 결정 | 선행 이슈 둘 모두 closed 확인, 댓글과 현행 db/inbox·approvals·results 재독 |
| [#59](issue-59-references.md#brief) | 취소와 실패 구별·잠금 순서 | 현행 core/run·db/runs 재독 |
| [#60](issue-60-references.md#brief) | 영속 입력·호출 키·재시작 복구·PG queue | pg-boss/Graphile/Transaction Outbox 동일 SHA 확인 및 관련 파일 blob 비교·재독. 상세 `recon/outbox-discovery/blob-comparison.json` |
| [기타 화면 조사](dashboard-references.md#6-babojubot이-고려할-기능--설계-제안-결정-아님) | 승인 링크는 식별과 권한이 다르다는 출발점 | OpenClaw 새 SHA·공식 보안 권고·원본 guard 별도 확인 |

## 레퍼런스

후보 전체와 실행 경로는 `candidates.md`, 라운드별 검색은 `notes/{outbox,channel,inbox,local-boundaries}.md`에 있다. 검색한 경로의 포화를 뜻하며 전체 생태계 소진을 주장하지 않는다.

| 관점 | Saturation 근거 |
|---|---|
| PG outbox·전송 복구 | 11후보·4라운드. 마지막 의존/사용처·exporter·운영 문서 확장은 원자 쓰기/전송 분리, lease 상실, retry·retention·순서·postcommit hint의 기존 유형을 반복 |
| 채널 입력·승인 신뢰 경계 | 8후보·3라운드. 마지막 GitHub/Standard Webhooks는 서명·수신확인·delivery ID·재전달을 반복. 앞 라운드에서 Matrix의 device+endpoint 중복 scope와 실제 승인 우회 반례 추가 |
| Inbox·알림 SDK·인접 triage | 13후보·3라운드. 마지막 registry/오류 검색은 read/archive/count/rollback·keyboard·undo를 반복. count가 맞아도 renderer 실패로 목록이 비는 변형은 검증 시나리오로 남김 |
| 공식 DB·설계 원리 보완 | 신규 2후보(원저자 outbox 패턴, Confluent), AWS·PG는 위 후보 재사용. 3라운드의 마지막 교차 검색은 rollback·relay duplicate·poll/CDC·순서 제약으로 수렴 |

| 레퍼런스 | 분류 | 버전·고정 SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|---|
| pg-boss | TS/PG queue | `d4400859eed280b58c346f5289a0312913d558bd` | MIT | 소스·실행. 원 tx enqueue와 attempt fence, restore 예외 |
| Transaction Outbox | Java outbox | `adabceb6d062c39baf33891d7910c369c925cbf3` | Apache-2.0 | 소스. postcommit 가속+poll 복구·dedup 보존, 긴 transaction 반례 |
| OpenClaw | agent 채널/승인 | `3b153699457f0f51c6d84d3e5ad8ddd29780b9ef` | MIT | 소스·제한 실행. 실제 권한 우회 사례와 원 actor 재검사 |
| Paperclip | 업무 Inbox | `412914cfa78d5abefcc34d3eb8d4bb86e461caac` | MIT | 소스. 혼합 상태·실패 최신화·badge·보관과 업무 결정 분리 |
| Novu | 알림 SDK | `14c6c4faf106292a20bacdb9c54c73f40ed93553` | 루트 core MIT·enterprise 별도, JS metadata ISC | 소스. read/seen/archive/action 차원과 action 오류 결과 반례 |
| Plane | 인접 업무 알림 | `490619341f856b692fb7c845364f0d4585ebee2a` | 루트 AGPLv3, 파일 AGPL-3.0-only | 소스. 영속 read/archive와 receiver/workspace 범위. 전체 제품 실행 제외 |
| Knock JS | 알림 SDK | `b429cf037dedcde794143bb8f85f6bc1532741d9` | MIT | 소스. 같은 filter 범위의 count/bulk, 다른 탭 재조회. 플랫폼 도입 제외 |
| Courier Web | 알림 UI | `105379f72aaba48db9d5080a5ca410869a57f9fa` | MIT | 소스·preview 실행. 키 없는 실화면과 preview 한계 |
| Graphile Worker / PGMQ | queue 반례 | `7a2405bdd3b6322fb6b0d48dc0543bcc89166930` / `8efb078dbe7afe16c83be72e9fffefbb03ebd9e9` | MIT / PostgreSQL | 소스. queue/visibility와 stale ack 방어 차이 |
| PostgreSQL 18 / outbox 원저자·AWS / Slack·Matrix | 공식 DB·설계·채널 명세 | 2026-10-23 열람 | 문서·명세 범위 | 문서/SQL 실행. 원리·제약 비교, 클라우드·실채널 실행 없음 |

모두 **설계 참고**다. 라이브러리 도입이나 코드 복사를 권고하지 않는다. 복사하게 되면 해당 SHA의 파일 header·NOTICE·의존성을 다시 확인하고 AGENTS의 파일 출처·루트 고지 규칙을 적용한다.

## 근거

각 수준은 해당 범위만 보증한다. 테스트를 읽은 사실을 실행으로 세지 않았고, 독립 SQL 모형·mock transport·preview를 제품 API/실채널 통합 검증으로 세지 않았다. 메인의 원문 대조는 `main-verification.md`에 기록한다.

| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현행 Lead 메시지·초기 승인·작업자 추가 승인·결과 제출은 각각 업무+Event의 tx를 가진다. 알림을 붙일 경로가 하나는 아니다 | 현행 `88326f7bd8eebda09f5844b231e0d79f4f64018e`: [insertAgentMessage](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/db/src/runs.ts#L432-L451), [initial](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/db/src/approvals.ts#L75-L132), [worker](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/db/src/workers.ts#L43-L94), [result](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/db/src/results.ts#L49-L104) | 소스 확인 |
| <a id="E02"></a>E02 | finishRun과 재시작 interruptRun은 별도 저장 경로다. 취소 요청이 있으면 cancelled 우선, 그 외 복구는 server_restart. run.finished 전체를 실패로 해석하면 오분류한다 | [finish/interrupt](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/db/src/runs.ts#L231-L318), [planRunFinish/Interruption](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/core/src/run.ts#L213-L305) | 소스 확인 |
| <a id="E03"></a>E03 | listInbox는 pending 업무 원본이며 stopped의 initial/result를 제외한다. 사용자 승인 HTTP는422/404/409를 구별하며 조직+pending 결정은 기존 DB가 강제한다 | [listInbox](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/db/src/inbox.ts#L8-L81), [HTTP](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/apps/server/src/app.ts#L563-L601), [decision](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/packages/db/src/approvals.ts#L161-L225) | 소스 확인 |
| <a id="E04"></a>E04 | #50 prototype는 실패 뒤 후속 성공에도 원 실패를 유지한다. 작업 중은 결정 전송 중인 예시이며 정의 owner를 #61로 명시한다. 현행 레일에는 Inbox 버튼이 있지만 loading/error도 badge0으로 취급한다 | [prototype data](https://github.com/babo-jeonguk/BaboJUBot/blob/f362363f4aac8e8bbd9ca9ec3c37fc6b20dc72ee/apps/prototype-dashboard-layout/src/data.ts#L351-L367), [현행 Rail](https://github.com/babo-jeonguk/BaboJUBot/blob/88326f7bd8eebda09f5844b231e0d79f4f64018e/apps/web/src/shell.tsx#L179-L221); #50 사용자 댓글은 Brief 링크 | 소스 확인 |
| <a id="E05"></a>E05 | 업무와 outbox를 같은 tx에 저장하고 별도 relay로 보낸다. 전송 뒤 ack 기록 전 crash는 중복을 만들므로 consumer dedup과 구별해야 한다 | [원저자 transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html), [AWS guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) | 문서 주장 |
| <a id="E06"></a>E06 | SKIP LOCKED는 queue 소비자의 lock 경합 회피용이며 일반 조회의 일관된 snapshot·엄격한 전달 순서를 보장하는 기능이 아니다 | [PG18 SELECT locking clause](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE) | 문서 주장 |
| <a id="E07"></a>E07 | Transaction Outbox는 caller tx에 save하고 postcommit 즉시 시도·주기 flush를 둔다. processNow는 row lock을 잡은 transaction 안에서 invoke하므로 외부 I/O의 긴 tx까지 복사할 근거는 아니다 | [schedule](https://github.com/gruelbox/transaction-outbox/blob/adabceb6d062c39baf33891d7910c369c925cbf3/transactionoutbox-core/src/main/java/com/gruelbox/transactionoutbox/TransactionOutboxImpl.java#L242-L294), [processNow](https://github.com/gruelbox/transaction-outbox/blob/adabceb6d062c39baf33891d7910c369c925cbf3/transactionoutbox-core/src/main/java/com/gruelbox/transactionoutbox/TransactionOutboxImpl.java#L323-L365) | 소스 확인 |
| <a id="E08"></a>E08 | pg-boss는 active+id:retry_count를 검사해 오래된 complete/fail을 막는다. plain id API는 같은 fence가 아니며 public restore가 count를 재사용하는 예외가 주석에 명시돼 있다 | [attemptFence/completeJobsUpdate](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/src/plans.ts#L2828-L2897), [회귀 #925](https://github.com/timgit/pg-boss/issues/925) | 소스 확인 |
| <a id="E09"></a>E09 | Graphile completeJobs의 job DELETE와 PGMQ delete/archive는 job ID 중심이다. queue lock 소유권/visibility timeout을 stale ack 방어와 동일시하면 안 된다 | [Graphile](https://github.com/graphile/worker/blob/7a2405bdd3b6322fb6b0d48dc0543bcc89166930/src/sql/completeJobs.ts#L30-L65), [PGMQ](https://github.com/pgmq/pgmq/blob/8efb078dbe7afe16c83be72e9fffefbb03ebd9e9/pgmq-extension/sql/pgmq.sql#L615-L698) | 소스 확인 |
| <a id="E10"></a>E10 | OpenClaw는 write-only chat.send→/approve가 내부 privileged client로 승인 권한을 우회한 결함을 공개했고2026.2.2 이상 수정으로 명시한다. 과거 fix commit 원문은 API422로 미확인 | [GHSA-mqpw-46fh-299h](https://github.com/openclaw/openclaw/security/advisories/GHSA-mqpw-46fh-299h) | 문서 주장 |
| <a id="E11"></a>E11 | 현재 /approve는 sender·gateway scope를 검사하고 원 reviewer를 resolver로 전달한다. device binding 없는 광범위 승인 권한도 있어 우리 조직 격리 모델과 같지 않다 | [command](https://github.com/openclaw/openclaw/blob/3b153699457f0f51c6d84d3e5ad8ddd29780b9ef/src/auto-reply/reply/commands-approve.ts#L139-L231), [access guard](https://github.com/openclaw/openclaw/blob/3b153699457f0f51c6d84d3e5ad8ddd29780b9ef/src/gateway/operator-approval-authorization.ts#L10-L54), [binding](https://github.com/openclaw/openclaw/blob/3b153699457f0f51c6d84d3e5ad8ddd29780b9ef/src/gateway/operator-approval-reviewer-binding.ts#L5-L24) | 소스 확인 |
| <a id="E12"></a>E12 | canonical approval.resolve는 live custody·최종 guard를 재검사하고 terminal winner는 applied:false로 반환한다. publication은 best effort다. UI는 응답 불명확 시 authoritative 상태를 다시 읽는다. 이 경로는 HTTP가 아닌 WS RPC다 | [resolver](https://github.com/openclaw/openclaw/blob/3b153699457f0f51c6d84d3e5ad8ddd29780b9ef/src/gateway/server-methods/approval.ts#L344-L479), [UI](https://github.com/openclaw/openclaw/blob/3b153699457f0f51c6d84d3e5ad8ddd29780b9ef/ui/src/pages/approval/approval-page.tsx#L320-L404) | 소스 확인 |
| <a id="E13"></a>E13 | OpenClaw 원본 4모듈을 변경 없이 transpile하고 의존성·transport만 double로 실행했다. write-only/sender 거부, 정상 승인/admin, malformed/stale ID/ack 분실, device binding과 빈 binding 반례13 checks PASS | `probes/openclaw-approval.cjs`, `openclaw-approval-run-log.txt`; Node24.21.0·TS6.0.3. Gateway/DB/실채널 실행 아님 | 실행 확인(제한) |
| <a id="E14"></a>E14 | Slack의 raw body 서명·timestamp·ack와 Matrix의 device+endpoint별 txn ID는 전송 계약이다. 제품의 업무 승인 권한·최종 상태와 같은 개념으로 쓰지 않는다 | [Slack authenticity](https://docs.slack.dev/authentication/verifying-requests-from-slack/), [ack](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge), [Matrix txn](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers) | 문서 주장 |
| <a id="E15"></a>E15 | Paperclip은 agent별 최신 실행을 고른 뒤 실패만 남겨 후속 success/running이 과거 실패를 숨긴다. non-issue read는 localStorage Set, issue read는 별도 PG다. unread 승인 탭도 actionable 의미여서 복사하면 의미가 섞인다 | [latest run](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/lib/inbox.ts#L728-L805), [read hook](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/hooks/useInboxBadge.ts#L147-L177), [issue read](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/packages/db/src/schema/issue_read_states.ts#L5-L28) | 소스 확인 |
| <a id="E16"></a>E16 | Paperclip의 PG dismissal은 company/user/itemKey별 정리 상태다. route는 문자열 key의 source 실체 귀속을 별도 조회하지 않는다. issue archive의 항목별 rollback과 non-issue hook의 전체 snapshot rollback은 다르다 | [schema](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/packages/db/src/schema/inbox_dismissals.ts#L4-L29), [route](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/server/src/routes/inbox-dismissals.ts#L62-L80), [per-item](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/pages/Inbox.tsx#L1931-L1979), [hook](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/hooks/useInboxBadge.ts#L69-L106), [selection](https://github.com/paperclipai/paperclip/blob/412914cfa78d5abefcc34d3eb8d4bb86e461caac/ui/src/pages/Inbox.tsx#L2101-L2128) | 소스 확인 |
| <a id="E17"></a>E17 | Plane는 entity와 receiver/workspace, read_at/archived_at을 분리한다. read/archive route와 unread count에 receiver+workspace 조건이 있다. archive는 read를 대신 바꾸지 않는다 | [model](https://github.com/makeplane/plane/blob/490619341f856b692fb7c845364f0d4585ebee2a/apps/api/plane/db/models/notification.py#L13-L67), [routes/count](https://github.com/makeplane/plane/blob/490619341f856b692fb7c845364f0d4585ebee2a/apps/api/plane/app/views/notification/base.py#L169-L233) | 소스 확인 |
| <a id="E18"></a>E18 | Novu는 read/seen/archive/action 필드를 구분하지만 read는 archive를 해제하고 archive는 read도 켠다. completeAction은 실패를 {error}로 반환하는데 item controller는 결과 확인 없이 callback/navigation을 수행한다. 도메인 승인 성공으로 쓰면 안 된다 | [Notification](https://github.com/novuhq/novu/blob/14c6c4faf106292a20bacdb9c54c73f40ed93553/packages/js/src/notifications/notification.ts#L21-L48), [read/archive](https://github.com/novuhq/novu/blob/14c6c4faf106292a20bacdb9c54c73f40ed93553/packages/js/src/notifications/helpers.ts#L40-L202), [helper](https://github.com/novuhq/novu/blob/14c6c4faf106292a20bacdb9c54c73f40ed93553/packages/js/src/notifications/helpers.ts#L323-L369), [controller](https://github.com/novuhq/novu/blob/14c6c4faf106292a20bacdb9c54c73f40ed93553/packages/js/src/ui/core/item/controller.ts#L49-L83) | 소스 확인 |
| <a id="E19"></a>E19 | Novu ADR는 renderer마다 filter/count 소유자가 갈라져 drift하던 이유로 instance별 shared core를 선택한다. 다른 탭 영속화 보장을 뜻하지 않는다 | [shared inbox ADR](https://github.com/novuhq/novu/blob/14c6c4faf106292a20bacdb9c54c73f40ed93553/packages/js/docs/adr/0003-shared-inbox-state-lives-in-the-core.md#L6-L22) | 문서 주장 |
| <a id="E20"></a>E20 | Knock은 bulk에 현재 user/filter/tenant를 넘기고, opt-in BroadcastChannel 이벤트를 받으면 목록을 fetch한다. 브라우저 이벤트 payload를 최종 상태로 쓰지 않는다 | [bulk/cross-tab](https://github.com/knocklabs/javascript/blob/b429cf037dedcde794143bb8f85f6bc1532741d9/packages/client/src/clients/feed/feed.ts#L757-L817) | 소스 확인 |
| <a id="E21"></a>E21 | Courier의 preview는 실제 datastore를 우회한다. read/archive 오류는 listener에 전달하지만 catch 뒤 throw하지 않는 경로도 있어 명령 성공 계약을 그대로 가져오지 않는다 | [preview](https://github.com/trycourier/courier-web/blob/105379f72aaba48db9d5080a5ca410869a57f9fa/%40trycourier/courier-ui-inbox/src/components/courier-inbox.ts#L763-L795), [rollback](https://github.com/trycourier/courier-web/blob/105379f72aaba48db9d5080a5ca410869a57f9fa/%40trycourier/courier-ui-inbox/src/datastore/inbox-datastore.ts#L910-L923) | 소스 확인 |
| <a id="E22"></a>E22 | 독립 SQL 모형 10cases·26assertions PASS. 업무/outbox 롤백·중복 의도·네 종류·조직 FK·동시 claim·lease 회수·stale ack·지연 retry·fake sink dedup·외부 중복 대조·read/archive 독립·set/toggle 차이를 확인했다 | `probes/outbox-pg.mjs`, `outbox-pg-log.txt`; Node24.21.0·PG18.4·pg8.23.1·embedded-postgres18.4.0-beta.17 | 실행 확인(독립 모형) |
| <a id="E23"></a>E23 | pg-boss 고정 SHA의 원본 plans.ts와 전체 PG schema를 직접 실행해 6cases·15assertions PASS. caller tx rollback·정상/중복 settle·stale complete/touch 거부·UUID를 확인했다. id-only가 새 attempt를 덮고 public restore가 generation을 재사용하는 음성 대조도 재현했다 | `probes/pg-boss-upstream.mjs`, `pg-boss-upstream-log.txt`; Node24.21.0·PG18.4·pg8.23.1. worker API/분산 branch 미실행 | 실행 확인(원본 SQL) |
| <a id="E24"></a>E24 | Courier 고정 소스의 원본 preview UI를 로컬에서 조작해 1440/390px 8캡처를 확인하고 메인이 전부 재열람했다. feed/bulk/row 메뉴·모바일 long press·줄바꿈·빈/로딩/오류 구분을 보았다. read/archive 클릭은 preview 상태를 바꾸지 않고 Archive도 주입 3행을 재사용했다 | [원본 preview guard](https://github.com/trycourier/courier-web/blob/105379f72aaba48db9d5080a5ca410869a57f9fa/%40trycourier/courier-ui-inbox/src/components/courier-inbox.ts#L258-L270), [list renderer](https://github.com/trycourier/courier-web/blob/105379f72aaba48db9d5080a5ca410869a57f9fa/%40trycourier/courier-ui-inbox/src/components/courier-inbox-list.ts#L180-L232); `captures/courier-captures.md`, `probes/courier-run-log.txt` | 실행 확인(원본 UI＋합성 데이터) |

근거 24개: 소스 확인 15·문서 주장 5·실행 확인 4. 실행 범위는 서로 다르며 하나의 통합 suite로 합산하지 않는다.

### 실행 조건과 해석

- 독립 SQL 모형은 임시 embedded PG18.4, pg8.23.1, Node24.21.0에서 키 없는 셸로 실행하고 finally에서 pool/cluster/임시 디렉터리를 정리했다. 실제 제품 schema·HTTP·relay를 구현/검증한 것이 아니다.
- pg-boss는 고정 source snapshot의 원본 SQL 생성기·전체 schema만 실행했다. worker API·CockroachDB/분산 branch·upstream 전체 suite는 미실행이다. OpenClaw는 원본 4모듈의 transpilation과 명시적 dependency/transport double만 사용했고,13 checks를 실제 Gateway/DB의 권한 검증으로 확대하지 않는다.
- Courier는 `/tmp/reference-selfhost/issue-61-courier/`의 고정 checkout에서 원본 component를 Vite source alias로 실행했다. 새 연구 runner에 Vite6.2.6만 `npm install --ignore-scripts`로 설치하고 원본 소스는 수정하지 않았다. 합성 메시지·wrapper 여백/폭만 주입했다. 당시 available4GiB, 설치/서버/브라우저 모두 Docker2GiB 상한·env-i, localhost만 사용했다. 외부 요청0/pageerror0, 사용한 서버 컨테이너 종료를 확인했다.
- UI 8장은 실제 원본 메뉴 조작 후 촬영했다. empty/loading/error는 원본 public setter fixture에 native feed 메뉴를 연 상태로 확인했다. 실제 네트워크 오류·Retry 복구·read/archive 저장·undo·다른 탭·키보드 접근성 보장은 미확인이다. preview의 no-op을 제품 정책으로 채택하지 않고, 메뉴·상태 renderer의 구분만 참고한다. 상세 재현 명령/시행착오는 `probes/run-log.txt`와 각 실행 로그에 있다.

## 패턴

아래 패턴과 결정 권고는 근거에서 도출한 **추론**이다.

| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 업무 tx에 전송 의도, commit 뒤 가속+영속 backlog scan | E01,E05,E07 | Transaction Outbox는 Java callback, Babo는 PG 사건/도구 tx | commit 전 오발송·commit 뒤 누락 방지 | EventHub 구독만 쓰면 프로세스 종료 구간에 유실. 모든 업무 쓰기 경로를 포함해야 함 |
| <a id="P02"></a>P02 | 짧은 claim과 만료·재시도, 세대가 맞는 settle | E06,E08,E09,E22,E23 | pg-boss retry count, Babo는 단조 증가 claim generation 또는 고유 token | crash 복구와 오래된 ack 거부 | 외부 side effect 중복은 fence만으로 막을 수 없음. strict FIFO와 SKIP LOCKED는 다른 계약 |
| <a id="P03"></a>P03 | stable delivery ID·멱등 sink와 업무 원본 재조회 | E05,E12–E14,E22 | fake DB sink는 dedup 가능, 실제 provider는 idempotency 지원이 다름 | 재전송 감사·불명확 응답 복구 | 전송됨·수신확인·승인됨·읽음은 서로 다른 상태 |
| <a id="P04"></a>P04 | 모든 입력 surface가 같은 명령과 최종 guard 사용 | E03,E10–E14 | OpenClaw WS/권한 모델, Babo 기존 local_trusted HTTP/조직 lock | UI/채널의 업무 규칙 drift 방지 | 내부 privileged 호출, payload org/URL 신뢰, 오래된 action의 재적용 |
| <a id="P05"></a>P05 | 업무 source와 사용자 정리 상태의 별도 영속화 | E03,E15–E18,E21,E22 | Paperclip은 local+PG 혼합, Plane timestamp, Novu action은 read/archive 결합 | 읽음·보관이 승인/연구 상태를 바꾸지 않음 | 문자열 item key만 믿으면 source 귀속 누락, 무조건 toggle은 재시도 때 역전 |
| <a id="P06"></a>P06 | 목록·badge·필터가 같은 scope/predicate, event는 재조회 hint | E19,E20; 현행 live-events | Novu는 instance store, Knock cross-tab opt-in, Babo global/org query | 다른 탭·재연결에서도 서버 상태 복원 | 필터 개수 합산 중복, 페이지 길이를 전체 count로 대체, 실패를0건으로 표시 |
| <a id="P07"></a>P07 | 원본 상세 링크·명시적 mutation·stable key 포커스 | E04,E16,E18,E21,E24 | #50 배치가 우선. 참고 SDK의 메뉴/preview는 제한된 동작 | 좁은 화면·목록 갱신 때 행동 대상 유지 | 낙관적 전체 snapshot 복원이 다른 성공 변경을 되돌림; action error를 성공처럼 표시 |

## 결정 권고

| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 네 사건의 원본·Event와 outbox 의도를 같은 PG tx에 기록. stable 원본 ID+사건 종류+목적지별 unique. 실행 중 활동 chunk·작업자 내부 메시지·사용자 입력 전체를 알림으로 복제하지 않음 | P01,E01–E03; AC1 | Lead 메시지, 초기/작업자 승인 양쪽, 결과, 일반/복구 종료 경로를 모두 점검. EventHub publish는 commit 뒤 촉진일 뿐 전송 보장의 원본이 아님 | Q1 |
| <a id="D02"></a>D02 | 변형 채택 | pending/retry-ready → claimed → sent 또는 delayed retry. 짧은 tx로 due claim, adapter I/O는 tx 밖, settle은 delivery ID+현재 claim token/generation 조건. 시작/주기 scan과 종료 시 정리, postcommit kick 병행 | P02,E07–E09,E22,E23 | 단일 relay라도 crash·느린 완료를 구별. claim generation은 재claim마다 새 값이며 manual restore로 재사용하지 않음. 무조건 startup 상태 초기화·긴 tx·엄격 FIFO 보장 배제 | Q1,Q2 |
| <a id="D03"></a>D03 | 변형 채택 | fake deliver는 outbox ID+destination별 전송 기록과 재사용 가능한 receipt를 영속화. 성공/실패/지연/ack 직전 종료를 주입할 수 있게 한다. 시도 횟수·다음 예정·오류를 남김 | P03,E05,E22; AC1 | fake의 단일 기록을 실제 provider exactly-once로 일반화하지 않음. payload는 조직/원본 식별자·요약·상세 링크 중심, run token·secret을 넣지 않음. 전송은 Inbox 읽음을 바꾸지 않음 | Q2 |
| <a id="D04"></a>D04 | 채택 | fake 입력은 승인 action allowlist와 저장된 source/delivery→조직·승인 ID 관계를 검증한 뒤 기존 `POST /api/organizations/:id/approvals/:approvalId/decision`을 실제 HTTP 호출. 임의 URL·DB 직접 결정·별도 승인 구현을 받지 않음 | P04,E03,E10–E14; AC2 | 같은 payload를 웹/fake로 보내 단계·팀·Lead wake·Event 결과가 같아야 함. 중복/오래된 요청의409는 서버 상태 재조회로 보고, 반대 결정을 덮거나 성공으로 꾸미지 않음. fake는 현행 local_trusted 사용자 시뮬레이터이지 외부 인증 adapter가 아님 | Q3 |
| <a id="D05"></a>D05 | 변형 채택 | 승인/결과/실패 원본과 별개로 `(organization, kind, sourceId)`에 귀속된 read/archive 상태를 PG에 저장. 사용자 명령은 `read=true/false`, `archived=true/false`의 명시적 대입. 단일 사용자에게 임의 userId를 받지 않음 | P05,E16–E18,E22; AC3 | 실제 source 같은 조직 관계를 서비스 검사·가능한 FK로 검증. 보관은 원본 삭제·승인·최종 완료가 아니다. 처음부터 모든 multi-user/SDK 설정을 들이지 않음 | Q4 |
| <a id="D06"></a>D06 | 채택 / 일부 보류 | 실패는 실행 시도별 source ID로 보존. 같은 agent의 후속 성공/running으로 숨기는 집계를 복사하지 않음. 사용자 취소 cancelled·정상 완료를 실패로 세지 않음. server_restart 포함 정책은 열린 결정 | E02,E04,E15; AC3 | 원 실패 상세가 항상 남고 보관은 그 항목만 정리한다. 같은 run 종료 재처리로 알림·Inbox가 늘지 않으며 별개 새 실패 run은 새 항목 | Q1,Q4 |
| <a id="D07"></a>D07 | 변형 채택 | Inbox 목록·각 filter count·레일/조직 주의 수를 같은 서버 scope/predicate에서 파생. 전체/현재 조직을 query key에 포함하고 mutation·조직 Event·ready/reconnect 뒤 목록과 count 재조회 | P06,E19,E20; #50 결정 | 필터는 서로 겹칠 수 있어 합계를 total로 쓰지 않음. attention은 unread와 다른 의미. pending을 읽어도 결정 필요는 남음. working·보관된 pending의 badge 정책은 열린 결정 | Q4,Q5 |
| <a id="D08"></a>D08 | 채택 | #50 패널/drawer·상세 본문을 따른다. 기존 레일 버튼을 패널 열기에 연결하고 모바일 Inbox·전역 설정 자리 추가. read/archive와 업무 결정의 버튼·pending/error를 분리, 항목 ID별 잠금·실패 초안/원상태·stable focus 유지 | P07,E04,E16,E18,E21,E24; AC4 | 좁은 폭에 scope·count·종류·조직·상세 링크가 남아야 함. 불러오는 중·오류·정상0건을 구분. global 설정은 실행기/환경 템플릿/비밀값/메시지 앱의 미연결 자리만, 작동하지 않는 저장/연결을 성공처럼 표시하지 않음 | Q5 |
| <a id="D09"></a>D09 | 배제 / 후속 | 새 notification SaaS·queue broker/Redis·CDC, 실제 Slack/Discord/Telegram 인증·secret 보관·provider 선택·임의 명령 router는 이번에 도입하지 않음. job·예산·사용자 할 일 알림은 후속 판 | ADR4; P01–P07; #61 범위 | #61 본문은 실제 메시지 앱을 두 번째 판으로 쓰지만 현행 architecture는 판3이다. 번호 차이는 #49에서 정리하되 이번 범위는 fake다. 원본 API·조직 경계·초기 승인·최종 완료를 바꾸는 권고 없음 | Q1–Q5 |

### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| commit 뒤 메모리 이벤트만 구독해 알림 저장 | E05,E07 | commit→publish crash 구간을 복구하지 못함 |
| id만으로 완료, lease=외부 전송 한 번, count 재사용 | E08,E09,E22 | 오래된 완료가 새 claim을 끝내거나 외부 중복을 감춤 |
| privileged 내부 client·source 문자열 ID만 신뢰 | E10,E11,E16 | 경로 통일만으로 원 actor·조직 관계를 강제할 수 없음 |
| 최신 run만 실패 표시·actionable을 unread로 사용 | E04,E15 | 과거 실패 보존·사용자 읽음 의미와 충돌 |
| read=archive 해제·archive=read의 무조건 복사 | E17,E18 | 참고 제품 정책일 뿐 BaboJUBot 정리 계약은 별도 선택 |
| SDK action completion·preview 메뉴를 승인 성공 증거로 사용 | E18,E21 | 오류 결과·mock 범위와 제품 명령 효과가 다름 |

## 구현 참고

책임은 [전체 구조](../architecture.md)와 [코드 지도](../agents/code-map.md)를 따른다. 외부 코드 복사 없이 기존 seam을 확장하는 권고다.

| 위치 | 구현자가 확인할 연결 |
|---|---|
| `packages/contracts` | typed notification source/delivery/receipt·Inbox 판별 union·read/archive 입력·관련 Event. source와 화면 정리 상태, 전송 상태를 별도 타입으로 표현 |
| `packages/core` | 사건 선별·실패 분류·Inbox predicate·재시도 계산과 channel port. 도메인 결정은 기존 승인/결과/제어 규칙이 소유 |
| `packages/db` | 업무 tx 내 outbox 삽입, claim/fenced settle·fake 전송 기록·Inbox 상태·scope/count 조회. `approvals.ts`, `workers.ts`, `results.ts`, `runs.ts`의 모든 생성/종료 경로와 `toolWrite` 재실행을 점검 |
| `apps/server` | relay 수명·주기 scan·fake adapter·입력 allowlist. 같은 HTTP 명령으로 전달하고 기존 EventHub/dispatcher의 commit 뒤 순서 유지. read/archive도 영속 Event 후 웹 재조회 연결 |
| `apps/web` | `shell.tsx`의 기존 Inbox 링크·모바일/레일과 패널, `approvals.tsx` 임시 목록·기존 승인/결과 상세, `api.ts`·`live-events.ts`의 global/org list/count 갱신, 전역 설정 자리. 기존 상세 deep link를 깨뜨리지 않기 |

필드·테이블·새 route 이름은 권고이며 확정 API가 아니다. `kind+sourceId`는 source 관계 검사를 대체하지 않는다. 도구 호출 키(#60)가 업무를 replay하면 기존 outbox 의도도 재사용되어야 한다. 기존 pending 기록을 어떤 방식으로 Inbox 상태에 연결할지와 과거 외부 알림을 소급 전송할지는 서로 다른 migration 선택이다.

| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 네 사건 및 초기/정책 승인 양쪽 → 생성 후 재조회 → 원본·Event·outbox 한 벌. 동일 호출 키 replay와 commit 직전 실패 → 중복/부분 쓰기 없음 | D01 |
| V02 | 업무 commit 뒤 relay 촉진 전 서버 종료 → 재시작 scan → 아직 안 보낸 의도 전송. DB가 없거나 scan 실패 → 기록 유실 없이 재시도 | D01,D02 |
| V03 | 동시 두 claim·느린 첫 worker·lease 만료 → 재claim → 오래된 ack/fail/renew는 새 claim을 바꾸지 못함. 취소/종료 시 전송 중 결과도 상태 일치 | D02 |
| V04 | 전송 성공 후 settle 전 종료 → 재시도 → fake receipt 한 건·보존된 attempt 기록. 외부 idempotency 없는 대조군은 중복 가능하다고 보고 | D03 |
| V05 | 같은 승인에 웹/fake·중복/상반된 결정을 경합 → 기존 HTTP409·단일 상태 변화/팀/Lead wake/Event. ack 불명확 → 상세 재조회. 이미 결정한 요청 다시 열리지 않음 | D04 |
| V06 | 조직A delivery+조직B 승인 ID, source 없는 ID, 임의 route/URL/추가 decision 값, 종료 run token → 거부·B 기록/깨우기/알림 없음. fake 입력에 agent 권한을 사용자 권한으로 승격하는 경로 없음 | D04,D05 |
| V07 | pending 승인/결과 읽음·보관/해제 → 정리 상태만 변화, 원본 상태·팀·단계·wake 불변. 새로고침·재시작 뒤 정리 상태 유지 | D05 |
| V08 | 실패 run→후속 성공→새 실패, 명시 취소·정상 완료·재시작 복구 → 실행 시도별 원본 보존·정확한 분류·동일 run 중복 없음 | D06 |
| V09 | 전체/현재 조직+모든 필터+보관 변경·새 사건 → list/count/rail/조직 수가 같은 predicate와 일치. tab 합계가 total과 다를 수 있음. 다른 탭·연결 끊김/복구 → 최신 서버 값 | D07 |
| V10 | 1440/1280/1279/768/767/390px에서 panel/drawer/sheet·scope·필터·상세 선택·뒤로/Escape → 한 Inbox, 상세 이동 때 drawer 닫힘·포커스 복구·가로 overflow 없음 | D08 |
| V11 | 정상0건·loading·HTTP 오류·없는 상세·보관 실패·동시 서로 다른 항목 mutation → 오류가0으로 보이지 않음, 성공한 다른 변경 유지, 버튼 중복 제출 방지, 제거된 행의 포커스가 안정적으로 이동 | D07,D08 |
| V12 | 전역 설정 진입 → 실행기/환경 템플릿/비밀값/메시지 앱 자리 표시 → 실제 secret 입력·provider 연결·모델 호출 없이 상태를 정확히 안내 | D08,D09 |

| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| ‘작업 중’ 의미 | #61 / 사용자 | ① prototype처럼 일시적 결정 전송 중(최소 권고, 영속 업무 상태 아님) ② 명시적 영속 triage 상태(새 명령 필요). agent running·outbox sending을 같은 의미로 쓰지 않음. E04의 prototype 주석은 #61 소유를 명시 |
| pending 업무 항목 보관·주의 수 | #61 / 사용자 | ① 보관 허용+보관함에서 원본 결정 접근, badge 제외(prototype 정리 방식) ② 보관 허용해도 unresolved 주의 수 유지 ③ pending 보관을 제한. 어느 쪽도 원본 승인/최종 완료를 대체하지 않음. 기존 pending 목록에서 ‘전체/보관됨’에 결정 이력을 얼마나 남길지도 함께 결정 |
| 실패·초기 자료의 포함 범위 | #61 | ① failed만 알림 ② failed+server_restart(운영 경고로 구별하는 권고). cancelled 제외. 기존 pending/과거 실패는 Inbox 표시/상태 backfill 대상과 소급 채널 전송 대상을 따로 결정; 과거 전체 자동 전송은 기본 권고하지 않음 |
| delivery 운영 수치·보존 | #61, 실제 채널은 #49 후속 판 | lease 길이·최대 retry/backoff·막힌 전송의 재시도 명령·보존 기간. fake는 결정론적 시계/실패 주입으로 검증, 실제 provider의 rate limit·idempotency key 보존·unknown outcome은 후속 조사 |

## 한계와 미확인

- 실채널·로그인·secret·유료 API·실제 모델을 사용하지 않았다. fake의 HTTP 입출력과 향후 제품 schema/API/E2E는 구현 시 V01–V12로 검증해야 한다. 이번 조사 실행은 이를 통과했다는 보고가 아니다.
- 공개 Novu playground는 브라우저에서 body가 비었고 shadcn sidebar 페이지는 timeout이었다. 이 화면을 실화면 근거로 채택하지 않았다. 기존 #50 캡처도 이번 실행으로 세지 않았다.
- Paperclip·Novu·Plane·Knock 전체 앱/SDK 통합 테스트와 다른 탭·오류 rollback의 실제 UI는 미실행이다. Paperclip official story 이름이 Failed/PermissionDenied여도 그것만으로 올바른 실패 화면이라고 판정하지 않는다.
- OpenClaw는 원본 guard/handler+mock transport만 실행했다. SQLite 동시성·실제 gateway·채널 승인·과거 fix commit 원문은 미확인이다. 현재 canonical 저장 주석의 CAS 표현을 PG pending-WHERE 구현으로 옮겨 해석하지 않는다.
- 모든 upstream SHA와 문서는 조사일 기준이다. 코드 재사용을 결정하면 파일별 blob 변경과 header·NOTICE·의존성/라이선스 범위를 다시 확인한다. Novu의 루트 core MIT 설명과 JS package metadata ISC 차이도 복사 전에 해소해야 한다.
