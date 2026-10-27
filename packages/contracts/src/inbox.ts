import { z } from "zod";
import { approvalSummarySchema } from "./approval.ts";
import { resultSubmissionSummarySchema } from "./result.ts";
import { runSummarySchema } from "./run.ts";

/** Inbox 항목 종류. 승인 요청·결과 제출은 결정한 뒤에도 남고, 실패한 실행 시도는 실행 시도마다 남는다. */
export const inboxItemKinds = [
  "approval",
  "result_submission",
  "run_failure",
] as const;
export const inboxItemKindSchema = z.enum(inboxItemKinds);
export type InboxItemKind = z.infer<typeof inboxItemKindSchema>;

/**
 * 사용자의 알림 정리 상태. 항목의 원본(승인 요청·결과 제출·실행 시도)과 따로 저장하며, 읽음·보관은 결정·단계·깨우기를 바꾸지 않는다.
 * 아직 정리하지 않은 항목은 보관 안 함이고, 결정한 승인 요청·결과 제출이면 읽음(결정하려면 본다), 아니면 읽지 않음이다.
 */
export const inboxItemStateSchema = z.object({
  read: z.boolean(),
  archived: z.boolean(),
});
export type InboxItemState = z.infer<typeof inboxItemStateSchema>;

const itemBase = {
  organizationName: z.string(),
  ...inboxItemStateSchema.shape,
};

/**
 * Inbox 항목. 승인 요청과 결과 제출은 결정한 뒤에도 결정 상태(`status`)와 함께 남는다.
 * 실패한 실행 시도(`failed`)는 실행 시도마다 하나이며, 같은 에이전트의 뒤 실행 시도가 성공해도 남는다.
 * 사용자 취소·정상 완료·서버 재시작(깨우기를 다음 실행 시도가 다시 받음)은 실패가 아니다.
 */
export const inboxItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    ...itemBase,
    approval: approvalSummarySchema,
  }),
  z.object({
    kind: z.literal("result_submission"),
    ...itemBase,
    submission: resultSubmissionSummarySchema,
  }),
  z.object({
    kind: z.literal("run_failure"),
    ...itemBase,
    agentName: z.string(),
    run: runSummarySchema,
  }),
]);
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxSchema = z.array(inboxItemSchema);

/** 항목의 원본 ID. 정리 명령의 주소이며, 같은 종류 안에서만 유일하다. */
export const inboxSourceId = (item: InboxItem) =>
  item.kind === "approval"
    ? item.approval.id
    : item.kind === "result_submission"
      ? item.submission.id
      : item.run.id;
/**
 * Inbox 상세(요약)의 대시보드 경로. 항목은 자기 ID가 없고 원본 ID는 종류 안에서만 유일하며 원본은 조직 범위로 찾으므로
 * 조직·종류·원본 ID를 함께 쓴다. 결정한 뒤에도 같은 경로가 그 항목을 보인다.
 */
export const inboxDetailPath = (
  organizationId: string,
  kind: InboxItemKind,
  sourceId: string
) => `/inbox/${organizationId}/${kind}/${sourceId}`;
export const inboxOrganizationId = (item: InboxItem) =>
  item.kind === "approval"
    ? item.approval.organizationId
    : item.kind === "result_submission"
      ? item.submission.organizationId
      : item.run.organizationId;
/** 항목이 생긴 때. 실패한 실행 시도는 끝난 때다. */
export const inboxItemTime = (item: InboxItem) =>
  item.kind === "approval"
    ? item.approval.createdAt
    : item.kind === "result_submission"
      ? item.submission.createdAt
      : (item.run.finishedAt ?? item.run.startedAt);

/** 결정을 기다리는 항목: `pending`인 승인 요청·결과 제출. 실패한 실행 시도에는 결정할 것이 없다. */
export const awaitsDecision = (item: InboxItem) =>
  item.kind === "approval"
    ? item.approval.status === "pending"
    : item.kind === "result_submission"
      ? item.submission.status === "pending"
      : false;

/**
 * 보관할 수 있는 항목: 결정을 기다리지 않는 모든 항목(결정한 승인 요청·결과 제출, 실패한 실행 시도).
 * 결정을 기다리는 항목은 보관해 숨길 수 없고 결정해야 한다. 결정은 다시 바뀌지 않으므로 한 번 보관할 수 있게 된 항목은 계속 그렇다.
 */
export const canArchiveInboxItem = (item: InboxItem) => !awaitsDecision(item);

/**
 * 주의 필요: 결정을 기다리는 승인 요청·결과 제출(읽어도 결정할 때까지 남는다)과 보관하지 않은 읽지 않은 실패.
 * 결정한 승인 요청·결과 제출은 읽지 않았어도 주의 필요가 아니다.
 * 레일·조직 카드의 주의 수와 Inbox의 주의 필요 필터가 이 하나의 판정을 쓴다.
 */
export const needsAttention = (item: InboxItem) =>
  !item.archived &&
  (awaitsDecision(item) || (item.kind === "run_failure" && !item.read));

/**
 * Inbox 필터: 주의 필요(기본)·전체(보관 제외, 결정한 항목 포함)·읽지 않음·보관됨. 필터끼리 겹치므로 개수를 더해 전체로 쓰지 않는다.
 */
export const inboxFilters = {
  attention: needsAttention,
  unread: (item: InboxItem) => !item.archived && !item.read,
  all: (item: InboxItem) => !item.archived,
  archived: (item: InboxItem) => item.archived,
} as const satisfies Record<string, (item: InboxItem) => boolean>;
export type InboxFilter = keyof typeof inboxFilters;

/** 알림 정리 명령. 준 값을 그대로 대입하므로 같은 명령을 다시 보내도 결과가 같다. */
export const updateInboxItemInputSchema = z
  .strictObject({
    read: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((input) => input.read !== undefined || input.archived !== undefined, {
    message: "read나 archived 중 하나는 있어야 한다",
  });
export type UpdateInboxItemInput = z.infer<typeof updateInboxItemInputSchema>;
