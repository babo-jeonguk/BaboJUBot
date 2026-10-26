import type {
  Event,
  InboxItem,
  InboxItemKind,
  InboxItemState,
  UpdateInboxItemInput,
} from "@babojubot/contracts";
import { canArchiveInboxItem, inboxItemTime } from "@babojubot/contracts";
import { and, asc, eq, ne, or } from "drizzle-orm";
import { toApprovalSummary } from "./approvals.ts";
import type { Database } from "./client.ts";
import { toResultSubmissionSummary } from "./results.ts";
import { insertEvent, isUuid, type Executor } from "./rows.ts";
import { runSummaryColumns, toRunSummary } from "./runs.ts";
import {
  agents,
  approvals,
  inboxStates,
  organizations,
  resultSubmissions,
  runs,
} from "./schema.ts";

const stateOf = (row: { read: boolean | null; archived: boolean | null }) => ({
  read: row.read ?? false,
  archived: row.archived ?? false,
});
const stateColumns = { read: inboxStates.read, archived: inboxStates.archived };

/**
 * Inbox: 모든 조직의 결정을 기다리는 승인 요청·결과 제출과 실패한 실행 시도, 각 항목의 읽음·보관. 오래된 것부터.
 * 승인 요청·결과 제출은 결정을 기다리는 기록에서 바로 읽으므로 결정하면 빠지고, 알림 전송 여부와 상관없이 나온다.
 * 중단된 조직의 초기 연구 승인 요청·결과 제출은 결정을 받지 않으므로 빠진다. 작업자 추가 요청은 단계와 상관없이 결정하므로 남는다.
 * 실패한 실행 시도는 실행 시도마다 남으며 보관해도 보관됨에 남는다.
 */
export async function listInbox(db: Database): Promise<InboxItem[]> {
  const pendingApprovals = await db
    .select({
      approval: approvals,
      organizationName: organizations.name,
      ...stateColumns,
    })
    .from(approvals)
    .innerJoin(organizations, eq(organizations.id, approvals.organizationId))
    .leftJoin(inboxStates, eq(inboxStates.approvalId, approvals.id))
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
      ...stateColumns,
    })
    .from(resultSubmissions)
    .innerJoin(
      organizations,
      eq(organizations.id, resultSubmissions.organizationId)
    )
    .leftJoin(
      inboxStates,
      eq(inboxStates.resultSubmissionId, resultSubmissions.id)
    )
    .where(
      and(
        eq(resultSubmissions.status, "pending"),
        ne(organizations.stage, "stopped")
      )
    )
    .orderBy(asc(resultSubmissions.seq));
  const failedRuns = await db
    .select({
      run: runSummaryColumns,
      agentName: agents.name,
      organizationName: organizations.name,
      ...stateColumns,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .innerJoin(organizations, eq(organizations.id, runs.organizationId))
    .leftJoin(inboxStates, eq(inboxStates.runId, runs.id))
    .where(eq(runs.status, "failed"))
    .orderBy(asc(runs.seq));
  const items: InboxItem[] = [
    ...pendingApprovals.map((row) => ({
      kind: "approval" as const,
      organizationName: row.organizationName,
      ...stateOf(row),
      approval: toApprovalSummary(row.approval),
    })),
    ...pendingResults.map((row) => ({
      kind: "result_submission" as const,
      organizationName: row.organizationName,
      ...stateOf(row),
      submission: toResultSubmissionSummary(row.submission),
    })),
    ...failedRuns.map((row) => ({
      kind: "run_failure" as const,
      organizationName: row.organizationName,
      ...stateOf(row),
      agentName: row.agentName,
      run: toRunSummary(row.run),
    })),
  ];
  return items.sort((a, b) => inboxItemTime(a).localeCompare(inboxItemTime(b)));
}

const sourceColumn = {
  approval: inboxStates.approvalId,
  result_submission: inboxStates.resultSubmissionId,
  run_failure: inboxStates.runId,
} as const;
const sourceField = {
  approval: "approvalId",
  result_submission: "resultSubmissionId",
  run_failure: "runId",
} as const;

/** 정리할 수 있는 원본인가: 그 조직의 승인 요청·결과 제출, 또는 그 조직의 실패한 실행 시도. */
async function sourceExists(
  tx: Executor,
  organizationId: string,
  kind: InboxItemKind,
  sourceId: string
) {
  const rows =
    kind === "approval"
      ? await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.organizationId, organizationId),
              eq(approvals.id, sourceId)
            )
          )
      : kind === "result_submission"
        ? await tx
            .select({ id: resultSubmissions.id })
            .from(resultSubmissions)
            .where(
              and(
                eq(resultSubmissions.organizationId, organizationId),
                eq(resultSubmissions.id, sourceId)
              )
            )
        : await tx
            .select({ id: runs.id })
            .from(runs)
            .where(
              and(
                eq(runs.organizationId, organizationId),
                eq(runs.id, sourceId),
                eq(runs.status, "failed")
              )
            );
  return rows.length > 0;
}

/**
 * 사용자의 알림 정리 명령. 준 값(읽음·보관)을 그대로 대입하고, 바뀌었으면 정리 뒤 상태로 `inbox_item.updated` Event를 남긴다.
 * 원본의 결정·단계·깨우기는 건드리지 않는다. 다른 조직의 원본과 없는 원본은 `not_found`다.
 * 보관할 수 없는 종류(결정을 기다리는 승인 요청·결과 제출)를 보관하라는 명령은 아무것도 바꾸지 않고 `archive_not_allowed`다.
 * 같은 항목의 동시 명령은 정리 상태 행 잠금으로 직렬화되어 서로의 값을 잃지 않는다.
 */
export async function updateInboxItem(
  db: Database,
  organizationId: string,
  kind: InboxItemKind,
  sourceId: string,
  input: UpdateInboxItemInput
): Promise<
  | { kind: "updated"; state: InboxItemState; event: Event | null }
  | { kind: "not_found" }
  | { kind: "archive_not_allowed" }
> {
  if (!isUuid(organizationId) || !isUuid(sourceId))
    return { kind: "not_found" };
  if (input.archived && !canArchiveInboxItem(kind))
    return { kind: "archive_not_allowed" };
  return db.transaction(async (tx) => {
    if (!(await sourceExists(tx, organizationId, kind, sourceId)))
      return { kind: "not_found" as const };
    await tx
      .insert(inboxStates)
      .values({ organizationId, kind, [sourceField[kind]]: sourceId })
      .onConflictDoNothing({ target: sourceColumn[kind] });
    const [current] = await tx
      .select({ id: inboxStates.id, ...stateColumns })
      .from(inboxStates)
      .where(eq(sourceColumn[kind], sourceId))
      .for("update");
    const state = {
      read: input.read ?? current!.read,
      archived: input.archived ?? current!.archived,
    };
    if (state.read === current!.read && state.archived === current!.archived)
      return { kind: "updated" as const, state, event: null };
    await tx
      .update(inboxStates)
      .set({ ...state, updatedAt: new Date() })
      .where(eq(inboxStates.id, current!.id));
    const event = await insertEvent(tx, {
      organizationId,
      type: "inbox_item.updated",
      payload: { by: "owner", kind, sourceId, ...state },
    });
    return { kind: "updated" as const, state, event };
  });
}
