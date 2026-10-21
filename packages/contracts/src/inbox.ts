import { z } from "zod";
import { approvalSummarySchema } from "./approval.ts";
import { resultSubmissionSummarySchema } from "./result.ts";

/**
 * Inbox 항목. 첫 판은 사용자 결정을 기다리는 승인 요청과 결과 제출만 담는다(나머지 종류와 읽음·보관은 #61).
 * 결정을 기다리는 동안만 나오며, 결정하면 빠진다.
 */
export const inboxItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    organizationName: z.string(),
    approval: approvalSummarySchema,
  }),
  z.object({
    kind: z.literal("result_submission"),
    organizationName: z.string(),
    submission: resultSubmissionSummarySchema,
  }),
]);
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxSchema = z.array(inboxItemSchema);
