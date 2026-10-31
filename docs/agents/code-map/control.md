# 일시정지·재개·중단과 실행 중단·중단하고 보내기·줄 세운 메시지

통합 검증: [제어 API](../../../apps/server/test/control.test.ts), [줄 세운 메시지 API](../../../apps/server/test/queued-messages.test.ts), [제어 E2E](../../../apps/web/e2e/pause-resume.spec.ts)(줄 세운 메시지 목록 포함).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 일시정지 전 단계(`pausedFrom`)·끝난 단계(`closedStages`), 에이전트 `paused`, 에이전트 명령 `interrupt`(실행 중단), 취소 사유(`runCancelReasons`)·실행 시도 `cancelReason`, 전달 방식 `interrupt`(중단하고 보내기), Event `organization.paused`·`resumed`·`stopped`·`agent.paused`·`resumed`·`interrupted`(실행 중단이면 `messageId` 없음) | contracts/organization.ts, run.ts, message.ts, event.ts | 제어 API |
| 명령별 전이·no-op·`organization_closed`, 일시정지 중 결정의 재개(`planDecisionStage`), 실행 중단(`planAgentControl` `interrupt`, 취소할 실행 시도가 없으면 no-op)·`중단하고 보내기`(`planInterrupt`: 정리 중인 실행 시도에 합류, 조직·Lead 일시정지로 붙잡힌 메시지는 중단할 실행 시도 없음) 계획 | [core/control.ts](../../../packages/core/src/control.ts)([단위](../../../packages/core/src/control.test.ts)); 토큰 닫힘 `acceptsToolCalls`·취소 우선 종료 `planRunFinish`는 core/run.ts | 제어 API, 결과 API·작업자 추가 API의 일시정지 중 결정 |
| 조직 → 에이전트 → 실행 시도 잠금 아래 단계·일시정지·취소 요청·Event 한 transaction, 중단된 조직의 결정할 수 없는 Inbox 항목 제외 | [db/control.ts](../../../packages/db/src/control.ts) `controlOrganization`·`controlAgent`, rows.ts `lockCancellableRuns`·`requestCancellation`; db/inbox.ts; 메시지와 중단은 db/conversations.ts `insertOwnerMessage`; 결정의 재개는 db/approvals.ts·results.ts; schema `paused_from`·`paused`·`cancel_reason` | [DB 잠금 순서](../../../packages/db/src/runs.test.ts) `control commands` |
| 일시정지한 에이전트 admission·재개 대상 목록, 취소 요청 실행 시도의 토큰 거부·종료 저장, 개수를 자르지 않는 진행 중 실행 시도(`/runs?status=running`) | db/runs.ts `claimNextRun`·`listAgentsWithPendingWakes`·`authenticateRun`·`finishRun`, run-views.ts `listRunningRuns`, rows.ts `lockRunningRun`·`lockRunningRunOfAgent` | 제어 API `cancellation boundary`·`running runs` |
| `중단하고 보내기` 실행 시도가 그 메시지만 받고 나머지 깨우기는 다음 실행 시도로(대기 깨우기의 `delivery`) | core/run.ts `bundleWakes`·`planRunStart`([단위](../../../packages/core/src/run.test.ts)), db/run-reads.ts `selectWakes`, runs.ts `claimNextRun` | [DB](../../../packages/db/src/queued-messages.test.ts) `interrupt runs`, 줄 세운 메시지 API `interrupt order` |
| `실행 중 끼워 넣기`: 넣을 실행 시도(취소 요청 없음·지원하는 연결·일시정지 아님, core `steerTarget`), 메시지·깨우기 저장 뒤 commit 밖에서 adapter에 넣기, 받음은 그 실행 시도에 묶고 거절은 `next_run`·`message.steered`, 넣는 동안 admission·줄 목록·줄 명령에서 빠짐(`notSteering`), 서버 시작 때 줄로 되돌림 | core/control.ts `steerTarget`, queued-message.ts; db/conversations.ts `insertOwnerMessage({ steerable })`·`settleSteer`·`recoverInterruptedSteers`, run-reads.ts `notSteering`; server/app.ts `sendOwnerMessage`, dispatcher.ts `steer` | [DB](../../../packages/db/src/queued-messages.test.ts) `steering into the running run`, [넓힌 계약 API](../../../apps/server/test/provider-contract.test.ts) |
| 입력창 버튼·줄 세운 메시지 버튼이 보이는가와 서버가 받는가(행동마다, 받지 않는 이유 `organization_closed`·`queue_full`, 메시지를 붙잡는 일시정지, 일시정지 중 `지금 보내기`), 새 메시지를 받지 않는 이유(`newMessageRefusal`, 줄 상한 `maxQueuedMessages`)·줄 세운 메시지 명령을 받지 않는 이유(`queuedMessageRefusal`). 웹 입력창과 core 거부가 함께 씀 | [contracts/owner-actions.ts](../../../packages/contracts/src/owner-actions.ts) `ownerActions` | [단위](../../../packages/contracts/src/owner-actions.test.ts)(보이는 버튼은 서버가 받음) |
| 줄 세운 메시지 고치기·거두기·지금 보내기: 메시지 하나의 거부(`not_found`·`message_delivered`)와 contracts 판정의 거부·Event `message.edited`(고치기 전 글)·`message.withdrawn`·`message.sent_now`(+`agent.interrupted`) 계획 | [core/queued-message.ts](../../../packages/core/src/queued-message.ts) `planEdit`·`planWithdrawal`·`planSendNow`([단위](../../../packages/core/src/queued-message.test.ts)); contracts event.ts·message.ts | 줄 세운 메시지 API |
| 조직 → 에이전트 → 실행 시도 잠금 아래 고치기(`body`)·거두기(`withdrawn_at`·깨우기 삭제)·지금 보내기(`delivery`·취소 요청)와 admission 직렬화, 보내기의 조직 → 에이전트 잠금 아래 줄 수 세기(`countQueuedMessages`, 에이전트 상세 `queuedMessageCount`), 거둔 메시지를 대화·Lead 맥락·대화 목록 마지막 활동에서 뺌 | [db/queued-messages.ts](../../../packages/db/src/queued-messages.ts) `editQueuedMessage`·`withdrawQueuedMessage`·`sendQueuedMessageNow`(지금 상태는 conversations.ts `readMessage`); db/conversations.ts `insertOwnerMessage`·`countQueuedMessages`·`selectConversation`·`findMessage`·`listConversations`; schema `messages.withdrawn_at`·migration 0016 | [DB](../../../packages/db/src/queued-messages.test.ts)(admission 경주·상한 포함) |
| 대화의 받은 순서·받은 시각: admission이 실행 시도마다 `messages.seq` sequence에서 뽑는 `delivered_seq`와 그 실행 시도의 시작 시각 `delivered_at`(함께 적고 함께 비우는 CHECK), 서버 재시작 재대기 때 지움, 순서 열쇠(위치·같은 위치 안의 순서·`seq`), Lead 맥락의 같은 순서, 본 위치(받은 순서의 위치), migration 0018·0019 backfill | [db/conversations.ts](../../../packages/db/src/conversations.ts) `markDelivered`·`markRequeued`·`selectConversation`·`runConversations`·`messagePosition`·`positionRank`·`markConversationRead`(순서 규칙은 이 파일 밖에 없음), 부르는 쪽은 db/runs.ts `claimNextRun`·`interruptRun`; schema `messages.delivered_seq`·`delivered_at`; contracts `deliveredAt` | [DB](../../../packages/db/src/conversations.test.ts) `delivery order`·`delivery time`·`migration 0018`·`migration 0019`, 줄 세운 메시지 API `delivers the rest of the queue afterwards`, [여러 대화 API](../../../apps/server/test/conversations.test.ts) `shows when the Lead received each owner message` |
| 대화 쪽(keyset 커서 `before`·`after`, `after` 쪽에도 `before`, `hasMore`, 50개)과 따로 받는 줄 세운 메시지: `GET …/messages?before=|after=`, `GET …/queued-messages` | contracts message.ts `conversationPageSchema`·`conversationPageQuerySchema`; db/conversations.ts `listConversationPage`(커서 형식)·`listQueuedMessages`; server/app.ts `listChatMessages`·`listChatQueue` | [DB](../../../packages/db/src/conversations.test.ts) `transcript pages`, [여러 대화 API](../../../apps/server/test/conversations.test.ts) `serves the transcript in pages` |
| 줄 세운 메시지 API: `POST /api/organizations/:id/messages/:messageId/{edit,withdraw,send-now}`, 보내기의 409 `queue_full`·`organization_closed`, commit 뒤 알림·취소·촉진 | server/app.ts `sendOwnerMessage`·`/messages/:messageId/*`, db/queued-messages.ts | 줄 세운 메시지 API |
| commit 뒤 프로바이더 취소·등록 직후 취소 재확인·재개 뒤 촉진과 그 조회 실패의 backoff 재시도 | server/dispatcher.ts `cancel`·`kickOrganization`·`#retrying`·`#execute`, db/control.ts, app.ts `/pause`·`/resume`·`/stop`·`/agents/:agentId/interrupt` | 제어 API. 등록 틈은 API로 재현하지 않음 |
| 조직 제어(중단 짧은 확인)·실행 중/취소 정리 중 개수, 에이전트 제어, 입력창 버튼(쉬면 보내기, 실행 중이면 실행 중단 또는 중단하고 보내기·줄 세우기, 그 실행 시도의 연결이 지원하면 실행 중 끼워 넣기(`runSteerable`), 줄이 가득 차면 비활성)·실패 시 입력 보존·끝난 조직은 입력창 대신 상태와 비활성 새 대화, 입력창 위 줄 세운 메시지 목록(`N/20`, 오른쪽 위 hover·focus·`hover: none` 아이콘 고치기·취소·지금 보내기, 그 자리 고치기 입력, 빈 입력창 ↑, 이미 전달됨 토스트), 결정 폼의 일시정지·중단 안내 | pages.tsx `OrganizationControl`, agents.tsx `AgentControl`, chat.tsx `Composer`(contracts `ownerActions`)·`QueuedMessages`·`QueuedEditor`·`QueuedAction`·`IconButton`·`closedLabel`, api.ts `useQueuedMessageCommand`·`useQueuedMessages`, approvals.tsx·results.tsx `DecisionForm`, ui.tsx `RunStatusBadge`·`PausedBadge`, activity.tsx; api.ts `useControlOrganization`·`useControlAgent`·`useRunningRuns` | 제어 E2E(다른 탭·390px 포함) |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
대시보드·에이전트 상세 → POST /api/organizations/:id/{pause,resume,stop}·/agents/:agentId/{pause,resume}(app)
  → controlOrganization·controlAgent(조직 잠금 → 에이전트 → 진행 중 실행 시도 FOR UPDATE, core plan*)
  → 단계·pausedFrom / paused, 실행 시도 cancel_reason, Event 함께 저장
  → EventHub → dispatcher.cancel(commit 뒤 abort) → 프로바이더 정리 → finishRun(cancelled) → 재개면 kickOrganization·kick
