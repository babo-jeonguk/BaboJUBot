import type {
  ChannelAnswer,
  ChannelReplyResult,
  ChannelResponse,
  DecideApprovalInput,
  FakeChannelMessage,
  Notification,
  NotificationChannel,
  SendOwnerMessageInput,
} from "@babojubot/contracts";

// 메시지 앱 자리를 지키는 가짜 채널 adapter. 받은 알림을 전송 기록(가짜 휴대폰 화면)으로 남기고 그 기록 ID를 앱 메시지 번호로 쓴다.
// 사용자의 답은 그 기록에 대한 답장으로 받아 서버가 건넨 입구에 넘긴다. 실제 메시지 앱 adapter도 같은 outbox·같은 입구를 쓴다.
// 사용자 API처럼 로컬 신뢰 운영을 따르며 보낸 사람을 확인하지 않는다.

/**
 * 가짜 채널. 기록 저장(`record`)은 알림 ID로 중복을 거르고 기록 ID를 돌려준다. 답장 경로의 응답은 `respond`가 대시보드 명령과
 * 같은 응답 코드·본문으로 만든다.
 */
export const createFakeChannel = ({
  record,
  list,
  respond,
}: {
  record: (notification: Notification) => Promise<string>;
  list: () => Promise<FakeChannelMessage[]>;
  respond: (
    result: ChannelReplyResult,
    answer: ChannelAnswer
  ) => ChannelResponse;
}): NotificationChannel => ({
  name: "fake",
  deliver: async (notification) => ({
    appMessageId: await record(notification),
  }),
  listen: ({ inlet, routes }) => {
    /** 가짜 채널이 받은 알림의 전송 기록. 받은 순서다. */
    routes.get("/messages", async () => ({ status: 200, body: await list() }));
    /**
     * 가짜 채널의 기록에 사용자가 답장한다. 본문에 `decision`이 있으면 결정(승인 결정·결과 결정 입력 그대로),
     * 없으면 글 답장(사용자 메시지 보내기 입력 그대로)이다.
     */
    routes.post("/messages/:messageId/reply", async ({ params, body }) => {
      const answer = answerOf(body);
      return respond(
        await inlet({ to: { appMessageId: params.messageId! }, answer }),
        answer
      );
    });
  },
});

const answerOf = (body: unknown): ChannelAnswer =>
  typeof body === "object" && body !== null && "decision" in body
    ? { kind: "decision", input: body as DecideApprovalInput }
    : { kind: "text", input: body as SendOwnerMessageInput };
