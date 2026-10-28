import { z } from "zod";
import type { DecideApprovalInput } from "./approval.ts";
import type { SendOwnerMessageInput } from "./message.ts";
import type { DecideResultInput } from "./result.ts";

// 알림 outbox와 메시지 앱 채널(docs/architecture.md). 알림은 업무 기록과 같은 transaction에 쌓인 전송 의도이며,
// 전송 성공은 Inbox 읽음·승인·최종 완료를 대신하지 않는다. 채널이 받은 사용자의 답은 "이 알림에 이렇게 답했다"로
// Control Plane에 넘어가 대시보드와 같은 저장·거부 규칙을 거친다.

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
 * 채널이 받은 사용자의 답 하나. 답한 알림은 버튼이면 값에 넣은 알림 ID로, 글 답장이면 답장한 앱 메시지 번호(`deliver`가 돌려준 것)로
 * 가리키고, 어느 알림도 가리키지 않으면 `null`이다. 조직과 원본은 답의 내용이 아니라 그 알림에서만 정한다.
 * 보낸 사람 확인(출처 서명·비밀값, 보낸 사람 허용 목록)은 adapter가 이미 마친 답만 넘긴다(docs/architecture.md 강제 위치 표).
 */
export type ChannelReply = {
  to: { notificationId: string } | { appMessageId: string } | null;
  answer: ChannelAnswer;
};

/**
 * 알림에 대한 답의 모양. 글 명령(`/approve`)이나 버튼을 이 모양으로 바꾸는 일은 adapter가 맡고, 입력 검사는 Control Plane이
 * 대시보드와 같은 계약으로 한다. Lead 메시지 알림은 글 답장만, 승인 요청·결과 제출 알림은 결정만 받고 실행 시도 실패 알림은 받지 않는다.
 */
export type ChannelAnswer =
  /** 글 답장. 입력은 대시보드의 사용자 메시지 보내기와 같다(전달 방식을 고르지 않으면 줄 세우기). */
  | { kind: "text"; input: SendOwnerMessageInput }
  /** 결정. 입력은 그 알림 원본(승인 요청·결과 제출)의 대시보드 결정과 같다. */
  | { kind: "decision"; input: DecideApprovalInput | DecideResultInput };

/**
 * 답을 받은 결과. 받으면 대시보드 명령과 같은 값(사용자 메시지·승인 요청·결과 제출)이고, 거부 이유는 대시보드 거부 코드와 같다.
 * 알림 종류에 맞지 않는 답과 알림을 가리키지 않는 답은 `reply_not_allowed`, 모르는 알림은 `not_found`다. 거부하면 아무것도 남지 않는다.
 * 경고를 사용자에게 어떻게 보여 줄지는 adapter가 정한다.
 */
export type ChannelReplyResult =
  | { kind: "ok"; value: unknown }
  | { kind: "refused"; reason: string }
  | { kind: "invalid_input"; issues: unknown };

/** 서버가 채널마다 건네는 받는 입구. */
export type ChannelInlet = (reply: ChannelReply) => Promise<ChannelReplyResult>;

/** 채널 경로 하나가 받는 요청과 돌려주는 응답. 본문은 JSON이다. */
export type ChannelRequest = {
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
export type ChannelResponse = { status: number; body: unknown };
export type ChannelRoute = (
  request: ChannelRequest
) => Promise<ChannelResponse>;

/** adapter가 서버의 같은 주소 아래(`/api/channels/<채널 이름>`)에 자기 경로(webhook 등)를 거는 자리. */
export type ChannelRoutes = {
  get: (path: string, route: ChannelRoute) => void;
  post: (path: string, route: ChannelRoute) => void;
};

/**
 * 메시지 앱 채널 adapter: 보내기, 받기 시작, 멈춤. `deliver`가 끝나면 채널이 알림을 받은 것이고, 던지면 outbox가 나중에 다시 보낸다.
 * 같은 알림(`id`)을 두 번 받을 수 있으므로(전송 뒤 기록 전 서버 종료) 채널이 `id`로 중복을 거른다. 보낸 앱 메시지 번호를 돌려주면
 * 그 메시지에 대한 글 답장이 그 알림을 가리킨다. `listen`은 서버 시작 때 한 번 받는 입구와 경로 자리를 받고, polling 같은
 * 연결 루프는 adapter가 돌린다. `close`는 서버를 끌 때 부른다.
 */
export type NotificationChannel = {
  name: string;
  deliver: (
    notification: Notification
  ) => Promise<{ appMessageId: string } | void>;
  listen?: (context: {
    inlet: ChannelInlet;
    routes: ChannelRoutes;
  }) => Promise<void> | void;
  close?: () => Promise<void>;
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
