import type {
  InboxItem,
  InboxItemKind,
  InboxItemState,
  UpdateInboxItemInput,
} from "@babojubot/contracts";
import { inboxItemTime } from "@babojubot/contracts";
import { and, asc, eq, ne, or } from "drizzle-orm";
import { toApprovalSummary } from "./approvals.ts";
import type { Database } from "./client.ts";
import { refused, stored, type Stored } from "./stored.ts";
import { toResultSubmissionSummary } from "./results.ts";
import { insertEvent, isUuid, type Executor } from "./rows.ts";
import { runSummaryColumns, toRunSummary } from "./run-views.ts";
import {
  agents,
  approvals,
  inboxStates,
  organizations,
  resultSubmissions,
  runs,
} from "./schema.ts";

/**
 * 정리 상태. 정리한 적 없는 항목은 보관 안 함이고, 결정한 승인 요청·결과 제출이면 읽음(결정하려면 본다), 아니면 읽지 않음이다.
 * `updateInboxItem`이 처음 정리할 때 같은 기본값으로 행을 만든다.
 */
const stateOf = (
  row: { read: boolean | null; archived: boolean | null },
  decided: boolean
) => ({
  read: row.read ?? decided,
  archived: row.archived ?? false,
});
const stateColumns = { read: inboxStates.read, archived: inboxStates.archived };

/**
 * Inbox: 모든 조직의 승인 요청·결과 제출과 실패한 실행 시도, 각 항목의 읽음·보관. 오래된 것부터.
 * 승인 요청·결과 제출은 원본 기록에서 바로 읽으므로 알림 전송 여부와 상관없이 나오고, 결정한 뒤에도 결정 상태와 함께 남는다.
 * 중단된 조직의 결정을 기다리는 초기 연구 승인 요청·결과 제출은 결정을 받지 않으므로 빠진다(결정한 것은 남는다).
 * 작업자 추가 요청은 단계와 상관없이 결정하므로 남는다. 실패한 실행 시도는 실행 시도마다 남는다. 보관한 항목은 보관됨에 남는다.
 */
export async function listInbox(db: Database): Promise<InboxItem[]> {
  const approvalRows = await db
    .select({
      approval: approvals,
      organizationName: organizations.name,
      ...stateColumns,
    })
    .from(approvals)
    .innerJoin(organizations, eq(organizations.id, approvals.organizationId))
    .leftJoin(inboxStates, eq(inboxStates.approvalId, approvals.id))
    .where(
      or(
        ne(approvals.status, "pending"),
        eq(approvals.kind, "add_worker"),
        ne(organizations.stage, "stopped")
      )
    )
    .orderBy(asc(approvals.seq));
  const resultRows = await db
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
      or(
        ne(resultSubmissions.status, "pending"),
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
    ...approvalRows.map((row) => ({
      kind: "approval" as const,
      organizationName: row.organizationName,
      ...stateOf(row, row.approval.status !== "pending"),
      approval: toApprovalSummary(row.approval),
    })),
    ...resultRows.map((row) => ({
      kind: "result_submission" as const,
      organizationName: row.organizationName,
      ...stateOf(row, row.submission.status !== "pending"),
      submission: toResultSubmissionSummary(row.submission),
    })),
    ...failedRuns.map((row) => ({
      kind: "run_failure" as const,
      organizationName: row.organizationName,
      ...stateOf(row, false),
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

/**
 * 정리할 수 있는 원본: 그 조직의 승인 요청·결과 제출, 또는 그 조직의 실패한 실행 시도. 없으면 `null`이다.
 * `awaitsDecision`은 `pending`인 승인 요청·결과 제출인가다(실패한 실행 시도는 결정할 것이 없다).
 */
async function findSource(
  tx: Executor,
  organizationId: string,
  kind: InboxItemKind,
  sourceId: string
): Promise<{ awaitsDecision: boolean } | null> {
  const [row] =
    kind === "approval"
      ? await tx
          .select({ status: approvals.status })
          .from(approvals)
          .where(
            and(
              eq(approvals.organizationId, organizationId),
              eq(approvals.id, sourceId)
            )
          )
      : kind === "result_submission"
        ? await tx
            .select({ status: resultSubmissions.status })
            .from(resultSubmissions)
            .where(
              and(
                eq(resultSubmissions.organizationId, organizationId),
                eq(resultSubmissions.id, sourceId)
              )
            )
        : await tx
            .select({ status: runs.status })
            .from(runs)
            .where(
              and(
                eq(runs.organizationId, organizationId),
                eq(runs.id, sourceId),
                eq(runs.status, "failed")
              )
            );
  return row ? { awaitsDecision: row.status === "pending" } : null;
}

/**
 * 사용자의 알림 정리 명령. 준 값(읽음·보관)을 그대로 대입하고, 바뀌었으면 정리 뒤 상태로 `inbox_item.updated` Event를 남긴다.
 * 원본의 결정·단계·깨우기는 건드리지 않는다. 다른 조직의 원본과 없는 원본은 `not_found`다.
 * 결정을 기다리는 승인 요청·결과 제출을 보관하라는 명령은 아무것도 바꾸지 않고 `archive_not_allowed`다(contracts `canArchiveInboxItem`).
 * 결정은 다시 `pending`으로 돌아가지 않으므로, 동시에 결정이 일어나도 결정한 것으로 읽은 원본은 그대로 결정한 상태다.
 * 같은 항목의 동시 명령은 정리 상태 행 잠금으로 직렬화되어 서로의 값을 잃지 않는다.
 */
export async function updateInboxItem(
  db: Database,
  organizationId: string,
  kind: InboxItemKind,
  sourceId: string,
  input: UpdateInboxItemInput
): Promise<Stored<InboxItemState, "not_found" | "archive_not_allowed">> {
  if (!isUuid(organizationId) || !isUuid(sourceId)) return refused("not_found");
  return db.transaction(async (tx) => {
    // 조직·원본을 먼저 확인한다. 다른 조직의 원본과 없는 원본은 보관 여부와 상관없이 `not_found`다.
    const source = await findSource(tx, organizationId, kind, sourceId);
    if (!source) return refused("not_found");
    if (input.archived && source.awaitsDecision)
      return refused("archive_not_allowed");
    // 처음 정리하는 항목의 행은 목록이 보이던 기본값(`stateOf`)으로 만든다.
    await tx
      .insert(inboxStates)
      .values({
        organizationId,
        kind,
        [sourceField[kind]]: sourceId,
        read: kind !== "run_failure" && !source.awaitsDecision,
      })
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
      return stored(state);
    await tx
      .update(inboxStates)
      .set({ ...state, updatedAt: new Date() })
      .where(eq(inboxStates.id, current!.id));
    const event = await insertEvent(tx, {
      organizationId,
      type: "inbox_item.updated",
      payload: { by: "owner", kind, sourceId, ...state },
    });
    return stored(state, { events: [event] });
  });
}
