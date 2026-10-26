import { z } from "zod";

// 알림 outbox와 메시지 앱 채널(docs/architecture.md). 알림은 업무 기록과 같은 transaction에 쌓인 전송 의도이며,
// 전송 성공은 Inbox 읽음·승인·최종 완료를 대신하지 않는다. 채널이 받은 사용자 입력은 대시보드와 같은 HTTP 명령으로 들어간다.

/** 알림을 쌓는 사건: Lead 대화 메시지(보고·질문), 승인 요청, 결과 제출, 실패한 실행 시도. */
export const notificationKinds = [
  "lead_message",
  "approval_request",
  "result_submission",
  "run_failure",
] as const;
export const notificationKindSchema = z.enum(notificationKinds);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * 채널에 보내는 알림. `id`는 outbox 항목 ID로, 다시 보내도 같다(채널이 중복을 거르는 기준).
 * `sourceId`는 사건의 원본(메시지·승인 요청·결과 제출·실행 시도)이고 `link`는 대시보드의 상세 경로다.
 * 실행 시도 토큰·비밀값은 담지 않는다.
 */
export const notificationSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  organizationName: z.string(),
  kind: notificationKindSchema,
  sourceId: z.uuid(),
  title: z.string(),
  body: z.string(),
  link: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Notification = z.infer<typeof notificationSchema>;

/**
 * outbox 항목의 전송 상태. `pending`은 아직 보내지 못했고(처음·재시도 대기·전송 중), `sent`는 채널이 받았다.
 * `attempts`는 전송 시도(claim) 횟수로, 내용을 만들지 못해 채널에 넘기지 못한 시도도 센다.
 * `nextAttemptAt`은 실패 뒤 다음 시도 예정이다.
 */
export const notificationDeliverySchema = z.object({
  status: z.enum(["pending", "sent"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  lastError: z.string().nullable(),
});
export const outboxEntrySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  kind: notificationKindSchema,
  sourceId: z.uuid(),
  eventId: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  delivery: notificationDeliverySchema,
});
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;
export const outboxSchema = z.array(outboxEntrySchema);

/**
 * 메시지 앱 채널 adapter. `deliver`가 끝나면 채널이 알림을 받은 것이고, 던지면 outbox가 나중에 다시 보낸다.
 * 같은 알림(`id`)을 두 번 받을 수 있으므로(전송 뒤 기록 전 서버 종료) 채널이 `id`로 중복을 거른다.
 */
export type NotificationChannel = {
  name: string;
  deliver: (notification: Notification) => Promise<void>;
};

/** 가짜 채널이 받은 알림의 전송 기록. 알림 하나에 기록 하나다. */
export const fakeChannelMessageSchema = notificationSchema
  .omit({ id: true, createdAt: true })
  .extend({
    id: z.uuid(),
    notificationId: z.uuid(),
    deliveredAt: z.iso.datetime({ offset: true }),
  });
export type FakeChannelMessage = z.infer<typeof fakeChannelMessageSchema>;
export const fakeChannelMessagesSchema = z.array(fakeChannelMessageSchema);
