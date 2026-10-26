import {
  decideApprovalInputSchema,
  type FakeChannelMessage,
  type Notification,
  type NotificationChannel,
} from "@babojubot/contracts";

// 메시지 앱 자리를 지키는 가짜 채널 adapter. 받은 알림을 전송 기록으로 남기고, 사용자의 답(승인 결정)은
// 대시보드와 같은 사용자 HTTP 명령으로 넣는다. 실제 메시지 앱 adapter도 같은 outbox와 같은 명령 경로를 쓴다.

/** 알림을 전송 기록으로 남기는 채널. 기록 저장(`record`)이 알림 ID로 중복을 거른다. */
export const createFakeChannel = (
  record: (notification: Notification) => Promise<void>
): NotificationChannel => ({ name: "fake", deliver: record });

export type FakeReplyResult =
  | { kind: "reply_not_allowed" }
  | { kind: "invalid_input"; issues: unknown }
  | { kind: "forwarded"; status: number; body: unknown };

/**
 * 가짜 채널에 남은 알림에 사용자가 답한다. 답할 수 있는 알림은 승인 요청뿐이고 답은 승인 결정 입력 그대로다.
 * 조직과 승인 요청은 답이 아니라 전송 기록에서 정하며, 결정은 대시보드와 같은 사용자 HTTP 명령
 * (`POST /api/organizations/:id/approvals/:approvalId/decision`)으로 보내 그 응답을 그대로 돌려준다.
 */
export async function replyThroughFakeChannel(
  baseUrl: string,
  message: FakeChannelMessage,
  body: unknown
): Promise<FakeReplyResult> {
  if (message.kind !== "approval_request") return { kind: "reply_not_allowed" };
  const input = decideApprovalInputSchema.safeParse(body);
  if (!input.success)
    return { kind: "invalid_input", issues: input.error.issues };
  const res = await fetch(
    `${baseUrl}/api/organizations/${encodeURIComponent(message.organizationId)}/approvals/${encodeURIComponent(message.sourceId)}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.data),
    }
  );
  return {
    kind: "forwarded",
    status: res.status,
    body: await res.json().catch(() => null),
  };
}
