import type { InboxItem } from "@babojubot/contracts";
import { and, asc, eq, ne, or } from "drizzle-orm";
import { toApprovalSummary } from "./approvals.ts";
import type { Database } from "./client.ts";
import { toResultSubmissionSummary } from "./results.ts";
import { approvals, organizations, resultSubmissions } from "./schema.ts";

/**
 * Inbox: 모든 조직에서 사용자 결정을 기다리는 승인 요청과 결과 제출. 오래된 것부터.
 * 결정을 기다리는 기록에서 바로 읽으므로 결정하면 빠지고, 알림 전송 여부와 상관없이 나온다.
 * 중단된 조직의 초기 연구 승인 요청·결과 제출은 결정을 받지 않으므로 빠진다. 작업자 추가 요청은 단계와 상관없이 결정하므로 남는다.
 */
export async function listInbox(db: Database): Promise<InboxItem[]> {
  const pendingApprovals = await db
    .select({ approval: approvals, organizationName: organizations.name })
    .from(approvals)
    .innerJoin(organizations, eq(organizations.id, approvals.organizationId))
    .where(
      and(
        eq(approvals.status, "pending"),
        or(eq(approvals.kind, "add_worker"), ne(organizations.stage, "stopped"))
      )
    )
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
    .where(
      and(
        eq(resultSubmissions.status, "pending"),
        ne(organizations.stage, "stopped")
      )
    )
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
