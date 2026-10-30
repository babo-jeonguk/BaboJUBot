import type {
  Approval,
  ApprovalSummary,
  DecideApprovalInput,
  Organization,
  RecordGoalInput,
  RequestInitialApprovalInput,
} from "@babojubot/contracts";
import {
  buildInitialResearchProposal,
  planApprovalDecision,
  planDecisionStage,
  planGoalRecord,
  planInitialApprovalRequest,
  type HarnessLibraryContents,
  type PendingApproval,
  type ProposalProblem,
  type ProviderChoiceProblem,
  type ProviderModels,
  type RecordSource,
} from "@babojubot/core";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { readProviderDefaults } from "./providers.ts";
import { refused, stored, type Stored } from "./stored.ts";
import { insertInstructionCopies } from "./harness.ts";
import {
  agentRow,
  agentNamesOf,
  insertEvent,
  isUuid,
  lockOrganization,
  toOrganization,
} from "./rows.ts";
import {
  agents,
  approvals,
  flowTemplates,
  organizations,
  wakes,
} from "./schema.ts";
import {
  toolWrite,
  type ActiveRunRef,
  type ToolCall,
  type ToolWrite,
} from "./tool-calls.ts";

// 목표 기록(예전 조직), 초기 연구 승인 요청과 승인 결정의 저장. 단계 전이는 모두 조직 행 잠금 아래에서 단계를 다시 확인하고,
// 결정은 `pending`인 요청에만 조건부로 적용해 한 번만 일어난다. 도메인 효과(단계·팀·사본·템플릿·깨우기·Event)는
// 결정과 같은 transaction에 저장하고, 알림과 실행 시도 촉진만 commit 뒤에 한다. 작업자 추가 요청은 workers.ts가 남긴다.

/** Lead의 목표·완료 기준 기록. 목표 없이 만든 예전 조직이 목표 설정에서 기록하면 계획 수립으로 넘어간다. */
export function recordGoal(
  db: Database,
  run: ActiveRunRef,
  input: RecordGoalInput,
  call: ToolCall
): Promise<ToolWrite<Organization, ProposalProblem>> {
  return toolWrite(db, run, "record_goal", call, async (tx, locked) => {
    const plan = planGoalRecord(locked, input);
    const [row] = await tx
      .update(organizations)
      .set({ ...input, stage: plan.stage })
      .where(eq(organizations.id, locked.organizationId))
      .returning();
    const event = await insertEvent(tx, plan.event);
    return { kind: "ok", value: toOrganization(row!), events: [event] };
  });
}

/**
 * Lead의 초기 연구 승인 요청. 지금의 하네스 라이브러리로 승인 대상 snapshot을 고정해 저장하고 조직을 승인 대기로 넘긴다.
 * Lead가 적은 프로바이더·모델은 호출한 쪽이 잠금 밖에서 받아 온 연결별 모델 목록(`connections`)으로 확인한다.
 * 같은 호출 키의 재시도는 이 확인 전에 저장된 결과를 받는다.
 * 반려·수정 요청 뒤의 재제출이면 직전 요청을 가리킨다.
 */
export function insertInitialApprovalRequest(
  db: Database,
  run: ActiveRunRef,
  input: RequestInitialApprovalInput,
  options: ToolCall & {
    library: HarnessLibraryContents;
    connections: ProviderModels;
    source: RecordSource;
  }
): Promise<ToolWrite<Approval, ProposalProblem>> {
  return toolWrite(
    db,
    run,
    "request_initial_approval",
    options,
    async (tx, locked, org) => {
      const proposal = buildInitialResearchProposal(
        org,
        input,
        options.library,
        {
          workerDefault: (await readProviderDefaults(tx)).workerDefault,
          connections: options.connections,
        }
      );
      if (typeof proposal === "string")
        return { kind: "invalid", problem: proposal };
      const [previous] = await tx
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.organizationId, locked.organizationId),
            eq(approvals.kind, "initial_research")
          )
        )
        .orderBy(desc(approvals.seq))
        .limit(1);
      const plan = planInitialApprovalRequest(
        locked,
        proposal,
        previous?.id ?? null,
        options.source
      );
      const [row] = await tx
        .insert(approvals)
        .values({
          ...plan.approval,
          status: "pending",
          createdAt: new Date(plan.approval.createdAt),
        })
        .returning();
      await tx
        .update(organizations)
        .set({ stage: plan.stage })
        .where(eq(organizations.id, locked.organizationId));
      const event = await insertEvent(tx, plan.event);
      return { kind: "ok", value: toApproval(row!), events: [event] };
    }
  );
}

export type DecisionRefusal =
  | "already_decided"
  | "decision_not_allowed"
  | "choices_mismatch"
  | ProviderChoiceProblem
  | "organization_closed"
  | "not_found";

