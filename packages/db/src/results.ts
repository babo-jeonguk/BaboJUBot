import type {
  ArtifactSummary,
  DecideResultInput,
  Event,
  PublicActivity,
  ResultSubmission,
  ResultSubmissionSummary,
  SubmitResultInput,
} from "@babojubot/contracts";
import {
  planDecisionStage,
  planResultDecision,
  planResultSubmission,
  type RecordSource,
  type Wake,
} from "@babojubot/core";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  artifactSummaryColumns,
  insertEvent,
  isUuid,
  lockOrganization,
  withIsoTime,
  type Executor,
} from "./rows.ts";
import {
  artifacts,
  organizations,
  resultSubmissionArtifacts,
  resultSubmissions,
  wakes,
} from "./schema.ts";
import { toolWrite, type ActiveRunRef, type ToolWrite } from "./tool-calls.ts";

// 결과 제출과 사용자의 결과 검토 결정의 저장. 단계 전이는 모두 조직 행 잠금 아래에서 단계를 다시 확인하고,
// 결정은 `pending`인 제출에만 조건부로 적용해 한 번만 일어난다. 제출·결정과 그 효과(단계·근거 산출물·Lead 깨우기·Event)는
// 같은 transaction에 저장하고, 알림과 실행 시도 촉진만 commit 뒤에 한다.

/**
 * Lead의 결과 제출. 근거 산출물이 모두 이 조직의 산출물이어야 하며(다른 조직의 것과 없는 것은 같은 `not_found`),
 * 지금 조직의 목표·완료 기준을 검토 기준으로 고정해 저장하고 조직을 결과 검토 중으로 넘긴다.
 * 수정 요청 뒤의 재제출이면 직전 제출을 가리킨다.
 */
export function submitResult(
  db: Database,
  run: ActiveRunRef,
  input: SubmitResultInput,
  { source, activity }: { source: RecordSource; activity: PublicActivity }
): Promise<ToolWrite<ResultSubmission, "not_found">> {
  return toolWrite(
    db,
    run,
    "submit_result",
    activity,
    async (tx, locked, org) => {
      const found = await selectArtifactSummaries(
        tx,
        locked.organizationId,
        input.artifactIds
      );
      if (found.length !== input.artifactIds.length)
        return { kind: "invalid", problem: "not_found" };
      const [previous] = await tx
        .select({ id: resultSubmissions.id })
        .from(resultSubmissions)
        .where(eq(resultSubmissions.organizationId, locked.organizationId))
        .orderBy(desc(resultSubmissions.seq))
        .limit(1);
      const plan = planResultSubmission(
        locked,
        org,
        input,
        previous?.id ?? null,
        source
      );
      const { artifactIds, ...submission } = plan.submission;
      const [row] = await tx
        .insert(resultSubmissions)
        .values({
          ...submission,
          status: "pending",
          createdAt: new Date(submission.createdAt),
        })
        .returning();
      await tx.insert(resultSubmissionArtifacts).values(
        artifactIds.map((artifactId, position) => ({
          organizationId: locked.organizationId,
          submissionId: submission.id,
          artifactId,
          position,
        }))
      );
      await tx
        .update(organizations)
        .set({ stage: plan.stage })
        .where(eq(organizations.id, locked.organizationId));
      const event = await insertEvent(tx, plan.event);
      return {
        kind: "ok",
        value: toResultSubmission(row!, found),
        events: [event],
      };
    }
  );
}

/** 결정 결과. `resumed`면 일시정지 중이던 조직을 이 결정이 재개했고, `events`는 재개·결정 Event 순서다. */
export type ResultDecisionResult =
  | {
      kind: "decided";
      submission: ResultSubmission;
      events: Event[];
      wake: Wake | null;
      resumed: boolean;
    }
  | { kind: "already_decided"; submission: ResultSubmission }
  | { kind: "organization_closed" }
  | { kind: "not_found" };

/**
 * 사용자의 결과 검토 제어 명령(수정 요청·최종 완료). 조직 행을 잠근 뒤 결정을 기다리는 제출에만 조건부로 결정을 적용하고,
 * 단계·(수정 요청이면) Lead 깨우기·Event를 같은 transaction에 저장한다. 이미 결정한 제출은 같은 결정이라도
 * 다시 적용하지 않는다(재제출 뒤 옛 제출에 대한 결정도 여기서 거부된다). 다른 조직의 제출과 없는 제출은 같은 `not_found`다.
 * 일시정지 중이면 조직을 재개하며 결정하고(최종 완료는 곧바로 완료), 중단된 조직에서는 `organization_closed`다.
 */
