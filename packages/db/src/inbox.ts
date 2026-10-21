import type { InboxItem } from "@babojubot/contracts";
import { asc, eq } from "drizzle-orm";
import { toApprovalSummary } from "./approvals.ts";
import type { Database } from "./client.ts";
import { toResultSubmissionSummary } from "./results.ts";
import { approvals, organizations, resultSubmissions } from "./schema.ts";

/**
 * Inbox: 모든 조직에서 사용자 결정을 기다리는 승인 요청과 결과 제출. 오래된 것부터.
 * 결정을 기다리는 기록에서 바로 읽으므로 결정하면 빠지고, 알림 전송 여부와 상관없이 나온다.
 */
export async function listInbox(db: Database): Promise<InboxItem[]> {
  const pendingApprovals = await db
    .select({ approval: approvals, organizationName: organizations.name })
    .from(approvals)
    .innerJoin(organizations, eq(organizations.id, approvals.organizationId))
    .where(eq(approvals.status, "pending"))
    .orderBy(asc(approvals.seq));
  const pendingResults = await db
    .select({
      submission: resultSubmissions,
      organizationName: organizations.name,
    })
    .from(resultSubmissions)
    .innerJoin(
      organizations,
      eq(organizations.id, resultSubmissions.organizationId)
    )
    .where(eq(resultSubmissions.status, "pending"))
    .orderBy(asc(resultSubmissions.seq));
  const items: InboxItem[] = [
    ...pendingApprovals.map(({ approval, organizationName }) => ({
      kind: "approval" as const,
      organizationName,
      approval: toApprovalSummary(approval),
    })),
    ...pendingResults.map(({ submission, organizationName }) => ({
      kind: "result_submission" as const,
      organizationName,
      submission: toResultSubmissionSummary(submission),
    })),
  ];
  const createdAt = (item: InboxItem) =>
    item.kind === "approval"
      ? item.approval.createdAt
      : item.submission.createdAt;
  return items.sort((a, b) => createdAt(a).localeCompare(createdAt(b)));
}
