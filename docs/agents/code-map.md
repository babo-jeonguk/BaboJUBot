# 코드 지도

해당 작업 절의 진입점·테스트부터 읽고 `rg`로 호출·계약을 따라갑니다. 표에 없으면 가까운 진입점에서 검색합니다.
현재 구현은 [README](../../README.md), 요구는 [features](../features.md)·이슈, 목표 책임은 [architecture](../architecture.md), 용어·결정은 [domain](domain.md)을 따릅니다. 검사 실행 기준은 README가 맡습니다.

## 조직 생성·Event·공통 화면

통합 검증: [조직 API](../../apps/server/test/organizations.test.ts), [생성·다른 탭 갱신 E2E](../../apps/web/e2e/create-organization.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 생성 입력(이름·연구 목표·선택 완료 기준)·응답·생애주기 값 | [contracts/organization.ts](../../packages/contracts/src/organization.ts); core·DB schema·웹 표시 | [계약](../../packages/contracts/src/organization.test.ts) |
| 초기 상태(`계획 수립`·사용자 목표)·전용 Lead·생성 깨우기·생성 Event | [core/organization.ts](../../packages/core/src/organization.ts) `planOrganizationCreation` → [server/organizations.ts](../../apps/server/src/organizations.ts)(commit 뒤 Lead `kick`) | [core](../../packages/core/src/organization.test.ts), 조직 API |
| 생성 저장·rollback, 생성 깨우기 하나 | [db/organizations.ts](../../packages/db/src/organizations.ts) `insertOrganizationCreation`; [schema](../../packages/db/src/schema.ts)·[migrations](../../packages/db/migrations/)(`wakes` 조직 생성 부분 unique, 목표 없는 완료 기준 금지) | [DB 제약](../../packages/db/src/organizations.test.ts) |
| 목표 없이 만든 예전 조직(`목표 설정`)의 검사 준비 | [db/testing.ts](../../packages/db/src/testing.ts) `insertLegacyOrganization` | 승인·제어·재시작 복구 API |
| 생성·조회 API·입력 오류·404 | [server/app.ts](../../apps/server/src/app.ts) `startServer` → 생성 서비스·DB·contracts | 조직 API |
| 조직별 구독·Event 혼입 | app.ts upgrade·attach → [EventHub](../../apps/server/src/event-hub.ts); [event 계약](../../packages/contracts/src/event.ts) | [라우팅](../../apps/server/src/event-hub.test.ts), 조직 API `Event stream scopes` |
| 생성 후 탭·홈·사이드바 갱신 | [web/live-events.ts](../../apps/web/src/live-events.ts) `useLiveEvents`; [api.ts](../../apps/web/src/api.ts) query key·캐시; Event 발행 | 생성 E2E |
| Event가 몰릴 때 늦은 반영·겹친 재조회 | [web/live-refresh.ts](../../apps/web/src/live-refresh.ts) `createLiveRefresh`(조회마다 진행 하나·그사이 신호는 끝난 뒤 한 번 더) | [단위 검사](../../apps/web/src/live-refresh.test.ts), [느린 응답·재연결 다른 탭 E2E](../../apps/web/e2e/live-refresh.spec.ts) |
| E2E가 Event stream 구독 성립 전에 상태를 바꿈·ready를 기다리다 멈춤 | [e2e/support/live-events.ts](../../apps/web/e2e/support/live-events.ts) `openWithLiveEvents`(화면과 같은 frame 계약·제한 시간·listener 해제. `routeWebSocket` page 제외) | [helper 검사](../../apps/web/e2e/support/live-events.spec.ts) |
| 주소는 바뀌었는데 화면·선택이 늦게 바뀜(이전 화면이 입력을 받음) | [main.tsx](../../apps/web/src/main.tsx) `RouterProvider useTransitions={false}`(라우터 갱신을 startTransition으로 미루지 않음. 미루면 재조회 갱신에 밀려 최대 약 5초 늦음) | [연구 지도 E2E](../../apps/web/e2e/research-map.spec.ts) `watchSelectionLag`(CPU 4배 감속에서 주소·패널 노드 불일치 구간) |
| 생성 dialog(이름·연구 목표 필수, 완료 기준 선택)·성공 이동·실패 안내 | [create-organization.tsx](../../apps/web/src/create-organization.tsx), api.ts `useCreateOrganization`, 입력 계약 | 생성 E2E, 초기 승인 E2E(완료 기준 비움) |
| 주소·메뉴·홈·빈 상태 | [pages.tsx](../../apps/web/src/pages.tsx), [home.tsx](../../apps/web/src/home.tsx) `Home`·`NoOrganizations`, [shell.tsx](../../apps/web/src/shell.tsx), [main.tsx](../../apps/web/src/main.tsx) routes | 생성 E2E의 홈·메뉴, Lead 대화 E2E의 빈 화면 |
| 되돌릴 수 있는 행동 뒤의 되돌리기 토스트(아래 가운데 더미·새것이 맨 아래·토스트마다 10초·마우스/포커스가 있는 토스트만 멈춤·Esc·닫기·한 번에 셋, 넘치면 차례를 기다렸다가 나타난 때부터 10초), 아이콘 버튼 tooltip | [toast.tsx](../../apps/web/src/toast.tsx) `ToastProvider`·`useToast`(main.tsx `Root`), 수명·한도 규칙은 [toast-stack.ts](../../apps/web/src/toast-stack.ts), ui.tsx `Tip`. 쓰는 곳: 연구 지도 폐기, 줄 세운 메시지 실패 | [단위 검사](../../apps/web/src/toast-stack.test.ts), 연구 지도 E2E의 폐기·폐기 취소·두 노드 연속 폐기 |
| 공용 UI·상태·반응형 | [ui.tsx](../../apps/web/src/ui.tsx), [index.css](../../apps/web/src/index.css), 해당 화면 | 생성 E2E만으로 모든 화면·폭을 검증하지는 않음 |
| 긴 글이 `#`·`**` 기호 그대로 보임·Markdown 링크·HTML 안전 | [markdown.tsx](../../apps/web/src/markdown.tsx) `Markdown`(react-markdown·remark-gfm·remark-breaks. 원문 HTML은 글자로, 안전하지 않은 주소는 비움, 바깥 링크는 새 탭·`noopener noreferrer`, 이미지는 링크, 글 속 제목은 두 단계 내림, 맨 앞 frontmatter는 코드 블록, `~` 하나는 취소선 아님), [markdown.css](../../apps/web/src/markdown.css). 쓰는 곳: 산출물(`format` markdown만)·작업 내용·자기 보고·댓글(tasks.tsx), Lead 대화(chat.tsx), 승인 계획·환경·사본 미리보기(approvals.tsx), 결과 요약(results.tsx), Inbox 상세 발췌·실행 요약(inbox-detail.tsx), 목표·완료 기준(pages.tsx와 위 상세), Role·Soul·Skill 사본·revision 보기·실행 시도 요약·깨우기 사유(agents.tsx), 연구 노드 본문(research-map.tsx). 편집 폼 textarea는 원문 그대로 | [단위 검사](../../apps/web/src/markdown.test.tsx), 작업 화면·초기 승인 E2E의 제목 role |

## 실행 시도·조직 도구·대화

통합 검증: [실행 API](../../apps/server/test/runs.test.ts), [여러 대화 API](../../apps/server/test/conversations.test.ts), [Lead 대화 E2E](../../apps/web/e2e/lead-chat.spec.ts), [여러 대화 E2E](../../apps/web/e2e/lead-conversations.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 실행 요청·공개 활동·종료·취소, 도구·메시지 | [contracts/run.ts](../../packages/contracts/src/run.ts), [tools.ts](../../packages/contracts/src/tools.ts), [message.ts](../../packages/contracts/src/message.ts), event.ts | [계약](../../packages/contracts/src/run.test.ts) |
| 메시지·깨우기·bundle·세션 이어 가기·토큰 규칙 | [core/run.ts](../../packages/core/src/run.ts) | 실행 API; API로 어려운 bundle 버전별 세션은 [core](../../packages/core/src/run.test.ts) |
| 대기열·에이전트당 실행 하나·bundle 고정·종료/쓰기 직렬화 | [db/runs.ts](../../packages/db/src/runs.ts) `claimNextRun`·`finishRun`·`insertAgentMessage`; schema·migrations | [DB admission·동시성](../../packages/db/src/runs.test.ts) |
| 깨우기·DB admission/종료 저장 재시도·실행기 호출·활동 필터·종료 취소 | [server/dispatcher.ts](../../apps/server/src/dispatcher.ts) `RunDispatcher`, [run-token.ts](../../apps/server/src/run-token.ts) | 실행 API |
| HTTP 토큰 인증·교차 조직 404·종료 토큰 거부 | [server/tools.ts](../../apps/server/src/tools.ts), db/runs.ts `authenticateRun` | 실행 API `organization tools` |
| 대화·실행 시도·에이전트 조회 | server/app.ts, [conversation.ts](../../apps/server/src/conversation.ts) | 실행 API |
| 여러 대화: 대화·목록 모양, 새 대화 시작 입력·결과, 본 위치, 답장의 `conversationId` | contracts message.ts `conversationSchema`·`conversationSummarySchema`·`startConversationResultSchema`·`sendAgentMessageInputSchema`, run.ts 깨우기 `owner_message.conversationId`·맥락 `conversations`, event.ts `message.created.conversationId` | [계약](../../packages/contracts/src/run.test.ts) |
| 새 대화 제목·기본 대화(조직 생성 때), 답장이 갈 대화(고른 대화 → 받은 사용자 메시지의 대화 → 기본 대화, 여러 대화면 골라야 함) | core run.ts `planOwnerMessage`(`new`면 대화도 계획)·`conversationTitle`·`chooseReplyConversation`·`planDefaultConversation`, organization.ts `planOrganizationCreation` | [core](../../packages/core/src/run.test.ts) |
| 대화 저장(새 대화는 첫 메시지와 한 transaction)·목록 순서·읽지 않음·본 위치·실행 시도 맥락의 대화, 다른 조직 대화 404, migration 0014 backfill | [db/conversations.ts](../../packages/db/src/conversations.ts), db/runs.ts `insertOwnerMessage`·`insertAgentMessage`·`loadRunContext`; schema `conversations`·`messages.conversation_id`(복합 FK)·migration 0014 | [DB](../../packages/db/src/conversations.test.ts) |
| 대화 API: `GET/POST /api/organizations/:id/conversations`, `GET/POST …/conversations/:conversationId/messages`, `PUT …/read`, 기본 대화는 `/messages`로도 | server/app.ts `findChat`, conversation.ts `sendOwnerMessage`; 도구 오류는 problems.ts `conversation_required`(422) | 여러 대화 API |
| 가짜 실행기·도구 client·테스트 gate | [runtime/scripted.ts](../../packages/runtime/src/scripted.ts), [tools-client.ts](../../packages/runtime/src/tools-client.ts), [testing.ts](../../packages/runtime/src/testing.ts) | [가짜 실행기](../../packages/runtime/src/scripted.test.ts) |
| README 데모 시나리오(목표를 적어 생성→초기 승인→작업 결과→일시정지·재개·작업자 추가 승인→결과 제출→최종 완료)가 이어지지 않음 | runtime/scripted.ts `demoLeadScript`·`demoWorkerScript`, 각 단계의 화면 | [데모 흐름 E2E](../../apps/web/e2e/demo-flow.spec.ts)(주요 사용자 행동을 모두 화면으로 한 조직에서). 직접 거부·조직 격리·heartbeat due·복구는 각 절의 API 검증 |
| 대화·활동·실행 시도 상세·에이전트 화면(조직도는 아래 [에이전트 조직도·이름·얼굴](#에이전트-조직도이름얼굴)) | [chat.tsx](../../apps/web/src/chat.tsx), [activity.tsx](../../apps/web/src/activity.tsx), [agents.tsx](../../apps/web/src/agents.tsx); api.ts query key | Lead 대화 E2E |
| 대화 목록(왼쪽·390px 시트)·새 대화(`/chat/new`, 첫 보내기 뒤 그 대화 주소로)·읽지 않음 점(화면이 보일 때 본 위치 저장)·`/chat/:conversationId` | chat.tsx `LeadChat`·`ConversationList`·`Thread`·`DraftThread`, main.tsx route, pages.tsx `OrganizationScreen`; api.ts `useConversations`·`useConversation`·`useSendMessage`·`useStartConversation`·`useMarkConversationRead` | 여러 대화 E2E(다른 탭·390px 포함) |
| 대화 기록 화면: 최근 쪽부터 그리고 위로 올리면(맨 위 sentinel 300px, 한 번에 하나, 받은 뒤 새 스크롤 필요) 또는 `이전 메시지 보기`로 오래된 쪽을 붙임, 보던 맨 위 메시지 자리 되돌리기(`overflow-anchor: none`), 64px 안에서만 따라 내려가기와 그 밖의 `맨 아래로` 버튼, 새 메시지만 이어 받기(Event의 `meta.liveRefresh`만 부름, 기다리는 사이 가장 새 쪽이 바뀌었으면 그 응답을 버리고 다시 받음, 받은 쪽마다 따로 둠), 따라가는 동안 100개 넘으면 오래된 쪽 덜어 내기, 사용자 말풍선 시각(`deliveredAt ?? createdAt`) | chat.tsx `Transcript`·`MessageList`(`aria-busy`)·`MessageBubble`, api.ts `useConversation`(useInfiniteQuery)·`catchUpConversation`·`appendArrivals`·`trimTranscript`, live-refresh.ts | [긴 대화 E2E](../../apps/web/e2e/lead-chat-history.spec.ts), [창 단위](../../apps/web/src/transcript-window.test.ts), [live refresh 단위](../../apps/web/src/live-refresh.test.ts) |
| 가짜 Lead의 답장 대화(사용자 메시지는 그 대화, 그 밖은 기본 대화, 대화마다 답장) | runtime/scripted.ts `leadReplyScript`·`replyConversationOf`·`defaultConversationOf`, tools-client.ts `sendMessage` | 가짜 실행기 테스트 |
| 후속 실제 adapter | [runtime/index.ts](../../packages/runtime/src/index.ts)에 추가, 요청 `instructions` 사본을 실행기에 주입 | 실제 adapter 테스트 없음; 후속 이슈의 계약 확인 |

## 초기 연구 승인·하네스

통합 검증: [승인 API](../../apps/server/test/approvals.test.ts), [초기 승인 E2E](../../apps/web/e2e/initial-approval.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 목표(예전 조직)·승인 요청(Lead 제안 완료 기준)/결정·사본·Inbox | [contracts/approval.ts](../../packages/contracts/src/approval.ts), [harness.ts](../../packages/contracts/src/harness.ts); event.ts, 도구 이름·경로·method는 tools.ts | 승인 API |
| Role/단계 도구 규칙·snapshot(완료 기준 제안 필수·사용자 기준 변경 거부)·결정 효과(승인한 제안을 조직 완료 기준으로) | [core/approval.ts](../../packages/core/src/approval.ts) `toolRules`·`checkToolCall`·`buildInitialResearchProposal`·`planApprovalDecision`; 응답 코드는 server/problems.ts | [core](../../packages/core/src/approval.test.ts), 승인 API |
| bundle 버전 직렬화·frontmatter·UTF-8 | [core/harness.ts](../../packages/core/src/harness.ts) | [core](../../packages/core/src/harness.test.ts) |
| 라이브러리 구조·읽기 실패·Lead Role | [harness 안내](../../harness/README.md), [server/harness.ts](../../apps/server/src/harness.ts) `loadHarnessLibrary` | 승인 API에서 라이브러리와 사본 비교 |
| 거부 Event·전이 경합·결정 단일 적용/rollback | [db/tool-calls.ts](../../packages/db/src/tool-calls.ts) `gateToolCall`·`toolWrite`, [db/approvals.ts](../../packages/db/src/approvals.ts) `decideApproval`; [rows.ts](../../packages/db/src/rows.ts) `lockOrganization` | 승인 API 동시 결정·거부 기록 |
| 에이전트/조직 템플릿 사본·admission bundle 버전 | [db/harness.ts](../../packages/db/src/harness.ts), db/runs.ts `claimNextRun`·`selectWakes` | DB 조직 저장 테스트, 승인 API |
| 결정 명령·Inbox·요청/사본 조회 API | server/app.ts, [server/approvals.ts](../../apps/server/src/approvals.ts); 도구 handler는 server/tools.ts | 승인 API |
| 가짜 Lead 생성 깨우기→승인 요청(완료 기준이 없으면 `demoCompletionCriteria` 제안)→재제출, 예전 조직의 목표 메시지 | runtime/scripted.ts `demoLeadScript`·`demoProposal` | 가짜 실행기 테스트 |
| 결정 폼·`Lead 제안` 완료 기준(`ProposedCriteria`, Inbox 상세와 공유)·조직 대시보드·팀 | [web/approvals.tsx](../../apps/web/src/approvals.tsx), pages.tsx `OrganizationDashboard`; Inbox 패널은 아래 [알림 outbox·가짜 채널·Inbox](#알림-outbox가짜-채널inbox) | 초기 승인 E2E |

## Role·Soul·Skill 사본 편집

통합 검증: [사본 편집 API](../../apps/server/test/instructions.test.ts), [사본 편집 E2E](../../apps/web/e2e/instructions.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 사본 revision 번호·revision 모양·편집 입력·크기 상한, 깨우기 사유·Event | contracts/harness.ts `instructionCopySchema`·`instructionRevisionSchema`·`editInstructionCopyInputSchema`, run.ts `instruction_edit`, event.ts `instruction_copy.edited` | 사본 편집 API |
| 종료 조직·오래된 기준 revision·Skill frontmatter 거부, revision·Lead 깨우기·Event 계획 | core/harness.ts `planInstructionEdit` | [core](../../packages/core/src/harness.test.ts) |
| 조직 잠금 아래 사본·revision·깨우기·Event 한 transaction, 교차 조직 404, 처음 사본의 revision 1 | db/harness.ts `editInstructionCopy`·`insertInstructionCopies`·`listInstructionRevisions`·`findInstructionRevision`; schema `instructionRevisions`(복합 FK)·migration 0009 | 사본 편집 API의 동시 저장·종료 조직 |
| 편집 API·거부 코드·commit 뒤 Lead 촉진·본문 크기 상한 | server/app.ts `/agents/:agentId/instructions/:copyId`, [server/instructions.ts](../../apps/server/src/instructions.ts), app.ts `jsonBodyLimitBytes` | 사본 편집 API |
| 편집 뒤 다음 실행 시도의 bundle·새 세션 | db/runs.ts `claimNextRun`(사본 내용으로 bundle) → core/run.ts `planRunStart`(버전이 다르면 이전 세션 없음) | 사본 편집 API의 진행 중·다음 실행 시도 |
| 에이전트 상세 탭·사본 편집기·draft/충돌·이동 차단·revision 목록·예전 revision 보기 | agents.tsx `AgentDetailPage`·`InstructionCopies`·`RevisionList`·`RevisionView`, api.ts `useEditInstructionCopy`·`useInstructionRevisions`·`useInstructionRevision`; 이동 차단은 main.tsx data router의 `useBlocker` | 사본 편집 E2E(390px 다른 탭 포함), 초기 승인 E2E의 사본 독립 |

## 작업·작업자 실행 시도·산출물

통합 검증: [작업 API](../../apps/server/test/tasks.test.ts), [작업 화면 E2E](../../apps/web/e2e/tasks.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 작업·댓글·산출물·에이전트 간 메시지 입력과 조회 모양, 깨우기 사유·Event | [contracts/task.ts](../../packages/contracts/src/task.ts), run.ts `wakeReasonSchema`, event.ts, 도구 이름·경로·오류 코드는 tools.ts | 작업 API |
| 깨울 에이전트(부모 담당자·생성자·담당자·수신자, 자기 자신 제외)·착수/완료 권한·중복 완료 | [core/task.ts](../../packages/core/src/task.ts); 단계 규칙은 core/approval.ts `toolRules` | [core](../../packages/core/src/task.test.ts), 작업 API |
| 같은 조직 참조 확인·기록과 깨우기·Event의 한 transaction·조건부 완료 | [db/tasks.ts](../../packages/db/src/tasks.ts), [db/tool-calls.ts](../../packages/db/src/tool-calls.ts) `toolWrite`(조직→실행 시도 잠금·취소·단계 재확인); 복합 FK는 schema·migrations | 작업 API의 교차 조직·중복 완료 |
| 깨우기 사유 읽기·실행 맥락의 팀 | db/runs.ts `selectWakes`·`loadRunContext` | 작업 API, 실행 API |
| 작업 도구 HTTP·거부 코드·commit 뒤 깨운 에이전트 촉진 | server/tools.ts `respondWrite`; 사용자 댓글은 [server/tasks.ts](../../apps/server/src/tasks.ts)·app.ts | 작업 API |
| 가짜 Lead 분담·가짜 작업자 착수→산출물→완료·댓글 답장 | runtime/scripted.ts `demoLeadScript`·`demoWorkerScript` | 가짜 실행기 테스트, 작업 화면 E2E |
| 작업 목록·상세·댓글 입력·산출물 단건·이동 경로 | [web/tasks.tsx](../../apps/web/src/tasks.tsx), main.tsx routes, shell.tsx 경로 표시; api.ts query key | 작업 화면 E2E(390px·댓글 실패 시 입력 유지 포함) |

## 연구 지도

통합 검증: [연구 지도 API](../../apps/server/test/research-map.test.ts), [연구 지도 E2E](../../apps/web/e2e/research-map.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 노드·보조 연결·편집 기록 모양, 입력, 사용자 편집 단계, 도구 이름·경로·오류 코드, 깨우기 사유·Event | [contracts/research-map.ts](../../packages/contracts/src/research-map.ts), tools.ts, run.ts `research_map_edit`·`researchFlow`, event.ts `research_map.edited` | 연구 지도 API |
| 종류 선언·주 부모 지정/변경·순환·자기 연결·폐기/폐기 취소·작업 연결 0~1·같은 값 무변경·사용자 편집의 Lead 깨우기 | [core/research-map.ts](../../packages/core/src/research-map.ts) `plan*`; 도구 단계 규칙은 core/approval.ts `toolRules` | [core](../../packages/core/src/research-map.test.ts) |
| 조직 잠금 아래 최신 지도 읽기·변경·편집 기록·깨우기·Event 한 transaction, 교차 조직 404 | [db/research-map.ts](../../packages/db/src/research-map.ts) `writeResearchMap`(도구)·`editResearchMap`(사용자); 복합 FK·노드당 주 부모 열은 schema·migrations | 연구 지도 API의 교차 조직·동시 주 부모 변경 |
| 도구 HTTP·사용자 편집 API·거부 코드표·commit 뒤 Lead 촉진 | server/tools.ts 연구 지도 도구, app.ts `/research-*`, [server/research-map.ts](../../apps/server/src/research-map.ts), [server/problems.ts](../../apps/server/src/problems.ts) | 연구 지도 API |
| 지도 화면·배치·보조 연결 표시·상세 패널·편집 폼·드래그(보기 상태)·묻지 않는 폐기와 토스트의 폐기 취소 | [web/research-map.tsx](../../apps/web/src/research-map.tsx) `DiscardControl`, api.ts `useResearchMap`·`useEditResearchMap`; 작업 상세의 연결 노드는 tasks.tsx | 연구 지도 E2E(390px·실패 시 입력 유지 포함) |
| 큰 지도의 화면 끌기·선택·노드 끌기 비용 | research-map.tsx `EdgeLayer`(연결 전체를 노드 아래 SVG로)·`focusCss`(강조 노드를 덮개 위로)·`reuse`(바뀐 노드·연결 객체만 새로); [web/research-map.css](../../apps/web/src/research-map.css) 덮개·점선·합성 레이어. React Flow edge는 강조할 연결만 | [성능 측정](../../apps/web/e2e/research-map-perf.spec.ts) `MAP_PERF=1`(프로덕션 빌드, 50/200/500노드·보조 0/20/100%·1280/390px). 연구 지도 E2E의 정적·강조 경로 일치 |

## 결과 제출·최종 완료

통합 검증: [결과 API](../../apps/server/test/results.test.ts), [결과 검토 E2E](../../apps/web/e2e/result-review.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 제출 입력·결정 입력·제출 상세/목록 모양, Inbox 항목 종류, 깨우기 사유 `result_changes_requested`·Event `result.*` | [contracts/result.ts](../../packages/contracts/src/result.ts), [inbox.ts](../../packages/contracts/src/inbox.ts), run.ts, event.ts, 도구 `submit_result`는 tools.ts | 결과 API |
| 제출(검토 기준 고정)·결정 효과(단계·Lead 깨우기)·Lead만 `연구 진행`에서 제출 | [core/result.ts](../../packages/core/src/result.ts); 도구 규칙은 core/approval.ts `toolRules` | 결과 API |
| admission을 막는 단계(최종 완료·일시정지·중단) | core/run.ts `admitsRuns`·`runBlockingStages` → db/runs.ts `claimNextRun`(조직 `FOR SHARE` → 에이전트 잠금)·`listAgentsWithPendingWakes` | [DB 잠금 순서](../../packages/db/src/runs.test.ts) `admission and organization stage`, 결과 API 재시작 |
| 같은 조직 근거 확인·제출과 단계·Event 한 transaction, 결정 단일 적용·옛 제출 409 | [db/results.ts](../../packages/db/src/results.ts) `submitResult`(toolWrite)·`decideResult`(조직 잠금·pending 조건부); 복합 FK는 schema·migrations | 결과 API 동시 결정·교차 조직 |
| Inbox 조회(승인 요청·결과 제출·실패한 실행 시도) | [db/inbox.ts](../../packages/db/src/inbox.ts) `listInbox` | 결과 API, 승인 API, 알림 API |
| 결정 명령·조회 API·commit 뒤 Lead 촉진 | server/app.ts `/results`, [server/results.ts](../../apps/server/src/results.ts); 도구 handler는 server/tools.ts | 결과 API |
| 가짜 Lead의 `결과 제출` 부탁 → 제출, 수정 요청 → 재제출 | runtime/scripted.ts `demoLeadScript`·`submitResultScript`(`then` 단계) | 결과 API `demo Lead result submission` |
| 결과 검토 목록·상세·결정 폼/기록·Inbox 항목·대시보드 안내 | [web/results.tsx](../../apps/web/src/results.tsx), inbox.tsx `InboxPanel`, pages.tsx, api.ts `useDecideResult` | 결과 검토 E2E(390px·실패 시 의견 유지·다른 탭 결정 포함) |

## 승인 정책·작업자 추가

통합 검증: [작업자 추가 API](../../apps/server/test/workers.test.ts), [작업자 승인 정책 E2E](../../apps/web/e2e/worker-approval-policy.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 정책 모양·기본값·변경 입력, 작업자 추가 입력·결과(`added`/`pending_approval`)·snapshot, 종류별 결정(`approvalKindDecisions`)·Event `organization.approval_policy_changed`·`worker.added` | [contracts/organization.ts](../../packages/contracts/src/organization.ts), contracts/approval.ts, event.ts, run.ts `approval_decision.approvalKind` | 작업자 추가 API |
| 정책 분기·작업자 이름 번호(조직 모든 이름을 피함, `nextWorkerName`)·사본 계획, 종류별 결정 효과(작업자 추가는 단계 유지·수정 요청 없음) | [core/worker.ts](../../packages/core/src/worker.ts), core/approval.ts `planApprovalDecision`, core/organization.ts `planApprovalPolicyChange` | [core](../../packages/core/src/worker.test.ts) |
| 정책 저장(조직 잠금·같은 값 무변경)·도구 쓰기 안 최신 정책 읽기·결정 단일 적용 | db/organizations.ts `updateApprovalPolicy`, [db/workers.ts](../../packages/db/src/workers.ts) `addWorker`(toolWrite), db/approvals.ts `decideApproval`; 초기 승인만 pending 하나(부분 unique)는 schema·migrations | 작업자 추가 API의 정책 경합·동시 결정 |
| 사용자 정책 명령·도구 HTTP(201/202)·결정 422 `decision_not_allowed` | server/app.ts `/approval-policy`, server/organizations.ts, server/tools.ts `add_worker` | 작업자 추가 API |
| 가짜 Lead의 `작업자 추가: <Role>` 부탁·작업자 추가 결정 답장 | runtime/scripted.ts `demoLeadScript`·`addWorkerScript` | 가짜 실행기 테스트, 작업자 추가 API |
| 설정 스위치(저장 중·실패·서버 값, 끌 수 없는 초기 연구 승인·최종 완료는 잠긴 스위치)·종류별 승인 상세·결정 폼·대시보드 대기 요청 | [web/settings.tsx](../../apps/web/src/settings.tsx), approvals.tsx, pages.tsx, api.ts `useUpdateApprovalPolicy` | 작업자 승인 정책 E2E(다른 탭·390px 반영 포함) |

## 일시정지·재개·중단과 실행 중단·중단하고 보내기·줄 세운 메시지

통합 검증: [제어 API](../../apps/server/test/control.test.ts), [줄 세운 메시지 API](../../apps/server/test/queued-messages.test.ts), [제어 E2E](../../apps/web/e2e/pause-resume.spec.ts)(줄 세운 메시지 목록 포함).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 일시정지 전 단계(`pausedFrom`)·끝난 단계(`closedStages`), 에이전트 `paused`, 에이전트 명령 `interrupt`(실행 중단), 취소 사유(`runCancelReasons`)·실행 시도 `cancelReason`, 전달 방식 `interrupt`(중단하고 보내기), Event `organization.paused`·`resumed`·`stopped`·`agent.paused`·`resumed`·`interrupted`(실행 중단이면 `messageId` 없음) | contracts/organization.ts, run.ts, message.ts, event.ts | 제어 API |
| 명령별 전이·no-op·`organization_closed`, 일시정지 중 결정의 재개(`planDecisionStage`), 실행 중단(`planAgentControl` `interrupt`, 취소할 실행 시도가 없으면 no-op)·`중단하고 보내기`(`planInterrupt`) 계획 | [core/control.ts](../../packages/core/src/control.ts)([단위](../../packages/core/src/control.test.ts)); 토큰 닫힘 `acceptsToolCalls`·취소 우선 종료 `planRunFinish`는 core/run.ts | 제어 API, 결과 API·작업자 추가 API의 일시정지 중 결정 |
| 조직 → 에이전트 → 실행 시도 잠금 아래 단계·일시정지·취소 요청·Event 한 transaction, 중단된 조직의 결정할 수 없는 Inbox 항목 제외 | [db/control.ts](../../packages/db/src/control.ts) `controlOrganization`·`controlAgent`, rows.ts `lockCancellableRuns`·`requestCancellation`; db/inbox.ts; 메시지와 중단은 db/runs.ts `insertOwnerMessage`; 결정의 재개는 db/approvals.ts·results.ts; schema `paused_from`·`paused`·`cancel_reason` | [DB 잠금 순서](../../packages/db/src/runs.test.ts) `control commands` |
| 일시정지한 에이전트 admission·재개 대상 목록, 취소 요청 실행 시도의 토큰 거부·종료 저장, 개수를 자르지 않는 진행 중 실행 시도(`/runs?status=running`) | db/runs.ts `claimNextRun`·`listAgentsWithPendingWakes`·`authenticateRun`·`finishRun`·`listRunningRuns`, rows.ts `lockRunningRun`·`lockRunningRunOfAgent` | 제어 API `cancellation boundary`·`running runs` |
| `중단하고 보내기` 실행 시도가 그 메시지만 받고 나머지 깨우기는 다음 실행 시도로(대기 깨우기의 `delivery`) | core/run.ts `bundleWakes`·`planRunStart`([단위](../../packages/core/src/run.test.ts)), db/runs.ts `selectWakes`·`claimNextRun` | [DB](../../packages/db/src/queued-messages.test.ts) `interrupt runs`, 줄 세운 메시지 API `interrupt order` |
| 줄 세운 메시지 고치기·거두기·지금 보내기: 거부(`not_found`·`message_delivered`·`organization_closed`·`paused`)·Event `message.edited`(고치기 전 글)·`message.withdrawn`·`message.sent_now`(+`agent.interrupted`) 계획, 새 메시지를 받지 않는 이유(끝난 조직 `organization_closed`, 줄 상한 `queue_full`·contracts `maxQueuedMessages`) | [core/queued-message.ts](../../packages/core/src/queued-message.ts) `planEdit`·`planWithdrawal`·`planSendNow`·`ownerMessageRefusal`([단위](../../packages/core/src/queued-message.test.ts)); contracts event.ts·message.ts | 줄 세운 메시지 API |
| 조직 → 에이전트 → 실행 시도 잠금 아래 고치기(`body`)·거두기(`withdrawn_at`·깨우기 삭제)·지금 보내기(`delivery`·취소 요청)와 admission 직렬화, 보내기의 조직 → 에이전트 잠금 아래 줄 수 세기(`countQueuedMessages`, 에이전트 상세 `queuedMessageCount`), 거둔 메시지를 대화·Lead 맥락·대화 목록 마지막 활동에서 뺌 | [db/queued-messages.ts](../../packages/db/src/queued-messages.ts) `editQueuedMessage`·`withdrawQueuedMessage`·`sendQueuedMessageNow`; db/runs.ts `insertOwnerMessage`·`countQueuedMessages`·`selectConversation`·`findMessage`, conversations.ts `listConversations`; schema `messages.withdrawn_at`·migration 0016 | [DB](../../packages/db/src/queued-messages.test.ts)(admission 경주·상한 포함) |
| 대화의 받은 순서·받은 시각: admission이 실행 시도마다 `messages.seq` sequence에서 뽑는 `delivered_seq`와 그 실행 시도의 시작 시각 `delivered_at`(함께 적고 함께 비우는 CHECK), 서버 재시작 재대기 때 지움, 순서 열쇠(위치·같은 위치 안의 순서·`seq`), Lead 맥락의 같은 순서, 본 위치(받은 순서의 위치), migration 0018·0019 backfill | db/runs.ts `markDelivered`·`interruptRun`·`selectConversation`·`runConversations`, conversations.ts `messagePosition`·`positionRank`·`latestFirst`·`markConversationRead`; schema `messages.delivered_seq`·`delivered_at`; contracts `deliveredAt` | [DB](../../packages/db/src/conversations.test.ts) `delivery order`·`delivery time`·`migration 0018`·`migration 0019`, 줄 세운 메시지 API `delivers the rest of the queue afterwards`, [여러 대화 API](../../apps/server/test/conversations.test.ts) `shows when the Lead received each owner message` |
| 대화 기록 쪽(keyset 커서 `before`·`after`, `after` 쪽에도 `before`, `hasMore`, 50개)과 따로 받는 줄 세운 메시지: `GET …/messages?before=|after=`, `GET …/queued-messages` | contracts message.ts `conversationPageSchema`·`conversationPageQuerySchema`; db/runs.ts `listConversationPage`·`listQueuedMessages`; server/app.ts `listChatMessages`·`listChatQueue` | [DB](../../packages/db/src/conversations.test.ts) `transcript pages`, [여러 대화 API](../../apps/server/test/conversations.test.ts) `serves the transcript in pages` |
| 줄 세운 메시지 API: `POST /api/organizations/:id/messages/:messageId/{edit,withdraw,send-now}`, 보내기의 409 `queue_full`·`organization_closed`, commit 뒤 알림·취소·촉진 | server/app.ts `refusedMessage`, conversation.ts `commandQueuedMessage`·`sendOwnerMessage` | 줄 세운 메시지 API |
| commit 뒤 실행기 취소·등록 직후 취소 재확인·재개 뒤 촉진과 그 조회 실패의 backoff 재시도 | server/dispatcher.ts `cancel`·`kickOrganization`·`#retrying`·`#execute`, [server/control.ts](../../apps/server/src/control.ts), conversation.ts, app.ts `/pause`·`/resume`·`/stop`·`/agents/:agentId/interrupt` | 제어 API. 등록 틈은 API로 재현하지 않음 |
| 조직 제어(중단 짧은 확인)·실행 중/취소 정리 중 개수, 에이전트 제어, 입력창 버튼(쉬면 보내기, 실행 중이면 실행 중단 또는 중단하고 보내기·줄 세우기, 줄이 가득 차면 비활성)·실패 시 입력 보존·끝난 조직은 입력창 대신 상태와 비활성 새 대화, 입력창 위 줄 세운 메시지 목록(`N/20`, 오른쪽 위 hover·focus·`hover: none` 아이콘 고치기·취소·지금 보내기, 그 자리 고치기 입력, 빈 입력창 ↑, 이미 전달됨 토스트), 결정 폼의 일시정지·중단 안내 | pages.tsx `OrganizationControl`, agents.tsx `AgentControl`, chat.tsx `Composer`·`QueuedMessages`·`QueuedEditor`·`QueuedAction`·`IconButton`·`closedLabel`, api.ts `useQueuedMessageCommand`·`useQueuedMessages`, approvals.tsx·results.tsx `DecisionForm`, ui.tsx `RunStatusBadge`·`PausedBadge`, activity.tsx; api.ts `useControlOrganization`·`useControlAgent`·`useRunningRuns` | 제어 E2E(다른 탭·390px 포함) |

## Heartbeat·기억·서버 재시작 복구

통합 검증: [heartbeat API](../../apps/server/test/heartbeat.test.ts), [기억 API](../../apps/server/test/memory.test.ts), [재시작 복구 API](../../apps/server/test/recovery.test.ts)(자식 서버 프로세스 SIGKILL, 단계를 바꾸는 쓰기 직후 재시작 포함), [heartbeat E2E](../../apps/web/e2e/heartbeat.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| heartbeat 설정·간격 범위·다음 예정, 깨우기 사유 `heartbeat`, Event `agent.heartbeat_changed`·`agent.heartbeat`, 실행 시도 상태 `server_restart`·`run.finished.requeuedWakeIds` | [contracts/heartbeat.ts](../../packages/contracts/src/heartbeat.ts), run.ts `agentDetailSchema`·`runEndReasonSchema`, event.ts | heartbeat API |
| 설정 변경 계획(끝난 조직 거부·같은 값 무변경·다음 예정), 지난 heartbeat 처리(쌓지 않음·downtime 합침·일시정지 중 보류) | [core/heartbeat.ts](../../packages/core/src/heartbeat.ts) `planHeartbeatChange`·`planHeartbeat` | [core](../../packages/core/src/heartbeat.test.ts) |
| 설정 저장(조직 → 에이전트 잠금), scheduler의 에이전트별 깨우기·다음 예정·Event 한 transaction, 대기 heartbeat 하나(부분 unique) | [db/heartbeat.ts](../../packages/db/src/heartbeat.ts) `updateHeartbeat`·`runDueHeartbeats`; schema `agents.heartbeat_*`·`wakes_one_pending_heartbeat_per_agent` | heartbeat API |
| Role 기본 간격 | 하네스 `role.json` `heartbeatMinutes` → server/harness.ts `loadHarnessLibrary`·`leadRoleOf` → core `planOrganizationCreation`·`planWorker`(승인 snapshot의 `heartbeatMinutes`) → db rows.ts `agentRow` | heartbeat API |
| scheduler 수명(복구 뒤 시작·종료)·주기 확인·설정 API | [server/heartbeat.ts](../../apps/server/src/heartbeat.ts) `HeartbeatScheduler`·`updateHeartbeat`, app.ts `PUT …/agents/:agentId/heartbeat`·`tickHeartbeats` | heartbeat API |
| 에이전트 상세 heartbeat 폼(고치는 동안 입력 유지·저장 실패·다음 heartbeat·일시정지 안내), 실행 시도 상세의 heartbeat 사유 | agents.tsx `HeartbeatSettings`·`WakeReasonRow`, api.ts `useUpdateHeartbeat`, activity.tsx | heartbeat E2E(다른 탭·390px·실패 시 입력 유지) |
| 기억 범위·출처를 실행 시도 신원에서 정함, Memory port | [contracts/memory.ts](../../packages/contracts/src/memory.ts), [core/memory.ts](../../packages/core/src/memory.ts) `MemoryPort`·`memoryScopeOf` | 기억 API |
| 기억 저장·최근순·글자 그대로의 회수, 같은 조직 범위·출처(복합 FK) | [db/memories.ts](../../packages/db/src/memories.ts) `dbMemory`·`writeMemory`; schema `memories` | 기억 API |
| 모든 쓰기 도구의 같은 호출 키(`Idempotency-Key`)·한 번만 남는 효과 | contracts tools.ts `idempotencyKeyHeader`, db/tool-calls.ts `toolWrite`(`ToolCall.operation`)·schema `tool_operations`, server/tools.ts `operationOf`·`callOf`, runtime/scripted.ts 키 정하기 | [같은 호출 키 API](../../apps/server/test/idempotency.test.ts), 기억 API, 재시작 복구 API |
| 서버 재시작 복구(종료·깨우기 복원·Event 한 transaction, 기존 취소 사유 보존), 정상 종료 때 같은 처리, 단계를 바꾼 쓰기 뒤 가짜 Lead의 이어 가기 | core/run.ts `planRunInterruption`, db/runs.ts `interruptRun`·`recoverInterruptedRuns`, server/dispatcher.ts `start`·`#execute`, runtime/scripted.ts `demoLeadScript` | [DB](../../packages/db/src/runs.test.ts) `run termination`, 재시작 복구 API |
| 실행 시도가 받은 깨우기 기록(재전달 뒤에도 옛 상세·개수 유지) | schema `run_wakes`·migration 0008 backfill, db/runs.ts `claimNextRun`·`selectRunWakes`·`wakeCount` | 재시작 복구 API |

## 알림 outbox·가짜 채널·Inbox

통합 검증: [알림 API](../../apps/server/test/notifications.test.ts), [Inbox E2E](../../apps/web/e2e/inbox.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 알림 종류·알림·outbox 전송 상태·가짜 채널 기록 모양, Inbox 항목 종류·정리 상태·결정 대기·필터 판정(`awaitsDecision`·`needsAttention`·`inboxFilters`)·정리 입력·Inbox 상세 경로(`inboxDetailPath`), Event `inbox_item.updated`, 채널 port `NotificationChannel` | [contracts/notification.ts](../../packages/contracts/src/notification.ts), [inbox.ts](../../packages/contracts/src/inbox.ts), event.ts | 알림 API |
| 어떤 Event가 알림인가(에이전트 대화 메시지·승인 요청·결과 제출·`failed` 실행 시도), 재시도 간격, 알림 내용(링크: Inbox 항목이 되는 사건은 Inbox 상세, Lead 메시지는 그 메시지의 대화) | [core/notification.ts](../../packages/core/src/notification.ts) `notificationOf`·`retryDelayMs`·`notificationContent` | [core](../../packages/core/src/notification.test.ts) |
| Event와 같은 transaction의 outbox 항목, claim(`SKIP LOCKED`·만료·새 token, 내용을 못 만든 항목은 그 claim의 실패로 정산)·같은 claim일 때만 정산·재시도 예정, 가짜 채널 기록(알림마다 하나) | [db/notifications.ts](../../packages/db/src/notifications.ts), rows.ts `insertEvent`; schema `notification_outbox`·`fake_channel_messages`(복합 FK)·migration 0010 | [DB](../../packages/db/src/notifications.test.ts) |
| Inbox 목록(결정한 승인 요청·결과 제출도 남음, 중단된 조직의 결정 대기 요청만 빠짐, 정리한 적 없는 결정한 항목은 읽음), 정리 상태 저장(원본 열 하나·같은 조직 복합 FK·행 잠금 아래 대입·바뀐 때만 Event, 결정 대기 항목의 보관은 원본 상태를 읽어 `archive_not_allowed`), 이 판 전 실패의 읽음 backfill | db/inbox.ts `listInbox`·`updateInboxItem`, contracts `awaitsDecision`·`canArchiveInboxItem`; schema `inbox_states`·migration 0010·0011·0012(보관 열 제약 없앰) | 알림 API `Inbox`, [contracts](../../packages/contracts/src/inbox.test.ts) |
| 전송 수명(Event 신호·시작·주기 확인·한 차례씩), outbox·전송 기록·정리 API | [server/notifications.ts](../../apps/server/src/notifications.ts) `NotificationRelay`, app.ts `GET /api/notifications`·`/api/channels/fake/*`·`PUT /api/organizations/:id/inbox/:kind/:sourceId`(결정 대기 항목의 보관은 422 `archive_not_allowed`, 다른 조직·없는 원본은 404) | 알림 API(재시도·재시작·대시보드와 같은 효과) |
| 가짜 채널 adapter(기록 저장 주입), 채널 답의 승인 결정 HTTP 전달(승인 요청 알림만·결정 입력 계약 그대로) | [runtime/fake-channel.ts](../../packages/runtime/src/fake-channel.ts) `createFakeChannel`·`replyThroughFakeChannel`; 기록 조회는 db/notifications.ts | 알림 API(대시보드와 같은 효과·거부) |
| Inbox 패널(붙음/drawer·범위·필터 개수·정리 버튼·결정 상태 배지·아바타를 눌러 체크·선택 중 체크박스·체크해 읽음), 레일·상단 바·조직 카드 진입점과 주의 수, 전역 설정 자리, 가짜 Lead `실패 연습` | [web/inbox.tsx](../../apps/web/src/inbox.tsx), shell.tsx, [global-settings.tsx](../../apps/web/src/global-settings.tsx), api.ts `useUpdateInboxItem`(한 항목 읽음·보관)·`useMarkInboxItemsRead`(체크한 항목 읽음); runtime/scripted.ts `demoLeadScript` | Inbox E2E(다른 탭·390px drawer 포함) |
| Inbox 상세 `/inbox/:orgId/:kind/:sourceId`(요약·그 자리 결정·원래 화면 링크·정리 버튼, 결정 뒤 제자리 결정 기록과 보관, 실패가 아닌 실행 시도는 없음) — 결정 영역은 원래 상세와 공유 | [web/inbox-detail.tsx](../../apps/web/src/inbox-detail.tsx) `InboxDetailPage`; inbox.tsx `InboxItemOrganize`(패널 행과 공유, 읽지 않음·보관)·체크한 항목 `모두 읽음`(api.ts `useMarkInboxItemsRead`), inbox-detail.tsx `Organize`(열면 읽음, 실패하면 알리고 다시 시도, 다시 불러온 항목이 읽음이면 안내 지움); approvals.tsx `ApprovalDecision`, results.tsx `ResultDecision`(원래 상세와 공유); 근거 [inbox-detail 조사](../research/inbox-detail-references.md) | Inbox E2E, 초기 승인·작업자 추가·결과 검토 E2E |

## 대시보드 지표·홈 개요

통합 검증: [대시보드 API](../../apps/server/test/dashboard.test.ts), [대시보드 E2E](../../apps/web/e2e/dashboard.spec.ts), [홈 E2E](../../apps/web/e2e/home.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 요약·개요 모양, 14일·최근 활동 수, 시간대 이름 모양, 성공률(완료 / (완료 + 실패), 합칠 때 분자·분모 따로)·화면의 `실행 중`(취소 정리 중 뺌) | [contracts/dashboard.ts](../../packages/contracts/src/dashboard.ts) `organizationDashboardSchema`·`overviewSchema`(조직마다 이름·목표·단계·만든 시각, `overviewAgentSchema` 에이전트, `pendingDecisions`)·`runSuccessRate`·`activeRunCount` | [계약](../../packages/contracts/src/dashboard.test.ts) |
| 조직 범위 수·날짜 bucket(시간대 자정, 0인 날, 오늘이 끝나는 `nextDayAt`)·진행 중 목록·최근 Event를 한 READ ONLY REPEATABLE READ snapshot에서, 서버가 모르는 시간대 거부(`pg_timezone_names`), 홈 개요는 조직 수와 상관없이 SQL 셋(조직별 진행 중 수·마지막 Event 시각 `lastActivityAt` / 에이전트별 진행 중 실행 시도·가장 최근 실행 시도 실패·붙잡은 작업(진행 중 작업, 없으면 그 실행 시도 깨우기의 작업)·깨우기 종류 / 끝나지 않은 조직의 기다리는 승인 요청·결과 제출)을 한 snapshot에서, 에이전트는 Lead → 들어온 시각(함께 승인된 팀도 core/approval.ts가 팀 순서대로 1ms씩 늦춤) → ID | [db/dashboard.ts](../../packages/db/src/dashboard.ts) `getOrganizationDashboard`·`getOverview`; 진행 중 목록은 db/runs.ts `listRunningRuns` | 대시보드 API(서울·UTC·뉴욕 서머타임 경계, 취소 정리 중, 다른 조직 제외, 조직별 마지막 활동, `rooms on the home`) |
| 조회 API·404·422 `invalid_time_zone`·기준 시각(주입 시계) | server/app.ts `GET /api/organizations/:id/dashboard`·`GET /api/overview` | 대시보드 API |
| 지표·14일 차트(막대 hover/focus·`숫자로 보기` 표)·실행 중인 에이전트·최근 활동, 활동 필터 주소(`?agent=`) | [web/dashboard.tsx](../../apps/web/src/dashboard.tsx), pages.tsx `OrganizationDashboard`, activity.tsx `ActivityScreen`; api.ts `useOrganizationDashboard`(`dashboardQuery`: 브라우저 시간대, 서버가 모르는 이름이면 UTC, 응답의 `asOf`→`nextDayAt`만큼 기다려 재조회)·dashboard.tsx `RunningCountText`(실행 중·취소 정리 중 문구 하나)·`useOverview` | 대시보드 E2E(다른 탭 390px 홈·다른 조직·필터·390px 넘침 없음), web dashboard-query(UTC 대체 뒤 UTC 자정·브라우저 시계 앞섬) |
| 홈 로비: 요약(주의 필요·작업 중·조직 수, 주의 필요를 누르면 Inbox)·방 순서(만든 순서 고정, 끝난 조직만 접힘)·방 폭(여섯 명까지 반 폭, `halfRoomMaxAgents`)·자리(Lead 큰 책상, 작업자 들어온 순서로 한 줄 여섯까지 `columnsOf`)·상태별 모습(`placeOf`: 끝남 → 결정 기다리는 Lead 물음표 → 일시정지 졸음 → 작업 중 → 실패 → 라운지)·작업 중 hover/focus 말풍선(ui.tsx `Tip` `tone="speech"`)·상대 시각 | [web/home.tsx](../../apps/web/src/home.tsx) `Home`·`Summary`·`Closed`, [home-model.ts](../../apps/web/src/home-model.ts) `arrangeHome`(주의 수는 contracts `needsAttention`, 레일·Inbox와 같은 판정)·`placeOf`·`decisionBubble`·`relativeTime`, [home-room.tsx](../../apps/web/src/home-room.tsx) `Room`·`Seat`·`Lounge`, [home.css](../../apps/web/src/home.css)(움직임 줄이기); api.ts `useOverview`·`useInbox`; 근거 [홈 조사](../research/home-references.md) | [배치 규칙·상대 시각](../../apps/web/src/home.test.ts), 홈 E2E(만든 순서 유지·제자리 주의·라운지·작업 말풍선 hover/focus·여섯 명 반 폭 한 줄·일곱 명 전체 폭·접힘·390px), 대시보드 E2E(390px 홈 작업 중 수) |
| Event 뒤 홈 개요 재조회(전역 key라 조직 prefix에 들지 않음), 가짜 Lead `실행 유지 연습`, 가짜 작업자의 작업 댓글 `실행 유지 연습`·`실패 연습` | live-events.ts `queryKeys.overview`; runtime/scripted.ts `demoLeadScript`·`demoWorkerScript` | 대시보드 E2E, [가짜 실행기](../../packages/runtime/src/scripted.test.ts) |

## 에이전트 조직도·이름·얼굴

통합 검증: [에이전트 이름·얼굴 API](../../apps/server/test/agents.test.ts), [조직도 E2E](../../apps/web/e2e/org-chart.spec.ts)(다른 탭·390px·움직임 줄이기).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 이름 규칙(trim·1~40자·제어 문자 거부)·얼굴 프리셋·ID에서 정한 기본 얼굴·변경 입력, Event `agent.profile_changed`, `Agent`·`AgentDetail`의 `appearance` | [contracts/agent-profile.ts](../../packages/contracts/src/agent-profile.ts) `agentNameSchema`·`agentAppearanceSchema`·`defaultAgentAppearance`·`updateAgentProfileInputSchema`, event.ts, organization.ts `agentSchema` | [core](../../packages/core/src/agent-profile.test.ts) `defaultAgentAppearance` |
| 바뀐 항목만 저장·Event, 같은 값 무변경, 같은 조직 이름 겹침(대소문자 무시, 자기 이름 대소문자 바꾸기는 허용) — 이름 바꾸기와 작업자 만들기(초기 팀 승인·작업자 추가)가 같은 규칙 | [core/agent-profile.ts](../../packages/core/src/agent-profile.ts) `agentNameKey`·`isAgentNameTaken`·`planAgentProfileChange`, core/worker.ts `nextWorkerName`(db rows.ts `agentNamesOf`로 조직 모든 이름) | core, 이름·얼굴 API의 이름 바꾼 뒤 작업자 만들기 |
| 저장(조직 → 에이전트 잠금 아래 다른 이름 읽기, 작업자 추가·승인 결정과 직렬화, unique index 위반도 `name_taken`)·다른 조직 `not_found`, 저장 얼굴이 없거나 옛 값이면 기본 얼굴 | [db/agents.ts](../../packages/db/src/agents.ts) `updateAgentProfile`, rows.ts `toAgent`·`violatesUnique`; schema `agents.appearance`(migration 0013)·`agents_organization_name_unique`(조직, `lower(name)`; migration 0017이 겹친 이름을 먼저 풂) | [DB](../../packages/db/src/organizations.test.ts) `agent names`(동시 이름 바꾸기·잠금 밖 쓰기·migration 0017) |
| API(404·409 `name_taken`·422)·commit 뒤 Event, 조직 생성 응답의 기본 얼굴 | [server/agents.ts](../../apps/server/src/agents.ts), app.ts `PATCH …/agents/:agentId`, server/organizations.ts `createOrganization` | 이름·얼굴 API(다음 실행 시도 팀 맥락의 새 이름 포함) |
| 조직도 배치(넓으면 위→아래 나무·끌기·확대·한눈에 보기, 좁으면 들여 쌓기)·카드 링크·실행 중 연결 | [web/org-chart.tsx](../../apps/web/src/org-chart.tsx)(agents.tsx `AgentsScreen`이 lazy로 불러옴), org-chart.css, api.ts `useRunningRuns` | 조직도 E2E |
| 얼굴 그리기·깜빡임·포인터 따라보기(창 listener 하나)·상태별 표정·움직임 줄이기 | [web/agent-face.tsx](../../apps/web/src/agent-face.tsx) `AgentFace`·`faceMoodOf`, agent-face.css | 조직도 E2E(따라보기·움직임 줄이기) |
| 상세 머리의 이름 바꾸기(Enter·포커스 이동 저장, Esc 취소)·얼굴 꾸미기 창, 활동 문장 | [web/agent-profile.tsx](../../apps/web/src/agent-profile.tsx) `AgentNameEditor`·`FaceCustomizer`, api.ts `useUpdateAgentProfile`, activity.tsx | 조직도 E2E |

## 개발 환경

| 작업 | 진입점·검증 |
| --- | --- |
| 서버 시작/종료·embedded/외부 DB·정적 웹 | [server/main.ts](../../apps/server/src/main.ts), server/app.ts, [db/client.ts](../../packages/db/src/client.ts); [외부 DB 시작/종료 테스트](../../apps/server/test/main.test.ts)·DB 테스트·관련 실행 확인 |
| 임시 Postgres 수명·테스트 환경 | [db/testing.ts](../../packages/db/src/testing.ts), db/client.ts, [서버 지원](../../apps/server/test/support.ts); DB·서버 테스트, 브라우저 서버는 [Playwright 설정](../../apps/web/playwright.config.ts) |
| 실행·빌드·CI·hook | [루트 scripts](../../package.json)·workspace package.json, [CI](../../.github/workflows/scaffold.yml), [pre-commit](../../.husky/pre-commit); [명령](../../README.md#개발-시작), [링크 검사](../../scripts/check-project.mjs) |

## 경계를 가로지르는 연결 경로

저장은 transaction, 알림은 commit 뒤입니다. 계약·schema·웹 응답을 함께 바꾸면 각 경계를 확인합니다.

### 조직 생성

```text
create-organization → api → POST /api/organizations(app) → server/organizations
  → harness loadHarnessLibrary·leadInstructionsOf(Lead Role·Soul)
  → core planOrganizationCreation(사용자 목표를 가진 조직·Lead·사본·생성 깨우기·Event)
  → db insertOrganizationCreation → EventHub → dispatcher.kick(Lead) → HTTP 응답 캐시
EventHub → WebSocket /api/events → live-events → live-refresh → 다른 탭 query 재조회
```

저장·알림 순서는 server/organizations, Event 재연결 복구는 useLiveEvents에서 시작합니다.

### Lead 대화·실행 시도

```text
chat → POST /api/organizations/:id/messages(기본 대화)·/conversations(새 대화)·/conversations/:id/messages(app) → conversation
  → core planOwnerMessage → db insertOwnerMessage(새 대화·메시지·깨우기·Event) → dispatcher kick
  → claimNextRun(에이전트 잠금·실행 중 재확인·대기 깨우기 고정)
  → runtime execute(신원·토큰·깨우기·맥락)
      → 토큰으로 /api/tools/* → 메시지·도구 요약 Event(send_message는 core chooseReplyConversation으로 대화를 정함)
      → emit → 공개 활동 허용 종류만 run.activity
  → finishRun → run.finished → 다음 깨우기 처리
```

미실행·중복 실행은 claim/kick, 토큰 거부는 server/tools, Role/단계 거부는 아래 gate에서 시작합니다.

### 초기 연구 승인

```text
scripted(생성 깨우기) → /api/tools/initial-approval(server/tools; 예전 조직은 먼저 /api/tools/goal)
  → gateToolCall(core checkToolCall; 거부 시 tool.refused)
  → toolWrite(조직→실행 시도 잠금·취소·단계 재확인) → 완료 기준 규칙·라이브러리 snapshot 승인 요청
결정 폼 → POST /api/organizations/:id/approvals/:approvalId/decision(app) → server/approvals
  → decideApproval(조직 잠금·pending·core planApprovalDecision·조건부 결정)
  → 작업자·사본·템플릿·단계·승인한 Lead 제안 완료 기준·Lead 깨우기·approval.decided 함께 저장
  → EventHub → kick → claim 시 사본의 bundle 버전
```

중복 결정·부분 팀 생성은 decideApproval, 승인 전 도구 노출은 toolRules에서 시작합니다.

### 작업과 작업자 실행 시도

```text
scripted(Lead) → /api/tools/tasks(server/tools) → toolWrite(조직→실행 시도 잠금·취소·단계 재확인)
  → db createTask(담당·부모 같은 조직 확인, core planTaskCreation) → 작업·담당자 깨우기·Event 함께 저장
  → EventHub → dispatcher.kick(담당자) → claimNextRun → scripted(작업자)
      → /tasks/:id/start → /artifacts → /tasks/:id/complete(core planTaskCompletion·조건부 완료)
      → 부모 담당자 또는 생성자 깨우기 → kick → 그 에이전트의 실행 시도
작업 상세 댓글 → POST /api/organizations/:id/tasks/:taskId/comments(app) → server/tasks
  → insertOwnerTaskComment(댓글·담당자 깨우기·Event) → kick(담당자)
```

깨우지 않은 할당·완료는 core/task.ts의 대상 선택, 다른 조직 참조는 db/tasks.ts의 확인과 복합 FK에서 시작합니다.

### 연구 지도 편집

```text
scripted(작업자) → /api/tools/research-nodes·research-links·tasks/:id/research-node(server/tools)
  → writeResearchMap(toolWrite: 조직→실행 시도 잠금·취소·단계 재확인) → 최신 지도 읽기 → core plan*
  → 변경·편집 기록·Event 함께 저장(에이전트 편집은 아무도 깨우지 않음)
지도 패널 폼 → /api/organizations/:id/research-*(app) → server/research-map
  → editResearchMap(조직 잠금·편집 단계·최신 지도·core plan*) → 변경·편집 기록·Lead 깨우기·Event
  → EventHub → kick(Lead) → 지도·노드 상세 재조회
```

거부 코드는 core/research-map.ts, 순환·동시 편집은 db/research-map.ts의 잠금 뒤 `loadMap`에서 시작합니다.

### Role·Soul·Skill 사본 편집

```text
사본 편집기(base revision·draft) → PUT /api/organizations/:id/agents/:agentId/instructions/:copyId(app) → server/instructions
  → editInstructionCopy(조직 잠금·조직/에이전트/사본 범위·core planInstructionEdit)
  → 사본·revision·Lead 깨우기·instruction_copy.edited 함께 저장 → EventHub → kick(Lead)
  → 다른 탭: 조직 Event → 사본·revision 목록 재조회(편집 중 draft는 그대로)
다음 claimNextRun(조직 FOR SHARE 뒤 사본 읽기) → 내용 bundle 버전 → 이전 실행 시도와 다르면 이전 세션 없음
```

충돌·종료 거부는 core/harness.ts `planInstructionEdit`, 다른 조직 404는 db/harness.ts의 범위 조건과 복합 FK에서 시작합니다.

### 결과 제출과 최종 완료

```text
scripted(Lead) → /api/tools/results(server/tools) → submitResult(toolWrite: 조직→실행 시도 잠금·취소·단계 재확인)
  → 같은 조직 산출물 확인 → core planResultSubmission → 제출·근거·결과 검토 중·result.submitted 함께 저장
결정 폼 → POST /api/organizations/:id/results/:submissionId/decision(app) → server/results
  → decideResult(조직 잠금·pending·core planResultDecision·조건부 결정)
  → 단계·(수정 요청이면) Lead 깨우기·result.decided 함께 저장 → EventHub → kick(Lead)
최종 완료 뒤 깨우기 → claimNextRun(조직 FOR SHARE·admitsRuns) → 실행 시도 없음, 깨우기는 남음
```

완료 뒤 실행 시도가 생기면 `admitsRuns`와 claim의 잠금 순서, 중복 결정은 decideResult의 pending 조건에서 시작합니다.

### 일시정지·재개·중단

```text
대시보드·에이전트 상세 → POST /api/organizations/:id/{pause,resume,stop}·/agents/:agentId/{pause,resume}(app) → server/control
  → controlOrganization·controlAgent(조직 잠금 → 에이전트 → 진행 중 실행 시도 FOR UPDATE, core plan*)
  → 단계·pausedFrom / paused, 실행 시도 cancel_reason, Event 함께 저장
  → EventHub → dispatcher.cancel(commit 뒤 abort) → 실행기 정리 → finishRun(cancelled) → 재개면 kickOrganization·kick
Lead 대화(중단하고 보내기) → POST /messages {delivery: interrupt} → insertOwnerMessage(조직 잠금·메시지·깨우기·두 Event·취소 요청)
  → dispatcher.cancel → 취소된 실행 시도 종료 뒤 claimNextRun이 그 메시지 깨우기만 다음 실행 시도에 묶음(core bundleWakes)
  → 그 실행 시도 종료 뒤 claimNextRun이 남은 줄 세운 메시지·다른 깨우기를 합쳐 묶음
줄 세운 메시지(고치기 / 취소·빈 입력창 ↑ / 지금 보내기) → POST /messages/:messageId/{edit,withdraw,send-now} → commandQueuedMessage
  → withdrawQueuedMessage·sendQueuedMessageNow(조직 → 에이전트 → 실행 시도 잠금, core planWithdrawal·planSendNow)
  → 거두기: withdrawn_at·깨우기 삭제·message.withdrawn / 지금 보내기: delivery interrupt·취소 요청·message.sent_now·agent.interrupted
  → EventHub → (지금 보내기) dispatcher.cancel·kick. 실행 시도가 먼저 받았으면 409 message_delivered
Lead 대화(실행 중단) → POST /agents/:agentId/interrupt → controlAgent(조직 → 에이전트 → 취소 요청 없는 진행 중 실행 시도, 없으면 no-op)
  → 취소 요청·agent.interrupted(messageId 없음) → dispatcher.cancel. 일시정지가 아니므로 남은 깨우기는 정리 뒤 평소처럼 처리
```

취소 뒤 늦은 도구 쓰기는 `lockRunningRun`의 `cancelReason`, 재개 뒤 실행이 없으면 `listAgentsWithPendingWakes`의 에이전트 `paused`·단계 필터에서 시작합니다.

### Heartbeat와 서버 재시작

```text
에이전트 상세 폼 → PUT /api/organizations/:id/agents/:agentId/heartbeat(app) → server/heartbeat
  → updateHeartbeat(조직 → 에이전트 잠금, core planHeartbeatChange) → 설정·다음 예정·Event → EventHub
HeartbeatScheduler.tick(주입 시계) → runDueHeartbeats(에이전트마다: 조직 FOR SHARE → 에이전트, core planHeartbeat)
  → heartbeat 깨우기·다음 예정·agent.heartbeat → EventHub → dispatcher.kick → claimNextRun(다른 깨우기와 합침)
서버 시작 → dispatcher.start → recoverInterruptedRuns → interruptRun(실행 시도마다 core planRunInterruption)
  → server_restart·깨우기 복원·run.finished → 대기 깨우기 kick → scheduler 시작
```

중복 heartbeat는 `wakes_one_pending_heartbeat_per_agent`와 planHeartbeat의 대기 확인, 재전달된 입력의 옛 상세는 `run_wakes`, 되풀이된 쓰기는 `toolWrite`의 호출 키 확인에서 시작합니다.

### 에이전트 이름·얼굴

```text
상세 머리(이름 입력·얼굴 꾸미기 창) → PATCH /api/organizations/:id/agents/:agentId(app) → server/agents
  → updateAgentProfile(조직 → 에이전트 잠금·같은 조직 다른 이름, core planAgentProfileChange) → 이름·appearance·Event
  → EventHub → 다른 탭 조직 재조회(조직도·사이드바·이동 경로) / 다음 실행 시도의 runContext.team
```

이름 겹침은 `planAgentProfileChange`의 `otherNames`, 얼굴이 기본으로 돌아가는 증상은 rows.ts `toAgent`의 프리셋 검사에서 시작합니다.

### 작업자 추가와 승인 정책

```text
설정 스위치 → PUT /api/organizations/:id/approval-policy(app) → server/organizations
  → updateApprovalPolicy(조직 잠금·core planApprovalPolicyChange) → 정책·Event → EventHub → 다른 탭 재조회
scripted(Lead) → /api/tools/workers(server/tools) → addWorker(toolWrite: 조직→실행 시도 잠금·취소·단계 재확인)
  → core buildAddWorkerProposal(라이브러리 snapshot) → planAddWorker(잠금 아래 최신 정책)
  → 꺼짐: 작업자·사본·worker.added(201) / 켜짐: 승인 요청·approval.requested(202, 단계 유지)
결정 폼 → decideApproval(조직 잠금·pending·종류별 결정) → 작업자·사본(승인만)·Lead 깨우기·approval.decided
```

정책 경합은 addWorker의 잠금 아래 정책 읽기, 승인 전 작업자 생성은 planAddWorker의 분기에서 시작합니다.

### 알림 outbox·가짜 채널

```text
사건 기록(toolWrite·finishRun 등) → insertEvent → core notificationOf → notification_outbox(같은 transaction)
commit 뒤 EventHub → NotificationRelay.kick(시작·5초 주기도) → claimNotifications(SKIP LOCKED·만료·새 token)
  → channel.deliver(transaction 밖; 가짜 채널은 fake_channel_messages에 알림마다 하나)
  → settleNotification(같은 claim일 때만: 보냄 / 실패면 retryDelayMs 뒤 재시도)
가짜 채널 답 → POST /api/channels/fake/messages/:id/reply → 기록의 조직·승인 요청으로
  POST /api/organizations/:id/approvals/:approvalId/decision(대시보드와 같은 명령) → 응답 그대로
Inbox 패널 정리 → PUT /api/organizations/:id/inbox/:kind/:sourceId → updateInboxItem → inbox_item.updated → 다른 탭 재조회
```

빠진 알림은 `notificationOf`와 그 사건의 `insertEvent` 호출, 중복 전송은 claim 만료와 채널의 알림 ID 중복 거르기, 정리가 결정을 바꾸는 증상은 `updateInboxItem`에서 시작합니다.

## 지도 갱신

진입점·책임·테스트 또는 구현 범위가 바뀌면 같은 PR에서 해당 행·경로를 갱신합니다. 실제 테스트 범위와 미검증을 구분합니다.
큰 영역이 독립 탐색을 요구할 때만 별도 지도로 나누고 연결하며, 미구현 영역의 빈 문서는 만들지 않습니다.
