import {
  inboxDetailPath,
  type ApprovalKind,
  type Event,
  type Notification,
  type NotificationKind,
} from "@babojubot/contracts";

/**
 * Event가 알림을 쌓는 사건인가. 사건마다 원본 하나를 가리키며, 저장 쪽은 Event와 같은 transaction에 outbox 항목을 남긴다.
 * - Lead 대화 메시지(에이전트가 보낸 것. 대화 메시지는 Lead만 보낸다). 사용자 메시지는 알리지 않는다.
 * - 승인 요청(초기 연구 승인·작업자 추가), 결과 제출.
 * - 실패한 실행 시도(`failed`). 사용자 취소·정상 완료와, 깨우기를 다음 실행 시도가 다시 받는 서버 재시작은 실패가 아니다.
 */
export function notificationOf(
  event: Event
): { kind: NotificationKind; sourceId: string } | null {
  switch (event.type) {
    case "message.created":
      return event.payload.author === "agent"
        ? { kind: "lead_message", sourceId: event.payload.messageId }
        : null;
    case "approval.requested":
      return { kind: "approval_request", sourceId: event.payload.approvalId };
    case "result.submitted":
      return {
        kind: "result_submission",
        sourceId: event.payload.submissionId,
      };
    case "run.finished":
      return event.payload.stopReason === "failed"
        ? { kind: "run_failure", sourceId: event.payload.runId }
        : null;
    default:
      return null;
  }
}

/** 전송이 실패한 뒤 다음 시도까지. `attempts`번째 시도가 실패했다. 1초에서 두 배씩, 5분에서 멈춘다. */
export const retryDelayMs = (attempts: number) =>
  Math.min(1_000 * 2 ** Math.max(attempts - 1, 0), 300_000);

/** 알림 내용을 만들 원본의 사실. 전송할 때 원본에서 읽는다. */
export type NotificationFacts =
  | { kind: "lead_message"; body: string }
  | { kind: "approval_request"; approvalKind: ApprovalKind }
  | { kind: "result_submission"; summary: string }
  | { kind: "run_failure"; agentName: string; error: string | null };

const approvalTitle: Record<ApprovalKind, string> = {
  initial_research: "초기 연구 승인 요청",
  add_worker: "작업자 추가 승인 요청",
};
const bodyMaxLength = 500;
const clip = (text: string) =>
  text.length > bodyMaxLength ? `${text.slice(0, bodyMaxLength - 1)}…` : text;

/** 알림의 제목·본문·대시보드 경로. Inbox 항목이 되는 사건은 Inbox 상세(요약), Lead 메시지는 대화로 간다. 본문은 길면 자르고, 전체는 상세에서 본다. */
export function notificationContent(
  organizationId: string,
  sourceId: string,
  facts: NotificationFacts
): Pick<Notification, "title" | "body" | "link"> {
  switch (facts.kind) {
    case "lead_message":
      return {
        title: "Research Lead 메시지",
        body: clip(facts.body),
        link: `/orgs/${organizationId}/chat`,
      };
    case "approval_request":
      return {
        title: approvalTitle[facts.approvalKind],
        body: "사용자 결정을 기다립니다.",
        link: inboxDetailPath(organizationId, "approval", sourceId),
      };
    case "result_submission":
      return {
        title: "결과 제출",
        body: clip(facts.summary),
        link: inboxDetailPath(organizationId, "result_submission", sourceId),
      };
    case "run_failure":
      return {
        title: "실행 시도 실패",
        body: clip(`${facts.agentName}: ${facts.error ?? "오류 내용 없음"}`),
        link: inboxDetailPath(organizationId, "run_failure", sourceId),
      };
  }
}