Lead 대화(중단하고 보내기) → POST /messages {delivery: interrupt} → insertOwnerMessage(조직 잠금·메시지·깨우기·두 Event·취소 요청)
  → dispatcher.cancel → 취소된 실행 시도 종료 뒤 claimNextRun이 그 메시지 깨우기만 다음 실행 시도에 묶음(core bundleWakes)
  → 그 실행 시도 종료 뒤 claimNextRun이 남은 줄 세운 메시지·다른 깨우기를 합쳐 묶음
줄 세운 메시지(고치기 / 취소·빈 입력창 ↑ / 지금 보내기) → POST /messages/:messageId/{edit,withdraw,send-now}(app)
  → withdrawQueuedMessage·sendQueuedMessageNow(조직 → 에이전트 → 실행 시도 잠금, core planWithdrawal·planSendNow)
  → 거두기: withdrawn_at·깨우기 삭제·message.withdrawn / 지금 보내기: delivery interrupt·취소 요청·message.sent_now·agent.interrupted
  → EventHub → (지금 보내기) dispatcher.cancel·kick. 실행 시도가 먼저 받았으면 409 message_delivered
Lead 대화(실행 중단) → POST /agents/:agentId/interrupt → controlAgent(조직 → 에이전트 → 취소 요청 없는 진행 중 실행 시도, 없으면 no-op)
  → 취소 요청·agent.interrupted(messageId 없음) → dispatcher.cancel. 일시정지가 아니므로 남은 깨우기는 정리 뒤 평소처럼 처리
```

취소 뒤 늦은 도구 쓰기는 `lockRunningRun`의 `cancelReason`, 재개 뒤 실행이 없으면 `listAgentsWithPendingWakes`의 에이전트 `paused`·단계 필터에서 시작합니다.