export async function decideResult(
  db: Database,
  organizationId: string,
  submissionId: string,
  input: DecideResultInput,
  source: RecordSource
): Promise<ResultDecisionResult> {
  if (!isUuid(organizationId) || !isUuid(submissionId))
    return { kind: "not_found" };
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return { kind: "not_found" };
    const current = await selectSubmission(tx, organizationId, submissionId);
    if (!current) return { kind: "not_found" };
    if (current.status !== "pending")
      return { kind: "already_decided", submission: current };
    const decisionStage = planDecisionStage(org, "result_review");
    if (decisionStage.kind === "organization_closed")
      return { kind: decisionStage.kind };
    if (decisionStage.kind === "stage_mismatch")
      throw new Error(
        `pending result submission ${submissionId} in an organization at ${org.stage}`
      );
    const { resumed } = decisionStage;

    const plan = planResultDecision(current, input, source);
    const [decided] = await tx
      .update(resultSubmissions)
      .set({
        status: plan.status,
        decisionNote: plan.note,
        decidedAt: new Date(plan.decidedAt),
      })
      .where(
        and(
          eq(resultSubmissions.organizationId, organizationId),
          eq(resultSubmissions.id, submissionId),
          eq(resultSubmissions.status, "pending")
        )
      )
      .returning();
    if (!decided)
      throw new Error(
        `result submission ${submissionId} changed under the lock`
      );
    await tx
      .update(organizations)
      .set({ stage: plan.stage, ...(resumed ? { pausedFrom: null } : {}) })
      .where(eq(organizations.id, organizationId));
    if (plan.wake)
      await tx
        .insert(wakes)
        .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
    const events = [
      ...(resumed ? [await insertEvent(tx, resumed)] : []),
      await insertEvent(tx, plan.event),
    ];
    return {
      kind: "decided",
      submission: toResultSubmission(decided, current.artifacts),
      events,
      wake: plan.wake,
      resumed: resumed !== null,
    };
  });
}

// ---------- Surface 조회 ----------

/** 조직의 결과 제출. 최근 것부터. */
export async function listResultSubmissions(
  db: Database,
  organizationId: string
): Promise<ResultSubmissionSummary[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db
    .select()
    .from(resultSubmissions)
    .where(eq(resultSubmissions.organizationId, organizationId))
    .orderBy(desc(resultSubmissions.seq));
  return rows.map(toResultSubmissionSummary);
}

/** 결과 제출 상세. 다른 조직의 제출과 없는 제출을 구별하지 않는다. */
export async function findResultSubmission(
  db: Database,
  organizationId: string,
  submissionId: string
): Promise<ResultSubmission | undefined> {
  if (!isUuid(organizationId) || !isUuid(submissionId)) return undefined;
  return selectSubmission(db, organizationId, submissionId);
}

// ---------- 내부 ----------

async function selectSubmission(
  db: Executor,
  organizationId: string,
  submissionId: string
): Promise<ResultSubmission | undefined> {
  const [row] = await db
    .select()
    .from(resultSubmissions)
    .where(
      and(
        eq(resultSubmissions.organizationId, organizationId),
        eq(resultSubmissions.id, submissionId)
      )
    );
  if (!row) return undefined;
  const evidence = await db
    .select(artifactSummaryColumns)
    .from(resultSubmissionArtifacts)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.organizationId, resultSubmissionArtifacts.organizationId),
        eq(artifacts.id, resultSubmissionArtifacts.artifactId)
      )
    )
    .where(
      and(
        eq(resultSubmissionArtifacts.organizationId, organizationId),
        eq(resultSubmissionArtifacts.submissionId, submissionId)
      )
    )
    .orderBy(asc(resultSubmissionArtifacts.position));
  return toResultSubmission(row, evidence.map(withIsoTime));
}

/** 이 조직의 산출물 요약을 주어진 ID 순서대로. 다른 조직의 것과 없는 것은 빠진다. */
async function selectArtifactSummaries(
  db: Executor,
  organizationId: string,
  ids: string[]
): Promise<ArtifactSummary[]> {
  const rows = await db
    .select(artifactSummaryColumns)
    .from(artifacts)
    .where(
      and(
        eq(artifacts.organizationId, organizationId),
        inArray(artifacts.id, ids)
      )
    );
  const byId = new Map(rows.map((r) => [r.id, withIsoTime(r)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export const toResultSubmissionSummary = ({
  seq: _seq,
  summary: _summary,
  goal: _goal,
  completionCriteria: _criteria,
  decisionNote: _note,
  createdAt,
  decidedAt,
  ...row
}: typeof resultSubmissions.$inferSelect): ResultSubmissionSummary => ({
  ...row,
  createdAt: createdAt.toISOString(),
  decidedAt: decidedAt?.toISOString() ?? null,
});

const toResultSubmission = (
  row: typeof resultSubmissions.$inferSelect,
  evidence: ArtifactSummary[]
): ResultSubmission => ({
  ...toResultSubmissionSummary(row),
  summary: row.summary,
  goal: row.goal,
  completionCriteria: row.completionCriteria,
  decisionNote: row.decisionNote,
  artifacts: evidence,
});