/**
 * 사용자의 승인 결정 제어 명령. 조직 행을 잠근 뒤 결정을 기다리는 요청에만 조건부로 결정을 적용하고,
 * 단계·승인한 Lead 제안 완료 기준·작업자·각 작업자의 사본·조직 템플릿 사본·Lead 깨우기·Event를 같은 transaction에 저장한다.
 * 이미 결정한 요청은 같은 결정이라도 다시 적용하지 않는다. 다른 조직의 요청과 없는 요청은 같은 `not_found`다.
 * 그 종류에 없는 결정(작업자 추가의 수정 요청)은 `decision_not_allowed`, 생길 작업자 수와 다른 프로바이더·모델 목록은
 * `choices_mismatch`, 호출한 쪽이 잠금 밖에서 받아 온 연결별 모델 목록(`connections`)에 없는 값은 `unknown_provider`·`unknown_model`이며
 * 아무것도 남기지 않는다. 이미 결정한 요청은 이 확인 전에 `already_decided`다. 승인하면 작업자마다 정한 프로바이더·모델을 결정에 함께 남긴다.
 * 초기 연구 승인 결정은 단계를 바꾸므로, 일시정지 중이면 조직을 재개하며 결정하고 중단된 조직에서는 `organization_closed`다.
 * 작업자 추가 결정은 단계와 상관없이 받으며 일시정지를 풀지 않는다(#58).
 * commit 뒤에는 재개·결정 Event 순서로 알리고, 재개했으면 그 조직의 대기 깨우기를 다시 처리한 뒤 Lead를 깨운다.
 */
export async function decideApproval(
  db: Database,
  organizationId: string,
  approvalId: string,
  input: DecideApprovalInput,
  source: RecordSource,
  connections: ProviderModels = []
): Promise<Stored<Approval, DecisionRefusal>> {
  if (!isUuid(organizationId) || !isUuid(approvalId))
    return refused("not_found");
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return refused("not_found");
    const [current] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, organizationId),
          eq(approvals.id, approvalId)
        )
      );
    if (!current) return refused("not_found");
    if (current.status !== "pending") return refused("already_decided");
    const decisionStage = planDecisionStage(
      org,
      current.kind === "initial_research" ? "awaiting_approval" : null
    );
    if (decisionStage.kind === "organization_closed")
      return refused(decisionStage.kind);
    if (decisionStage.kind === "stage_mismatch")
      throw new Error(
        `pending approval ${approvalId} in an organization at ${org.stage}`
      );
    const resumed = decisionStage.resumed;

    // 저장할 때 `kind`에 맞는 내용만 넣으므로 행의 kind·proposal 짝이 PendingApproval의 짝이다(toApproval과 같음).
    const plan = planApprovalDecision(
      current as typeof current & PendingApproval,
      input,
      {
        stage: resumed ? "awaiting_approval" : org.stage,
        agentNames: await agentNamesOf(tx, organizationId),
        workerDefault: (await readProviderDefaults(tx)).workerDefault,
        connections,
      },
      source
    );
    if (typeof plan === "string") return refused(plan);
    const [decided] = await tx
      .update(approvals)
      .set({
        status: plan.status,
        decisionNote: plan.note,
        decidedWorkers: plan.decidedWorkers,
        decidedAt: new Date(plan.decidedAt),
      })
      .where(
        and(
          eq(approvals.organizationId, organizationId),
          eq(approvals.id, approvalId),
          eq(approvals.status, "pending")
        )
      )
      .returning();
    if (!decided)
      throw new Error(`approval ${approvalId} changed under the lock`);
    if (plan.workers.length)
      await tx.insert(agents).values(plan.workers.map(agentRow));
    await insertInstructionCopies(tx, plan.copies);
    if (plan.template)
      await tx.insert(flowTemplates).values({
        ...plan.template,
        createdAt: new Date(plan.template.createdAt),
      });
    await tx
      .update(organizations)
      .set({
        stage: plan.stage,
        ...(resumed ? { pausedFrom: null } : {}),
        ...(plan.completionCriteria
          ? { completionCriteria: plan.completionCriteria }
          : {}),
      })
      .where(eq(organizations.id, organizationId));
    await tx
      .insert(wakes)
      .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
    const events = [
      ...(resumed ? [await insertEvent(tx, resumed)] : []),
      await insertEvent(tx, plan.event),
    ];
    return stored(toApproval(decided), {
      events,
      ...(resumed ? { resumedOrganizationId: organizationId } : {}),
      woken: [plan.wake.agentId],
    });
  });
}

// ---------- Surface 조회 ----------

/** 조직의 승인 요청. 최근 것부터. */
export async function listApprovals(
  db: Database,
  organizationId: string
): Promise<ApprovalSummary[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.organizationId, organizationId))
    .orderBy(desc(approvals.seq));
  return rows.map(toApprovalSummary);
}

/** 승인 요청 상세. 다른 조직의 요청과 없는 요청을 구별하지 않는다. */
export async function findApproval(
  db: Database,
  organizationId: string,
  approvalId: string
): Promise<Approval | undefined> {
  if (!isUuid(organizationId) || !isUuid(approvalId)) return undefined;
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.organizationId, organizationId),
        eq(approvals.id, approvalId)
      )
    );
  return row && toApproval(row);
}

/** 승인 요청 행 → 계약. 저장할 때 `kind`에 맞는 내용만 넣으므로 둘의 짝은 행이 보장한다. */
const toApproval = ({
  seq: _seq,
  requestedByRunId: _run,
  createdAt,
  decidedAt,
  ...row
}: typeof approvals.$inferSelect): Approval =>
  ({
    ...row,
    createdAt: createdAt.toISOString(),
    decidedAt: decidedAt?.toISOString() ?? null,
  }) as Approval;

export const toApprovalSummary = (
  row: typeof approvals.$inferSelect
): ApprovalSummary => {
  const {
    proposal: _proposal,
    decisionNote: _note,
    decidedWorkers: _workers,
    ...summary
  } = toApproval(row);
  return summary;
};
