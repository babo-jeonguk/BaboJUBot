# 알림 outbox·가짜 채널·Inbox

통합 검증: [알림 API](../../../apps/server/test/notifications.test.ts), [Inbox E2E](../../../apps/web/e2e/inbox.spec.ts).

| 작업·증상 | 진입점 | 테스트 |
| --- | --- | --- |
| 알림·outbox·채널 port, Inbox 항목·필터 판정, Event `inbox_item.updated` | [contracts/notification.ts](../../../packages/contracts/src/notification.ts) `NotificationChannel`·`ChannelInlet`, [inbox.ts](../../../packages/contracts/src/inbox.ts) `awaitsDecision`·`needsAttention`·`inboxFilters`·`inboxDetailPath`, event.ts | 알림 API, [contracts](../../../packages/contracts/src/inbox.test.ts) |
| 어떤 Event가 알림인가·재시도 간격·알림 내용 | [core/notification.ts](../../../packages/core/src/notification.ts) `notificationOf`·`retryDelayMs`·`notificationContent` | [core](../../../packages/core/src/notification.test.ts) |
| outbox 저장·claim·정산, 답한 알림 찾기 | [db/notifications.ts](../../../packages/db/src/notifications.ts) `claimNotifications`·`settleNotification`·`findRepliedNotification`, rows.ts `insertEvent`; migration 0010·0020 | [DB](../../../packages/db/src/notifications.test.ts) |
| Inbox 목록·정리 상태 저장 | db/inbox.ts `listInbox`·`updateInboxItem`, contracts `canArchiveInboxItem`; migration 0010~0012 | 알림 API `Inbox` |
| 전송 수명, 알림·채널·정리 API | [server/notifications.ts](../../../apps/server/src/notifications.ts) `NotificationRelay`, app.ts `GET /api/notifications`·`/api/channels/<이름>/*`·`PUT /api/organizations/:id/inbox/:kind/:sourceId` | 알림 API |
| 가짜 채널·채널 답 받기 | [runtime/fake-channel.ts](../../../packages/runtime/src/fake-channel.ts) `createFakeChannel`, [server/channel-replies.ts](../../../apps/server/src/channel-replies.ts) `channelInlet`, app.ts `fakeChannelResponse` | 알림 API `channel replies` |
| Inbox 패널·진입점·주의 수 | [web/inbox.tsx](../../../apps/web/src/inbox.tsx), shell.tsx, [global-settings.tsx](../../../apps/web/src/global-settings.tsx), api.ts `useUpdateInboxItem`·`useMarkInboxItemsRead` | Inbox E2E |
| Inbox 상세와 그 자리 결정 | [web/inbox-detail.tsx](../../../apps/web/src/inbox-detail.tsx) `InboxDetailPage`·`Organize`, inbox.tsx `InboxItemOrganize`, approvals.tsx `ApprovalDecision`, results.tsx `ResultDecision` | Inbox E2E, 초기 승인·작업자 추가·결과 검토 E2E |
| 잘린 요약 글 | inbox-detail.tsx `Excerpt` | [접근성 E2E](../../../apps/web/e2e/keyboard-a11y.spec.ts) |

## 연결 경로

공통 순서는 [공통 경로](shared-path.md)를 따릅니다.

```text
사건 기록 → insertEvent → core notificationOf → notification_outbox(같은 transaction)
commit 뒤 → NotificationRelay.kick → claimNotifications → channel.deliver(transaction 밖) → settleNotification
서버 시작 → channel.listen({ inlet: channelInlet })
가짜 채널 답 → POST /api/channels/fake/messages/:id/reply → createFakeChannel → inlet
  → findRepliedNotification → insertOwnerMessage·decideApproval·decideResult → completeStored → fakeChannelResponse
Inbox 정리 → PUT /api/organizations/:id/inbox/:kind/:sourceId → updateInboxItem → inbox_item.updated
```

빠진 알림은 `notificationOf`와 그 사건의 `insertEvent` 호출, 중복 전송은 claim 만료, 정리가 결정을 바꾸는 증상은 `updateInboxItem`에서 시작합니다.
