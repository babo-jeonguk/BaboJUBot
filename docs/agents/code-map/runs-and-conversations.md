# 실행 시도·조직 도구·대화

통합 검증: [실행 API](../../../apps/server/test/runs.test.ts), [여러 대화 API](../../../apps/server/test/conversations.test.ts), [Lead 대화 E2E](../../../apps/web/e2e/lead-chat.spec.ts), [여러 대화 E2E](../../../apps/web/e2e/lead-conversations.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 실행 요청·공개 활동·종료·취소, 도구·메시지 | [contracts/run.ts](../../../packages/contracts/src/run.ts), [tools.ts](../../../packages/contracts/src/tools.ts), [message.ts](../../../packages/contracts/src/message.ts), event.ts | [계약](../../../packages/contracts/src/run.test.ts) |
| 조직 도구 한 줄(이름·영어 설명·입력·출력·HTTP 방식·열린 Role·단계·사용자에게 보이는 칸), 입력을 경로 변수와 본문/query로 나누기 | contracts tools.ts `orgTools`·`splitOrgToolInput`; 판정·지금 쓸 수 있는 도구는 core/approval.ts `checkToolCall`·`availableOrgTools` | [목록](../../../packages/contracts/src/tools.test.ts), [core](../../../packages/core/src/approval.test.ts) |
| 메시지·깨우기·bundle·세션 이어 가기·토큰 규칙 | [core/run.ts](../../../packages/core/src/run.ts) | 실행 API; API로 어려운 bundle 버전별 세션은 [core](../../../packages/core/src/run.test.ts) |
| 대기열·에이전트당 실행 하나·bundle 고정·종료/쓰기 직렬화 | [db/runs.ts](../../../packages/db/src/runs.ts) `claimNextRun`·`finishRun`, conversations.ts `insertAgentMessage`; schema·migrations | [DB admission·동시성](../../../packages/db/src/runs.test.ts) |
| 깨우기·DB admission/종료 저장 재시도·프로바이더 호출·활동 필터·종료 취소 | [server/dispatcher.ts](../../../apps/server/src/dispatcher.ts) `RunDispatcher`, [run-token.ts](../../../apps/server/src/run-token.ts) | 실행 API |
| 실행 시도 요청 한 장 조립(admission 결과 + 실행 맥락 + 토큰·도구 주소 + workspace) | [server/run-request.ts](../../../apps/server/src/run-request.ts) `createRunRequestAssembler`(app.ts가 도구 주소와 함께 만들어 dispatcher에 넘김), db/runs.ts `loadRunContext` | 실행 API |
| HTTP 토큰 인증·교차 조직 404·종료 토큰 거부, 목록에서 거는 경로·공통 입력 검사·도구별 처리 함수 표 | [server/tools.ts](../../../apps/server/src/tools.ts) `orgToolsRouter`, db/runs.ts `authenticateRun` | 실행 API `organization tools`, [경로·목록 대조](../../../apps/server/src/tools.test.ts) |
| 대화·실행 시도·에이전트 조회 | server/app.ts, [db/run-views.ts](../../../packages/db/src/run-views.ts) `listRuns`·`listRunningRuns`·`findRunDetail`·`findAgentDetail`(admission·화면이 함께 쓰는 깨우기 사유·진행 중 여부·지침 읽기는 DB 안에서만 쓰는 run-reads.ts) | 실행 API |
| 여러 대화: 대화·목록 모양, 새 대화 시작 입력·결과, 본 위치, 답장의 `conversationId` | contracts message.ts `conversationSchema`·`conversationSummarySchema`·`startConversationResultSchema`·`sendAgentMessageInputSchema`, run.ts 깨우기 `owner_message.conversationId`·맥락 `conversations`, event.ts `message.created.conversationId` | [계약](../../../packages/contracts/src/run.test.ts) |
| 새 대화 제목·기본 대화(조직 생성 때), 답장이 갈 대화(고른 대화 → 받은 사용자 메시지의 대화 → 기본 대화, 여러 대화면 골라야 함) | core run.ts `planOwnerMessage`(`new`면 대화도 계획)·`conversationTitle`·`chooseReplyConversation`·`planDefaultConversation`, organization.ts `planOrganizationCreation` | [core](../../../packages/core/src/run.test.ts) |
| 대화 저장(새 대화는 첫 메시지와 한 transaction)·목록 순서·읽지 않음·본 위치·실행 시도 맥락의 대화, 다른 조직 대화 404, migration 0014 backfill | [db/conversations.ts](../../../packages/db/src/conversations.ts) `insertOwnerMessage`·`insertAgentMessage`·`runConversations`, db/runs.ts `loadRunContext`; schema `conversations`·`messages.conversation_id`(복합 FK)·migration 0014 | [DB](../../../packages/db/src/conversations.test.ts) |
| 대화 API: `GET/POST /api/organizations/:id/conversations`, `GET/POST …/conversations/:conversationId/messages`, `PUT …/read`, 기본 대화는 `/messages`로도 | server/app.ts `findChat`·`sendOwnerMessage`; 도구 오류는 problems.ts `conversation_required`(422) | 여러 대화 API |
| 가짜 프로바이더·도구 client·테스트 gate | [runtime/scripted.ts](../../../packages/runtime/src/scripted.ts), [tools-client.ts](../../../packages/runtime/src/tools-client.ts), [testing.ts](../../../packages/runtime/src/testing.ts) | [가짜 프로바이더](../../../packages/runtime/src/scripted.test.ts) |
| 프로바이더 계약 공통 검사(취소 뒤 `cancelled`·돌아온 뒤 활동 없음·활동/종료 형식·토큰 비노출)와 가짜 도구 HTTP 서버 | [runtime/runtime-contract.ts](../../../packages/runtime/src/runtime-contract.ts) `describeRuntimeContract`(`@babojubot/runtime/runtime-contract`) | [가짜 프로바이더 계약](../../../packages/runtime/src/scripted.contract.test.ts) |
| README 데모 시나리오(목표를 적어 생성→초기 승인→작업 결과→일시정지·재개·작업자 추가 승인→결과 제출→최종 완료)가 이어지지 않음 | runtime/scripted.ts `demoLeadScript`·`demoWorkerScript`, 각 단계의 화면 | [데모 흐름 E2E](../../../apps/web/e2e/demo-flow.spec.ts)(주요 사용자 행동을 모두 화면으로 한 조직에서). 직접 거부·조직 격리·heartbeat due·복구는 각 절의 API 검증 |
| 대화·활동·실행 시도 상세·에이전트 화면(조직도는 [에이전트 조직도·이름·얼굴](agent-chart.md)) | [chat.tsx](../../../apps/web/src/chat.tsx), [activity.tsx](../../../apps/web/src/activity.tsx), [agents.tsx](../../../apps/web/src/agents.tsx); api.ts query key | Lead 대화 E2E |
| 대화 목록(왼쪽·390px 시트)·새 대화(`/chat/new`, 첫 보내기 뒤 그 대화 주소로)·읽지 않음 점(화면이 보일 때 본 위치 저장)·`/chat/:conversationId` | chat.tsx `LeadChat`·`ConversationList`·`Thread`·`DraftThread`, main.tsx route, pages.tsx `OrganizationScreen`; api.ts `useConversations`·`useSendMessage`·`useStartConversation`·`useMarkConversationRead`, transcript-window.ts `useConversation` | 여러 대화 E2E(다른 탭·390px 포함) |
| 대화 화면(대화에 놓인 메시지): 최근 쪽부터 그리고 위로 올리면(맨 위 sentinel 300px, 한 번에 하나, 받은 뒤 새 스크롤 필요) 또는 `이전 메시지 보기`로 오래된 쪽을 붙임, 보던 맨 위 메시지 자리 되돌리기(`overflow-anchor: none`), 64px 안에서만 따라 내려가기(따라가는 동안 대화 영역·내용 크기가 바뀌어도 맨 아래 유지, `ResizeObserver`)와 그 밖의 `맨 아래로` 버튼, 새 메시지만 이어 받기(Event의 `meta.liveRefresh`만 부름, 기다리는 사이 가장 새 쪽이 바뀌었으면 그 응답을 버리고 다시 받음, 받은 쪽마다 따로 둠), 따라가는 동안 100개 넘으면 오래된 쪽 덜어 내기, 사용자 말풍선 시각(`deliveredAt ?? createdAt`) | chat.tsx `useTranscriptScroll`(스크롤 위치·크기 변화·맨 위 sentinel을 판단에 넘기고 결과를 DOM에 적용)·`Transcript`(그리기)·`MessageList`(`aria-busy`)·`MessageBubble`, [transcript-window.ts](../../../apps/web/src/transcript-window.ts) `useConversation`(useInfiniteQuery)·`catchUpConversation`·`appendArrivals`·`trimTranscript`, 목록이 바뀐 뒤의 스크롤(보던 자리·맨 아래에 붙기·부드럽게 내려가기·제자리)과 새 메시지 수 `afterListChange`, 덜어 내기 조건 `shouldTrim`, live-refresh.ts | [긴 대화 E2E](../../../apps/web/e2e/lead-chat-history.spec.ts), [창·스크롤 판단 단위](../../../apps/web/src/transcript-window.test.ts), [live refresh 단위](../../../apps/web/src/live-refresh.test.ts) |
| 가짜 Lead의 답장 대화(사용자 메시지는 그 대화, 그 밖은 기본 대화, 대화마다 답장) | runtime/scripted.ts `leadReplyScript`·`replyConversationOf`·`defaultConversationOf`, tools-client.ts `sendMessage` | 가짜 프로바이더 테스트 |
| 후속 실제 adapter | [runtime/index.ts](../../../packages/runtime/src/index.ts)에 추가, 요청 `instructions` 사본을 프로바이더에 주입 | 프로바이더 계약 공통 검사에 장면 두 개로 등록. 자격 증명·비용이 드는 실행 방식은 판 2에서 정함 |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
chat → POST /api/organizations/:id/messages(기본 대화)·/conversations(새 대화)·/conversations/:id/messages(app) `sendOwnerMessage`
  → core planOwnerMessage → db insertOwnerMessage(새 대화·메시지·깨우기·Event) → dispatcher kick
  → claimNextRun(에이전트 잠금·실행 중 재확인·대기 깨우기 고정)
  → 요청 조립(createRunRequestAssembler: 신원·맥락·토큰·도구 주소·workspace) → runtime execute
      → 토큰으로 /api/tools/* → 메시지·도구 요약 Event(send_message는 core chooseReplyConversation으로 대화를 정함)
      → emit → 공개 활동 허용 종류만 run.activity
  → finishRun → run.finished → 다음 깨우기 처리
```

미실행·중복 실행은 claim/kick, 토큰 거부는 server/tools, Role/단계 거부는 [초기 연구 승인](initial-approval.md#연결-경로)의 `gateToolCall`에서 시작합니다.
