# 알림 outbox·가짜 채널·Inbox

통합 검증: [알림 API](../../../apps/server/test/notifications.test.ts), [Inbox E2E](../../../apps/web/e2e/inbox.spec.ts).

| 작업·증상 | 진입점·계약 | 추가 검증·범위 |
| --- | --- | --- |
| 알림 종류·알림·outbox 전송 상태·가짜 채널 기록 모양, Inbox 항목 종류·정리 상태·결정 대기·필터 판정(`awaitsDecision`·`needsAttention`·`inboxFilters`)·정리 입력·Inbox 상세 경로(`inboxDetailPath`), Event `inbox_item.updated`, 채널 port `NotificationChannel`(보내기·`listen`·`close`)·받는 입구 `ChannelInlet`·답 모양 `ChannelReply` | [contracts/notification.ts](../../../packages/contracts/src/notification.ts), [inbox.ts](../../../packages/contracts/src/inbox.ts), event.ts | 알림 API |
| 어떤 Event가 알림인가(에이전트 대화 메시지·승인 요청·결과 제출·`failed` 실행 시도), 재시도 간격, 알림 내용(링크: Inbox 항목이 되는 사건은 Inbox 상세, Lead 메시지는 그 메시지의 대화) | [core/notification.ts](../../../packages/core/src/notification.ts) `notificationOf`·`retryDelayMs`·`notificationContent` | [core](../../../packages/core/src/notification.test.ts) |
| Event와 같은 transaction의 outbox 항목, claim(`SKIP LOCKED`·만료·새 token, 내용을 못 만든 항목은 그 claim의 실패로 정산)·같은 claim일 때만 정산·재시도 예정, 가짜 채널 기록(알림마다 하나, 기록 ID가 앱 메시지 번호), 전송 성공과 함께 남기는 앱 메시지 → 알림 연결(채널 이름 + 앱 메시지 번호)·답한 알림 찾기 | [db/notifications.ts](../../../packages/db/src/notifications.ts) `settleNotification`·`findRepliedNotification`, rows.ts `insertEvent`; schema `notification_outbox`·`fake_channel_messages`·`channel_messages`(복합 FK)·migration 0010·0020 | [DB](../../../packages/db/src/notifications.test.ts) |
| Inbox 목록(결정한 승인 요청·결과 제출도 남음, 중단된 조직의 결정 대기 요청만 빠짐, 정리한 적 없는 결정한 항목은 읽음), 정리 상태 저장(원본 열 하나·같은 조직 복합 FK·행 잠금 아래 대입·바뀐 때만 Event, 결정 대기 항목의 보관은 원본 상태를 읽어 `archive_not_allowed`), 이 판 전 실패의 읽음 backfill | db/inbox.ts `listInbox`·`updateInboxItem`, contracts `awaitsDecision`·`canArchiveInboxItem`; schema `inbox_states`·migration 0010·0011·0012(보관 열 제약 없앰) | 알림 API `Inbox`, [contracts](../../../packages/contracts/src/inbox.test.ts) |
| 전송 수명(Event 신호·시작·주기 확인·한 차례씩), outbox·전송 기록·정리 API | [server/notifications.ts](../../../apps/server/src/notifications.ts) `NotificationRelay`, app.ts `GET /api/notifications`·채널 경로 `/api/channels/<이름>/*`(adapter가 `listen`에서 검)·채널 하나만 허용·`PUT /api/organizations/:id/inbox/:kind/:sourceId`(결정 대기 항목의 보관은 422 `archive_not_allowed`, 다른 조직·없는 원본은 404) | 알림 API(재시도·재시작·대시보드와 같은 효과) |
| 가짜 채널 adapter(기록 저장·목록·응답 모양 주입, 본문의 `decision` 유무로 결정/글 답장), 받는 입구(알림 종류별 받는 답·입력 검사·대시보드와 같은 저장 → commit 뒤 할 일·로그 한 줄), 가짜 채널 응답 코드 | [runtime/fake-channel.ts](../../../packages/runtime/src/fake-channel.ts) `createFakeChannel`, [server/channel-replies.ts](../../../apps/server/src/channel-replies.ts) `channelInlet`, app.ts `fakeChannelResponse`(problems.ts `ownerRefusalResponses`) | 알림 API `channel replies`(대시보드와 같은 효과·거부·로그·채널 하나) |
| Inbox 패널(붙음/drawer·범위·필터 개수·정리 버튼·결정 상태 배지·아바타를 눌러 체크·선택 중 체크박스·체크해 읽음), 레일·상단 바·조직 카드 진입점과 주의 수, 전역 설정 자리, 가짜 Lead `실패 연습` | [web/inbox.tsx](../../../apps/web/src/inbox.tsx), shell.tsx, [global-settings.tsx](../../../apps/web/src/global-settings.tsx), api.ts `useUpdateInboxItem`(한 항목 읽음·보관)·`useMarkInboxItemsRead`(체크한 항목 읽음); runtime/scripted.ts `demoLeadScript` | Inbox E2E(다른 탭·390px drawer 포함) |
| Inbox 상세 `/inbox/:orgId/:kind/:sourceId`(요약·그 자리 결정·원래 화면 링크·정리 버튼, 결정 뒤 제자리 결정 기록과 보관, 실패가 아닌 실행 시도는 없음) — 결정 영역은 원래 상세와 공유 | [web/inbox-detail.tsx](../../../apps/web/src/inbox-detail.tsx) `InboxDetailPage`; inbox.tsx `InboxItemOrganize`(패널 행과 공유, 읽지 않음·보관)·체크한 항목 `모두 읽음`(api.ts `useMarkInboxItemsRead`), inbox-detail.tsx `Organize`(열면 읽음, 실패하면 알리고 다시 시도, 다시 불러온 항목이 읽음이면 안내 지움); approvals.tsx `ApprovalDecision`, results.tsx `ResultDecision`(원래 상세와 공유); 근거 [inbox-detail 조사](../../research/inbox-detail-references.md) | Inbox E2E, 초기 승인·작업자 추가·결과 검토 E2E |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
사건 기록(toolWrite·finishRun 등) → insertEvent → core notificationOf → notification_outbox(같은 transaction)
commit 뒤 EventHub → NotificationRelay.kick(시작·5초 주기도) → claimNotifications(SKIP LOCKED·만료·새 token)
  → channel.deliver(transaction 밖; 가짜 채널은 fake_channel_messages에 알림마다 하나, 그 ID를 앱 메시지 번호로 돌려줌)
  → settleNotification(같은 claim일 때만: 보냄 / 실패면 retryDelayMs 뒤 재시도; 앱 메시지 번호는 channel_messages에)
서버 시작 → channel.listen({ inlet: channelInlet, routes: /api/channels/<이름> })(실패하면 종료와 같은 stop: heartbeat·dispatcher·relay·channel.close·HTTP, 한 단계가 실패해도 나머지를 닫음)
가짜 채널 답 → POST /api/channels/fake/messages/:id/reply → createFakeChannel(글 답장/결정) → inlet({ to: 앱 메시지 번호, answer })
  → findRepliedNotification(채널 + 번호 또는 알림 ID → 조직·종류·원본·대화) → 받는 답·입력 확인
  → insertOwnerMessage·decideApproval·decideResult → completeStored → 로그 한 줄 → fakeChannelResponse(대시보드와 같은 응답)
Inbox 패널 정리 → PUT /api/organizations/:id/inbox/:kind/:sourceId → updateInboxItem → inbox_item.updated → 다른 탭 재조회
```

빠진 알림은 `notificationOf`와 그 사건의 `insertEvent` 호출, 중복 전송은 claim 만료와 채널의 알림 ID 중복 거르기, 정리가 결정을 바꾸는 증상은 `updateInboxItem`에서 시작합니다.
