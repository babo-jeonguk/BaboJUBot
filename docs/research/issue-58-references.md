# issue-58 레퍼런스 조사: 승인 정책 — 작업자 추가

원문·실행 조사일: 2026-10-21. 종합·보고일: 2026-10-22. 대상: [#58](https://github.com/babo-jeonguk/BaboJUBot/issues/58). 구현 전 기술 권고이며 확정 계약이나 구현 결과가 아니다. 상세 자료: `.reference-cache/issue-58/`(git 무시).

게시 기록: [reference-first receipt](https://github.com/babo-jeonguk/BaboJUBot/issues/58#issuecomment-6320495049).

## Brief

- 문제: 조직별 작업자 추가 승인 정책(기본 꺼짐)을 사용자가 바꾸면 Lead의 add_worker 호출을 즉시 실행하거나 승인 요청으로 저장한다. 켜진 정책에서 작업자는 승인 때 생성한다. 승인·반려 모두 사유를 포함한 Lead 깨우기를 남긴다. 정책 변경은 사용자 제어 명령 Event이며 조직 도구로 노출하지 않는다.
- 동종 메커니즘: 정책으로 부작용을 보류한 명령의 검토 내용을 고정하고, 사용자 결정으로 한 번 적용하는 조직 범위 업무 gate.
- 고정 결정: ADR-0001/2/3/4, GLOSSARY, features, architecture. 초기 승인은 항상 필수, 선택 정책은 기본 꺼짐, 사용자 최종 완료 유지. PG/Drizzle/Express/React/Query/zod. 작업자 Role·Soul·Skill은 라이브러리에서 에이전트별 별도 사본. 에이전트별 실행 토큰 scope, Lead·연구 진행 add_worker 규칙. 사용자 API local_trusted loopback 경계는 현 구조 문서 기준. 모델 호출·자격 증명 없음.
- #54 완료 기반: add_worker 이름·POST /api/tools/workers·단계/Role 검사 존재, handler 501. initial_research 전용 승인 계약/저장은 종류별 분기 필요. planApprovalDecision은 초기 승인 stage 이동/템플릿 복사도 포함하므로 전체 재사용할 수 없다.

| ID | 조사 질문 | 출처 | 전략 |
|---|---|---|---|
| Q1 | 정책 기본값·사용자 전용 변경과 Lead 도구 gate를 어디서 강제하고 조직·Role·종료 토큰 우회를 어떻게 막는가? | #58 What to build 1/3, AC1/3; ADR-0003; #54 handoff | Source Recon + adversarial scenario |
| Q2 | 정책 변경과 add_worker가 경합할 때 실행/대기를 원자적으로 고르고 대기 중 정책이 바뀐 요청은 어떻게 다루는가? | #58 정책에 따른 분기·AC2; architecture 즉시 제어 | Source Recon + persistence/concurrency, 음성 대조 probe |
| Q3 | 승인 대상 Role·Soul·Skill을 언제 고정하며 승인 전 작업자 0·승인 후 별도 사본을 어떻게 보장하는가? | #58 What to build 2, 사본 댓글; #54 기존 결정 | Source Recon + snapshot/contract 검증 |
| Q4 | 승인·반려의 1회 결정, 사본·Event·Lead wake 원자성과 재시도·단계 변경 실패는 어떻게 다루는가? | #58 AC2; #54 1회 결정; ADR-0002 | Source Recon + runtime/failure + PG 실행 |
| Q5 | 조직 설정 체크박스와 승인 상세/Inbox에서 저장 중·오류·결정 후 상태와 다른 탭 실시간 반영을 어떻게 보여주는가? | #58 화면·AC4; features 화면 지도 | Source Recon + Behavioral Recon + Surface Capture |

Discovery 관점: (1) OSS agent 도구 승인/채용 정책, (2) 인접 workflow/transaction 명세·라이브러리, (3) 운영 화면·설정/승인 UI. 마지막 라운드가 새 패턴/실패 모드를 더하지 않을 때 종료한다.

### 기존 조사 재사용 판단

| 기존 조사 | 재사용 | 재확인 |
|---|---|---|
| [#54](issue-54-references.md#brief) | 승인 snapshot·CAS·독립 사본·UI 사유 누락·hire 전생성 반례 | 기존 E는 문서 anchor로 인용. 결정에 쓸 upstream은 파일별 blob 비교 또는 새 SHA 읽기 |
| [#57](issue-57-references.md#brief) | 조직 잠금·사용자 API local_trusted 신뢰 경계 | 현재 architecture·코드 확인. 실제 실행 격리는 이번 범위 아님 |
| [#52](issue-52-references.md#brief)·[#53](issue-53-references.md#brief)·[#55](issue-55-references.md#brief) | PG·도구 token·wake/활동 기록 경로 | 현재 코드 지도/소스 확인, 과거 실행은 이번 실행으로 세지 않음 |
| [#50](issue-50-references.md#brief)·[#51](issue-51-references.md#brief)·[#56](issue-56-references.md#brief) | 조직별 query key·realtime·관계 격리 | UI 공통 원리만 재사용. 연구 지도/graph 상세는 제외 |
| [#1](issue-1-references.md#brief) | 타입/명령/검증 배경 | 과거 고정 승인 권고는 ADR-0003/현 #58과 다르면 배제 |
| paperclip.md, paperclip-dashboard.md, dashboard-references.md, comparative-survey.md | Paperclip 및 화면 후보 시작점 | 현재 ref 직접 확인, 캡처 재사용 없이 필요한 상태 새 관찰 |
| agent-runtime-models.md, agent-interaction-models.md, reference-code-structure.md | adapter/영속 기록과 후보 배경 | 실제 실행기/기억/외부 job 범위는 제외 |


## 레퍼런스

후보 **35행·중복 제외 34종**이다. 모든 후보의 공식 출처·질문 대응·실행 경로는 `candidates.md`에, 검색 라운드는 `notes/{policy,workflow,surface}.md`에 남겼다. 질문별 패턴 saturation이며 생태계 전수조사를 뜻하지 않는다.

| 관점 | 마지막 라운드와 종료 근거 |
|---|---|
| OSS agent 승인·채용 정책 | 3라운드. 프로젝트→SDK/HITL→위조·재사용 ID·재시도 테스트로 확장. 마지막 후보들이 요청 binding·deferred invocation·정책 재평가·중복 처리의 기존 변형만 더함 |
| 인접 workflow·트랜잭션 | 4라운드. callback→정책 평가→outbox→경합/timeout 실패 이력으로 확장. 마지막 검색은 message ID·조건부 UPDATE·전이 검증으로 수렴 |
| 정책·승인 운영 화면 | 4라운드. 운영 제품→상태 라이브러리/디자인 시스템→offline/stale Inbox→실패 검색. 마지막 라운드는 refresh hint·서버 재검사·stale-state의 기존 변형만 더함 |


| 레퍼런스 | 버전·SHA | 라이선스 | 깊이·선정 이유 |
|---|---|---|---|
| Paperclip | `8b873e01121a80e563a8a02bf6a3219783de5476` | MIT root 원문 확인 | 소스. 같은 스택의 기본 OFF·사용자 정책·채용/CAS·회사 잠금과 승인 전 agent 생성 반례 |
| Microsoft Agent Framework | `08851e69d722b0e0961c08eecf8575db995f0172` | MIT root 원문 확인 | 소스·테스트 읽기. 위조/중복 승인과 저장된 요청 binding, shallow copy·세션 생략 반례 |
| Temporal TypeScript SDK | `6a188eea837b77db33e2254397dc25b6c726b5cc` | MIT root 원문 확인 | 소스·테스트 읽기. 사전 gate와 비동기 적용, accepted/완료·timeout/취소 구별 |
| PostgreSQL | 18 공식 문서; 실행18.4 / embedded-postgres18.4.0-beta.17 / pg8.23.1 | PostgreSQL License | 문서·독립 SQL 실행. 정책 경합·CAS·rollback·partial unique 직접 검증 |
| Unleash | `584eddf7fa4bd93bdbe2891da60bb052f419e214` | root AGPL-3.0 확인; 승인 기능 Enterprise | 소스. 범위가 보이는 정책 UI와 서버 성공 후 갱신. 해당 서버 controller는 미확인 |
| Infisical | `0a76cc0fa8c8e9b39be62cc553cf687ecd77a7a4` | root: ee 밖 MIT, ee 별도; EE LICENSE 미열람 | 소스. 결정과 comment 한 요청, 양 버튼 공유 pending. UI 계약만 채택 근거로 사용 |
| assistant-ui | `2bfdca62d0f5522b017513dfef652feb64f418bb` | MIT root 원문 확인 | 기존 소스 근거 재사용·공개 실화면. 작은 receipt/포커스 비교 |
| handup | 2026-10-21 공개 client-only demo; 배포 SHA 미확인 | 상용; 코드 재사용 대상 아님 | 공개 실화면. 원문·사유·Inbox→결정 이력 |
| Carbon | 2026-10-21 공식 InlineLoading 지침; 배포 SHA 미확인 | 문서만 참고; 자산/코드 복사 제외 | 문서. 저장중/성공/오류 표현; 실화면은 렌더 미확인으로 제외 |


모두 **설계 참고**다. 새로운 workflow/정책 엔진·UI 의존성이나 코드 복사를 권고하지 않는다. 실제 코드 재사용 시 해당 SHA의 LICENSE·파일 header·NOTICE·전이 의존성을 다시 확인하고 AGENTS의 출처 고지를 적용해야 한다.

## 근거

현재 제품 소스 기준 HEAD는 `58e3155f05f62bb00fc296afda64104f57c273db`다. 메인이 아래 원문과 캡처6개를 직접 재열람했다. source test는 실행 표시가 없으면 읽기만 했다. Paperclip은 #54 ref와 파일별 blob을 비교했고 변경된 route는 새 SHA 원문으로 확인했다. assistant-ui card/focus/demo/test4개는 #57 ref와 blob 동일하므로 기존 [#57 E17](issue-57-references.md#E17)을 재사용하며 새 E로 옮기지 않는다. `main-verification.md`에 대응과 한계를 남겼다.


| ID | 관찰 | 출처 | 수준 |
|---|---|---|---|
| <a id="E01"></a>E01 | 현재 add_worker는 Lead·researching 전용이고 handler는501이다. 도구 쓰기는 running run SHARE→조직 NO KEY UPDATE→Role/단계 재검사 뒤 저장한다. 정책 변경 도구는 목록에 없다. | [toolRules](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/packages/core/src/approval.ts#L38-L76) · [add_worker](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/apps/server/src/tools.ts#L608-L612) · [toolWrite](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/packages/db/src/tool-calls.ts#L87-L117) | 소스 확인 |
| <a id="E02"></a>E02 | 기존 승인은 initial_research 단일 종류·조직당 pending1개다. 결정은 awaiting_approval만 받고 승인 시 팀/템플릿·researching, 반려 시 planning으로 바꾼다. 요청 때 파일 내용을 고정하고 승인 때 snapshot에서 독립 사본을 만드는 부분은 재사용 가능하다. | [snapshot/kind](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/packages/contracts/src/approval.ts#L54-L87) · [approval schema](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/packages/db/src/schema.ts#L226-L269) · [결정 tx](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/packages/db/src/approvals.ts#L139-L199) · [초기 승인 효과](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/packages/core/src/approval.ts#L250-L292) | 소스 확인 |
| <a id="E03"></a>E03 | 현재 웹 승인 설명/결정폼은 초기 승인 전용이다. 같은 mutation의 pending을 공유하며 실패 시 사유를 유지한다. 조직 Event는 해당 조직 query와 Inbox를 무효화하고 ready/reconnect 때 전체를 재조회한다. | [DecisionForm](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/apps/web/src/approvals.tsx#L288-L355) · [Event invalidation](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/apps/web/src/live-events.ts#L31-L50) · [조직 query key](https://github.com/babo-jeonguk/BaboJUBot/blob/58e3155f05f62bb00fc296afda64104f57c273db/apps/web/src/api.ts#L39-L69) | 소스 확인 |
| <a id="E04"></a>E04 | Paperclip 현재 migration은 채용 승인 column의 DEFAULT만 false로 바꾸고 기존 값은 갱신하지 않는다. 회사 설정 route는 agent에 strict branding schema만 허용하고 사용자 full schema에만 정책 boolean을 둔다. | [default OFF](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/packages/db/src/migrations/0071_default_hire_approval_off.sql#L1) · [actor 분기](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/routes/companies.ts#L1249-L1260) · [schema](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/packages/shared/src/validators/company.ts#L33-L64) | 소스 확인 |
| <a id="E05"></a>E05 | Paperclip hire route는 정책을 먼저 읽고 closure 값으로 pending_approval/idle을 고른다. agent 생성→지침 materialize→승인 요청 순서다. #58의 승인 전 작업자0과 다르며 해당 정책 경합의 실제 결과는 미실행이다. | [정책 read/분기](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/routes/agents.ts#L4447-L4496) · [사본→요청](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/routes/agents.ts#L4530-L4552) | 소스 확인 |
| <a id="E06"></a>E06 | Paperclip hire 결정은 회사 잠금 tx와 조건부 결정/agent 효과를 묶는다. 같은 결정 재요청은 applied=false다. requester wake는 승인 tx 뒤 route에 있고 reject의 읽은 구간에는 같은 직접 wake 분기가 없다. 이를 필수 Lead wake 원자성 근거로 쓰지 않는다. | [hire decision](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/modules/agent-lifecycle/adapters/approvals.ts#L28-L93) · [org lock](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/services/accounting-transaction.ts#L7-L20) · [CAS](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/lib/approval-records.ts#L22-L64) · [post-commit wake](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/routes/approvals.ts#L330-L397) · [reject](https://github.com/paperclipai/paperclip/blob/8b873e01121a80e563a8a02bf6a3219783de5476/server/src/routes/approvals.ts#L412-L442) | 소스 확인 |
| <a id="E07"></a>E07 | Microsoft는 response의 RequestId를 세션에 저장된 pending 요청에 연결하고, 응답의 tool/인자를 저장된 call 사본으로 교체한다. unknown/같은 turn의 중복 응답은 제거한다. SnapshotRequest는 최상위 Dictionary 사본이며 중첩 불변 snapshot이 아니다. | [BindApprovalContents](https://github.com/microsoft/agent-framework/blob/08851e69d722b0e0961c08eecf8575db995f0172/dotnet/src/Microsoft.Agents.AI/ChatClient/ApprovalResponseBindingChatClient.cs#L365-L422) · [SnapshotRequest](https://github.com/microsoft/agent-framework/blob/08851e69d722b0e0961c08eecf8575db995f0172/dotnet/src/Microsoft.Agents.AI/ChatClient/ToolApprovalHelpers.cs#L20-L41) · [위조/인자 교체 test](https://github.com/microsoft/agent-framework/blob/08851e69d722b0e0961c08eecf8575db995f0172/dotnet/tests/Microsoft.Agents.AI.UnitTests/ChatClient/ApprovalResponseBindingChatClientTests.cs#L291-L338) | 소스 확인 |
| <a id="E08"></a>E08 | Microsoft binding은 session/run context가 없으면 그대로 통과한다. 실패한 inner run 뒤 pending을 유지하고, 다음 run에서 미응답한 요청은 자동 반려한다. 서버 업무 승인 보존·DB 단일 효과·조직 경계와 같은 계약이 아니다. | [실패와 소모](https://github.com/microsoft/agent-framework/blob/08851e69d722b0e0961c08eecf8575db995f0172/dotnet/src/Microsoft.Agents.AI/ChatClient/ApprovalResponseBindingChatClient.cs#L97-L119) · [no session](https://github.com/microsoft/agent-framework/blob/08851e69d722b0e0961c08eecf8575db995f0172/dotnet/src/Microsoft.Agents.AI/ChatClient/ApprovalResponseBindingChatClient.cs#L193-L213) · [미응답 반려](https://github.com/microsoft/agent-framework/blob/08851e69d722b0e0961c08eecf8575db995f0172/dotnet/src/Microsoft.Agents.AI/ChatClient/ApprovalResponseBindingChatClient.cs#L330-L357) | 소스 확인 |
| <a id="E09"></a>E09 | Temporal doUpdate는 validator→입력 재decode→accept→handler 첫 동기 부분 사이 yield를 피한다. handler 완료는 별도 promise 결과다. 테스트는 validator 인자 변경이 handler에 전달되지 않음, client deadline/abort와 workflow cancellation을 별도 assert한다. 외부 DB 부작용의 원자성 검증은 아니다. | [doUpdate](https://github.com/temporalio/sdk-typescript/blob/6a188eea837b77db33e2254397dc25b6c726b5cc/packages/workflow/src/internals.ts#L1014-L1115) · [mutation test](https://github.com/temporalio/sdk-typescript/blob/6a188eea837b77db33e2254397dc25b6c726b5cc/packages/test/src/test-integration-update.ts#L536-L558) · [timeout/cancel tests](https://github.com/temporalio/sdk-typescript/blob/6a188eea837b77db33e2254397dc25b6c726b5cc/packages/test/src/test-integration-update.ts#L830-L891) | 소스 확인 |
| <a id="E10"></a>E10 | PG18은 충돌 행 잠금으로 갱신을 직렬화하고 NO KEY UPDATE는 KEY SHARE와 호환한다. Read Committed의 대기한 UPDATE는 갱신 행의 WHERE를 재평가한다. partial unique는 predicate에 맞는 행만 제한한다. | [row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS) · [Read Committed](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) · [partial index](https://www.postgresql.org/docs/18/indexes-partial.html) | 문서 주장 |
| <a id="E11"></a>E11 | 독립 PG 모형11시나리오·62assertions PASS. 무잠금 정책 읽기 반례, 정책/add 양방향 잠금, CAS 경합, 반려 사유, 결정/worker/copy/wake/Event5종 실패 rollback, 내용 문자열 snapshot·사본 ID 분리, 교차 조직/terminal 거부와 초기 승인 전용 unique를 확인했다. | `probes/postgres-policy.mjs`, `postgres-policy-final-log.txt`; Node24.21·PG18.4·pg8.23.1. 제품/upstream schema/API 실행 아님 | 실행 확인 |
| <a id="E12"></a>E12 | Unleash는 path의 project/환경·서버 config로 switch를 제어한다. API 성공 후 toast/refetch, 실패는 error 경로다. PermissionSwitch는 UI access만 검사한다. 읽은 공개 tree에서 이 Enterprise 설정 API의 서버 guard는 확인하지 못했다. | [onConfirm](https://github.com/Unleash/unleash/blob/584eddf7fa4bd93bdbe2891da60bb052f419e214/frontend/src/component/project/Project/ProjectSettings/ChangeRequestConfiguration/ChangeRequestTable.tsx#L62-L95) · [UI guard](https://github.com/Unleash/unleash/blob/584eddf7fa4bd93bdbe2891da60bb052f419e214/frontend/src/component/common/PermissionSwitch/PermissionSwitch.tsx#L61-L94) · [설정 PUT](https://github.com/Unleash/unleash/blob/584eddf7fa4bd93bdbe2891da60bb052f419e214/frontend/src/hooks/api/actions/useChangeRequestApi/useChangeRequestApi.ts#L135-L150) | 소스 확인 |
| <a id="E13"></a>E13 | Infisical detail은 request ID·decision·trimmed comment를 한 mutation에 담는다. 양 결정 버튼은 같은 pending을 쓰고 Button은 disabled/aria-busy를 설정한다. comment는 optional이고 성공 후 상세를 닫으므로 #58 필수 반려 사유·지속 receipt는 별도 변형이 필요하다. | [payload](https://github.com/Infisical/infisical/blob/0a76cc0fa8c8e9b39be62cc553cf687ecd77a7a4/frontend/src/pages/pam/PamApprovalRequestsPage/components/ApprovalRequestDetailSheet.tsx#L39-L79) · [공유 pending](https://github.com/Infisical/infisical/blob/0a76cc0fa8c8e9b39be62cc553cf687ecd77a7a4/frontend/src/pages/pam/PamApprovalRequestsPage/components/ApprovalRequestDetailSheet.tsx#L147-L177) · [disabled](https://github.com/Infisical/infisical/blob/0a76cc0fa8c8e9b39be62cc553cf687ecd77a7a4/frontend/src/components/v3/generic/Button/Button.tsx#L124-L131) | 소스 확인 |
| <a id="E14"></a>E14 | Carbon 공식 지침은 처리중/성공/실패에 다른 label을 쓰고 처리중 연관 입력을 비활성화하도록 설명한다. 이번 Storybook blank 화면은 실행 근거에서 제외했다. | [InlineLoading 지침](https://www.carbondesignsystem.com/building-blocks/core/components/inline-loading/guidelines) | 문서 주장 |
| <a id="E15"></a>E15 | 공개 UI6캡처를 직접 조작·재열람했다. handup은 원문·입력 사유→Inbox8→7·History→같은 사유/결정자/원문 receipt, assistant-ui는390px request→Denied를 보여준다. 서버 결정/권한/다른 탭은 이 데모로 검증하지 않았다. | [handup](https://gethandup.dev/) · [ApprovalCard](https://www.assistant-ui.com/elements/approval-card); `captures/captures.md`, `probes/surface-capture-log.json`. 자동 reset 방지용 browser clock 정지는 로그에 명시 | 실행 확인 |

근거15개: **실행2·소스11·문서2**. 독립 SQL과 브라우저 client-only 데모는 제품 검증·전체 upstream 실행과 구별한다.

## 패턴


| ID | 패턴 | 사례 | 프로젝트별 차이 | 장점 | 비용·실패 모드 |
|---|---|---|---|---|---|
| <a id="P01"></a>P01 | 서버 소유 정책과 호출 권한의 별도 검사 | E01,E04,E08,E12 | SDK session gate·UI disabled는 Control Plane의 권한 경계가 아님 | 정책을 agent 입력·프롬프트와 분리 | 미등록 입구·빈 session·branding 외 field 허용으로 우회 |
| <a id="P02"></a>P02 | 정책 평가와 부작용 분기의 같은 임계구역 | E01,E05,E09–E11 | Temporal 동기 구간과 달리 여기서는 PG 공통 조직 잠금 | 정책 변경과 도구 호출의 관찰 가능한 순서 | 사전 읽기 후 await/별도 tx로 stale 정책 사용 |
| <a id="P03"></a>P03 | 검토한 요청 identity와 실제 적용 내용 결합 | E02,E07,E09,E11 | MS 얕은 사본보다 기존 하네스 content snapshot이 강함 | 검토 후 library 변경과 무관한 생성 | 같은 request ID에 다른 payload·mutable 경로 최신 조회 |
| <a id="P04"></a>P04 | 단발 결정과 필수 후속 기록의 한 tx | E02,E06,E10,E11 | Paperclip post-commit requester wake는 그대로 채택 불가 | 결정만 남고 작업자/Lead 입력이 빠지는 창 축소 | 외부 발행은 별도 전달 보장; CAS만으로 다른 명령 재시도는 못 막음 |
| <a id="P05"></a>P05 | 업무 요청 종류·명령 identity·조직 단계 분리 | E02,E07,E08,E11 | 초기 승인 pending1개·자동 반려를 일반 업무 요청에 복제하지 않음 | 연구를 계속하며 독립 요청을 검토 가능 | 종류 없는 proposal·Role 이름 dedup·반려 때 planning 회귀 |
| <a id="P06"></a>P06 | 서버 확정값·비동기 상태·지속 receipt | E03,E12–E15; [#57 E17](issue-57-references.md#E17) | Unleash 확인 모달·Infisical 닫기·demo Undo는 제품 선택과 구별 | 실패·중복·다른 탭 결정 때 사용자 판단 유지 | 낙관 체크만 남김·사유 별도 댓글·이벤트를 진실 원본으로 사용 |


## 결정 권고

아래 채택·배제는 조사 권고이며 확정 계약을 바꾸지 않는다.


| ID | 권고 | 내용 | 근거 | 이유·트레이드오프 | 질문 |
|---|---|---|---|---|---|
| <a id="D01"></a>D01 | 채택 | 조직별 작업자 추가 승인 boolean을 새 조직/저장 기본 false로 표현한다. 사용자 제어 API의 strict 입력으로만 바꾸고 조직·사용자·이전값/새값 Event를 같은 tx에 남긴다. 초기 승인/최종 완료는 선택 항목에 넣지 않는다. | P01,E04; ADR-0003 | 가장 작은 정책 항목으로 시작. UI 체크와 프롬프트는 강제 수단이 아님 | Q1,Q2,Q5 |
| <a id="D02"></a>D02 | 변형 채택 | add_worker는 토큰 scope·running run·Lead·researching과 유효한 worker Role을 확인한다. 기존 toolWrite의 조직 잠금 안에서 최신 정책을 읽어 즉시 생성 또는 승인 요청만 저장하고 명시적 created/pending 결과를 돌려준다. 대기 요청 때문에 조직을 awaiting_approval로 바꾸지 않는다. | P01–P02,E01,E05,E09–E11 | 즉시 경로도 worker·사본·Event를 원자적으로 기록. 승인 전 pending worker 생성은 배제 | Q1,Q2,Q3,Q4 |
| <a id="D03"></a>D03 | 채택 | 요청 때 서버가 읽은 Role 이름·label·Role/Soul/Skill 내용·출처/digest를 #54 방식으로 고정한다. 승인 API는 결정/사유만 받아 저장된 snapshot을 적용하며 라이브러리를 다시 읽지 않는다. 생성 때 새 agent ID와 각 파일의 별도 copy ID를 준다. | P03,E02,E07,E11 | 실제 사본 생성은 승인 시점. 요청 당시 검토 내용과 승인 시 최신 원본을 혼합하지 않음 | Q3,Q4 |
| <a id="D04"></a>D04 | 변형 채택 | 승인 kind별 proposal·허용 결정·효과를 분리한다. add_worker 승인/반려는 org+approval ID·pending·현재 적용 가능 stage를 잠금 아래 재확인하고 pending CAS 승자만 효과를 저장한다. 결정·사유·worker/사본(승인만)·Lead wake·Event를 한 tx에 둔다. 반려는 worker0·연구 단계 유지다. | P04–P05,E02,E06,E10,E11 | 초기 승인 planner의 stage/template 효과는 재사용 금지. 기존 approval_decision wake를 재사용하고 commit 뒤 publish/kick. 이미 결정409 계약 유지 | Q1,Q3,Q4 |
| <a id="D05"></a>D05 | 변형 채택 | 조직당 pending1개 제약은 initial_research에 한정하는 안을 우선한다. 서로 다른 작업자 추가 명령은 같은 Role이어도 별도 요청/작업자다. 동일 명령 재전송의 중복 방어는 안정된 operation ID로 구분하며 Role/내용 fingerprint만으로 합치지 않는다. | P03–P05,E02,E07,E11 | 여러 pending 지원과 도구 재전송 계약은 아래 #58 열린 결정. 같은 승인 ID의 CAS와 새 도구 호출 dedup은 다름 | Q2,Q3,Q4 |
| <a id="D06"></a>D06 | 보류 | 권고안은 정책 OFF 변경을 이후 새 호출에 적용하고 이미 pending인 요청은 사용자 결정까지 보존하는 것이다. OFF가 기존 요청의 일괄 실행/취소를 뜻하도록 자동 연결하지 않는다. 단계가 바뀐 요청의 승인 허용/보류/취소도 명시 계약으로 정한다. | P02,P05,E08,E11 | PG probe는 이 권고 모형이 구현 가능함만 보임. 외부 제품 사례로 제품 정책을 확정할 수 없어 owner에게 남김 | Q2,Q4,Q5 |
| <a id="D07"></a>D07 | 변형 채택 | 조직 설정에 의미가 분명한 체크박스와 기본 꺼짐 설명을 둔다. 서버 확정값·요청값·저장중·실패를 구별하고 중복 제출을 막는다. 서버 응답 후 확정하고 조직 Event/재연결로 관련 query를 재조회한다. 저장 성공 뒤 조회 실패는 저장 실패와 구별한다. | P06,E03,E12,E14 | 기존 Query/WebSocket 경로 우선. 다른 탭 갱신에 별도 broadcast 의존성이나 매번 확인 모달을 추가할 필요는 없음 | Q1,Q2,Q5 |
| <a id="D08"></a>D08 | 변형 채택 | Inbox와 별도 승인 상세에 add_worker 종류를 표시하고 요청 Role·고정된 지침 사본·요청 출처를 검토하게 한다. approve/reject만 제공하고 반려 사유는 같은 결정 명령에 필수로 담는다. 공유 pending·실패 초안 유지·409 재조회·조직/요청별 draft 격리·시각/사유/생성 작업자 링크 receipt를 제공한다. | P05–P06,E02,E03,E13,E15; [#57 E17](issue-57-references.md#E17) | 초기 승인 세 결정은 유지. 작업자 추가 설명에 planning 회귀·전체 팀 생성 문구를 쓰지 않음. 제거된 버튼의 포커스는 receipt로 연결 | Q3,Q4,Q5 |
| <a id="D09"></a>D09 | 채택 | 가짜 실행기의 실제 조직 도구 HTTP로 OFF/ON/승인/반려와 worker·사본·Lead wake·Event를 검증한다. 정책변경/add 및 approve/reject 경합, 저장 실패 rollback, cross-org/worker/종료 토큰/위조 field를 음성 대조한다. 사용자 API의 local_trusted 경계는 현 구조 문서를 따른다. | P01–P06,E01–E03,E11; AGENTS | 조직 도구에 정책 변경이 없다는 검증과 같은 OS 프로세스의 임의 Owner HTTP 차단은 다른 주장. 실제 실행 환경 격리는 이번 조사에서 보장하지 않음 | Q1,Q2,Q3,Q4,Q5 |
| <a id="D10"></a>D10 | 배제 | 새 workflow/정책/queue 엔진, 승인 전 worker row, MS의 다음 turn 미응답 자동 반려, 승인 카드 always-allow·Undo, 초기 승인 생략·사용자 최종 완료 대체로 범위를 넓히지 않는다. | P01–P06,E05,E08,E15; ADR1–4 | #58의 한 정책 항목과 제품 불변 조건 보존. 외부 사례의 운영 정책을 자동 채택하지 않음 | Q1,Q2,Q3,Q4,Q5 |


### 배제한 패턴

| 패턴 | 사례 | 이유 |
|---|---|---|
| 승인 전 pending agent·파일 생성 | E05 | #58은 요청만 만들고 worker/사본은 승인 때 생성 |
| read-policy→별도 await/tx→create | E05,E09,E11 | 정책 변경 뒤 stale 분기 가능; JS 단일 thread로 해결되지 않음 |
| SDK session·프롬프트·UI disabled만으로 승인/조직 격리 | E07,E08,E12 | 모든 제품 쓰기 입구의 신원·Role·stage·scope 검사를 대체하지 못함 |
| 초기 승인 planner/unique/세 결정 폼을 통째로 공유 | E02,E03 | 연구 단계·template 재생성·반려 효과·pending 수가 다름 |
| 승인 commit 뒤 필수 wake만 best-effort | E06 | 반려 포함 Lead 깨우기를 잃을 수 있음 |
| 같은 Role payload 자동 dedup·미응답 자동 반려 | E07,E08 | 별개 명령과 재전송·장기 pending 의미를 혼동 |
| Undo/always-allow·다중 승인자·secret URL 승인·새 엔진 | E15 및 Discovery 후보 | 확정 단일 사용자 정책과 범위가 다름 |

## 구현 참고



권고의 중심은 **조직 잠금 아래 최신 정책 분기, 승인 전 worker0, 요청 내용 고정, 결정·사본·Lead wake·Event 원자성**이다.

- `packages/contracts`: 조직 정책 read/write와 도구 결과의 created/pending 구별, 승인 kind별 payload/결정 계약. runtime 소속 조직은 body로 받지 않는다.
- `packages/core`: 정책 분기·worker snapshot·worker/사본 생성 계획과 종류별 결정 효과. 기존 `copyInstructions`를 재사용하고 초기 승인 stage/template 변경은 분리한다.
- `packages/db`: 정책 명령·도구·승인에 공통 조직 잠금, org predicate/CAS·복합 FK·종류별 unique·동일 tx 효과. 승인 requester의 옛 run이 끝났더라도 영속 요청의 사용자 결정은 별도 명령이다.
- `apps/server`: 기존 `/api/tools/workers` 501을 도구 경계에 연결하고 사용자 정책 명령을 별도로 제공. DB commit 뒤 EventHub/dispatcher 호출. runtime이나 harness가 정책 저장을 대신하지 않는다.
- `apps/web`: 조직 설정 query/체크박스와 승인 종류별 상세를 기존 shell·Inbox·org query key·Event 경로로 연결. `harness/` 연구 지침은 이 조사에서 바꾸지 않는다.

아래는 **구현 검증 제안**이다. 이번 조사에서 제품 테스트로 실행한 항목이 아니다.


| ID | 검증할 경계 (입력 → 행동 → 기대) | 근거 |
|---|---|---|
| V01 | 새 조직·정책OFF → Lead add_worker → worker1·독립 Role/Soul/Skill 사본·승인0, 조직A만 변경 | D01–D03 |
| V02 | 정책ON → 같은 호출 → pending+approval ID, worker/copy0·단계researching 유지·Inbox 항목 | D02,D08 |
| V03 | pending 승인 → 고정 snapshot worker·사본·결정·Lead wake·Event; 반려+사유 → worker0·사유 포함 Lead 입력·단계 유지 | D03,D04 |
| V04 | 정책변경/add 양방향 경합 → 공통 잠금 순서에 맞는 최신 정책 분기. 정책 Event의 전후값·조직 정확 | D01,D02; E11 |
| V05 | approve/approve·approve/reject 동시·같은 결정 재전송 → 한 승자, 명시 중복거부, worker/copy/wake/Event 중복0 | D04 |
| V06 | 결정·worker·각 사본·wake·Event 저장 실패 → 전체 rollback. commit 뒤 publish/kick 오류·응답유실 → 저장 결과 조회로 확인 | D02,D04 |
| V07 | 요청 뒤 library 내용/Role 삭제·변경 → 승인은 요청 snapshot만 적용; 같은 Role 두 worker → copy ID 다름·한 사본 편집은 다른 사본 불변 | D03; 실제 편집 후속 #64 |
| V08 | A token+B ID·body org/actor/policy 위조·worker role·계획수립·종료 token 직접 HTTP → 거부·worker0, 거부 Event는 해당 도구 규칙과 일치 | D01,D02,D09 |
| V09 | 여러 별도 add 명령·같은Role 반복·동일 operation 재전송 → 선택한 pending 수/dedup 계약대로, 초기 승인 pending1개 규칙 유지 | D05 |
| V10 | 정책OFF 후 기존 pending·결과검토/일시정지/최종완료/중단 뒤 결정 → 선택한 계약을 검증하고 terminal에서 worker 생성0 | D04,D06; #59 연계 |
| V11 | 체크박스 저장 지연/실패/성공·조회실패 → 저장중/실패 구별, 서버 확정값으로 수렴. 두 탭·조직A→B 이동·Event 재연결 → 해당 조직만 갱신 | D07 |
| V12 | Inbox→작업자 추가 상세→사유 반려/승인→receipt, 390px·공유 pending·실패 초안·409·포커스. 초기 승인 폼/문구/결정 회귀 없음 | D08 |



| 열린 결정 | owner | 선택지와 근거 |
|---|---|---|
| 정책OFF 시 기존 pending | 사용자 / #58 | 추천: 기존 요청은 보존하고 이후 호출만 새 정책 적용. 대안: 별도 명시 명령으로 선택 요청 취소/적용. 단순 체크해제가 일괄 승인인 안은 검토 내용을 우회하므로 비추천(D06). 실행 실험은 권고 모형만 검증 |
| 연구 단계 변경 뒤 pending 결정 | 사용자 / #58, 실행제어 연계 #59 | 추천: worker 생성은 researching에서만, 그 밖에는 명시 conflict/대기·terminal 생성 금지. 대안: paused에서 결정만 저장하고 적용을 재개 때 분리하되 추가 적용 상태/복구 계약 필요. reject 허용 단계·terminal 요청 정리도 정해야 함 |
| 여러 요청과 도구 재전송 식별 | Issue #58 | 추천: initial만 pending1개, worker 요청은 명령별 독립·명시 operation ID 재전송 dedup. 대안: worker 요청도1개로 제한하되 충돌과 재시도 계약 명시. Role 이름/인자만 같은 호출을 모두 합치는 안은 배제(D05) |


후속 범위: 일시정지·재개/중단은 #59, 강제 crash 뒤 재시작 재조정은 #60, 알림 outbox·Inbox 읽음/보관은 #61, 실제 사본 편집·revision은 #64다. #58의 기본 pending 조회와 영속 wake/Event 저장을 이 후속으로 미루지 않는다. 목표·완료 기준 변경 정책은 현재 #58 범위가 아니다.

## 한계와 미확인

- 실행함: 독립 PG11시나리오/62assertions, 공개 client-only 데모6캡처 조작·재열람. SQL은 축약 schema와 내용 문자열을 쓴 메커니즘 실험이며 실제 Role 파일 복사·제품 API 실행이 아니다. 새 패키지 설치·OSS 전체 self-host·실제 모델 호출은 없었다.
- 미실행: 제품 테스트/API/E2E·전체 upstream tests·.NET 테스트(dotnet 없음)·Temporal 서비스·실제 승인 backend·정책 변경과 전체 runtime 경합·강제 crash 자동 복구·외부 전달 exactly-once. 따라서 이번 조사로 제품 승인/격리/실시간 AC가 통과했다고 주장하지 않는다.
- 실화면 미확인: 실제 조직 설정 체크박스 저장·실패/권한없음·다른 탭/교차 조직 stale. 이 권고는 고정 소스/계약/공식 문서 기반이다. Carbon Storybook body가 비어 있었으며 화면 근거에서 제외했다. Unleash Enterprise 서버 guard, Infisical PAM entitlement·EE LICENSE·global error UI도 미확인이다.
- handup/assistant-ui 배포와 source SHA 대응·서버 영속성/권한·실제 agent 전달은 미확인. assistant Denied 재캡처는 demo 자동 reset만 browser clock으로 막았고 fake backend 성공을 넣지 않았다. 회사 캡처는 gitignore cache에만 보관하며 이슈/저장소에 올리지 않는다.
- 접근 실패: 일반 sandbox GitHub 네트워크/loopback은 허용 환경으로 재시도했고, probe의 prepared-statement 다중 SQL 및 Playwright 상대 경로 오류는 보정했다. 초기 실패 로그도 보존한다. incld/Novu 일부 원문·OPA/Cedar playground·일부 Camunda 문서는 접근/안정버전 확인 실패로 결정 근거에서 제외했다. 이 실패를 기능 부재 증거로 쓰지 않는다.
- local_trusted 사용자 API는 로그인 없는 loopback 신뢰 모델이다([현재 구조](../architecture.md#제품-불변-조건-강제-위치), [#57 추가 조사](issue-57-references.md#사용자-api-신뢰경계-추가-조사)). 조직 도구에 정책 변경이 없다는 사실로 같은 OS의 임의 HTTP/DB 접근까지 차단했다고 주장하지 않는다. 실제 실행기 격리는 후속 검토 대상이다.
- 문서는 커밋하지 않고 구현 변경과 함께 검토하도록 남긴다. 권고가 이슈/AGENTS/GLOSSARY/ADR보다 우선하지 않는다. 정책 의미의 열린 결정은 위 owner가 확정해야 한다.
