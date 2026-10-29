import {
  decideApprovalInputSchema,
  decideResultInputSchema,
  sendOwnerMessageInputSchema,
  type ChannelAnswer,
  type ChannelInlet,
  type ChannelReply,
  type ChannelReplyResult,
  type Conversation,
  type ConversationMessage,
  type DecideApprovalInput,
  type DecideResultInput,
  type NotificationKind,
  type OrganizationDetail,
  type SendOwnerMessageInput,
} from "@babojubot/contracts";
import {
  decideApproval,
  decideResult,
  findConversation,
  findOrganization,
  findRepliedNotification,
  refused,
  type Database,
  type Stored,
} from "@babojubot/db";
import type { RecordSource } from "@babojubot/core";
import type { Outcome } from "./after-commit.ts";

/**
 * 채널 하나의 받는 입구. 답한 알림을 찾아 그 알림의 조직·원본에만 대시보드와 같은 저장 → commit 뒤 할 일을 한다.
 * Lead 메시지 알림의 글 답장은 그 메시지가 있는 대화에 사용자 메시지로, 승인 요청·결과 제출 알림의 결정은 그 원본의 결정으로 들어간다.
 * 알림 종류에 맞지 않는 답·알림을 가리키지 않는 답은 `reply_not_allowed`, 모르는 알림은 `not_found`이며 아무것도 남기지 않는다.
 * 끝난 조직의 거부(`organization_closed`)와 이미 한 결정의 거부는 대시보드와 같은 저장 규칙이 조직 잠금 아래에서 한다.
 * 자기 서버를 HTTP로 다시 부르지 않는다.
 * 답마다 서버 로그 한 줄(채널, 알림 ID, 답 종류, 받음 또는 거부 이유)을 남기고 답의 글 내용은 적지 않는다. DB·Event에는 출처를 남기지 않는다.
 */
export function channelInlet({
  channel,
  db,
  source,
  complete,
  sendOwnerMessage,
  log = (line) => console.info(line),
}: {
  channel: string;
  db: Database;
  source: RecordSource;
  complete: <T, R extends string>(
    result: Promise<Stored<T, R>>
  ) => Promise<Outcome<T, R>>;
  sendOwnerMessage: (
    organization: OrganizationDetail,
    conversation: Pick<Conversation, "id">,
    input: Required<SendOwnerMessageInput>
  ) => Promise<Outcome<{ message: ConversationMessage }, string>>;
  log?: (line: string) => void;
}): ChannelInlet {
  const receive = async (
    reply: ChannelReply
  ): Promise<[notificationId: string | null, ChannelReplyResult]> => {
    if (!reply.to) return [null, refused("reply_not_allowed")];
    const notification = await findRepliedNotification(db, channel, reply.to);
    if (!notification) return [null, refused("not_found")];
    const { notificationId, organizationId, kind, sourceId } = notification;
    const parsed = parseAnswer(kind, reply.answer);
    if (parsed === "reply_not_allowed")
      return [notificationId, refused(parsed)];
    if ("issues" in parsed)
      return [notificationId, { kind: "invalid_input", issues: parsed.issues }];

    let outcome: Outcome<unknown, string>;
    switch (parsed.kind) {
      case "lead_message": {
        const organization = await findOrganization(db, organizationId);
        const conversation = await findConversation(
          db,
          organizationId,
          notification.conversationId!
        );
        if (!organization || !conversation)
          return [notificationId, refused("not_found")];
        const sent = await sendOwnerMessage(
          organization,
          conversation,
          parsed.input
        );
        outcome =
          sent.kind === "ok" ? { kind: "ok", value: sent.value.message } : sent;
        break;
      }
      case "approval_request":
        outcome = await complete(
          decideApproval(db, organizationId, sourceId, parsed.input, source)
        );
        break;
      case "result_submission":
        outcome = await complete(
          decideResult(db, organizationId, sourceId, parsed.input, source)
        );
        break;
    }
    return [notificationId, outcome];
  };

  return async (reply) => {
    const [notificationId, result] = await receive(reply);
    log(
      `[channel] ${channel} notification=${notificationId ?? "-"} answer=${reply.answer.kind} ${
        result.kind === "ok"
          ? "accepted"
          : `refused=${result.kind === "refused" ? result.reason : result.kind}`
      }`
    );
    return result;
  };
}

/**
 * 알림 종류마다 받는 답을 가리고 입력을 그 알림 원본의 대시보드 입력 계약으로 검사한다. Lead 메시지는 글 답장만, 승인 요청·결과 제출은
 * 결정만 받고 실행 시도 실패는 답을 받지 않는다.
 */
function parseAnswer(
  kind: NotificationKind,
  answer: ChannelAnswer
):
  | { kind: "lead_message"; input: Required<SendOwnerMessageInput> }
  | { kind: "approval_request"; input: DecideApprovalInput }
  | { kind: "result_submission"; input: DecideResultInput }
  | { issues: unknown }
  | "reply_not_allowed" {
  switch (kind) {
    case "lead_message": {
      if (answer.kind !== "text") return "reply_not_allowed";
      const input = sendOwnerMessageInputSchema.safeParse(answer.input);
      return input.success
        ? { kind, input: input.data }
        : { issues: input.error.issues };
    }
    case "approval_request": {
      if (answer.kind !== "decision") return "reply_not_allowed";
      const input = decideApprovalInputSchema.safeParse(answer.input);
      return input.success
        ? { kind, input: input.data }
        : { issues: input.error.issues };
    }
    case "result_submission": {
      if (answer.kind !== "decision") return "reply_not_allowed";
      const input = decideResultInputSchema.safeParse(answer.input);
      return input.success
        ? { kind, input: input.data }
        : { issues: input.error.issues };
    }
    case "run_failure":
      return "reply_not_allowed";
  }
}
