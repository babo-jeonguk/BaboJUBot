import type {
  AgentRole,
  Approval,
  ApprovalSummary,
  DecideApprovalInput,
  Event,
  InboxItem,
  Organization,
  OrgToolName,
  PublicActivity,
  RecordGoalInput,
  RequestInitialApprovalInput,
} from "@babojubot/contracts";
import {
  buildInitialResearchProposal,
  checkToolCall,
  planApprovalDecision,
  planGoalRecord,
  planInitialApprovalRequest,
  toolRefusedEvent,
  type HarnessLibraryContents,
  type ProposalProblem,
  type RecordSource,
  type ToolCheck,
  type Wake,
} from "@babojubot/core";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  instructionCopyRow,
  isUuid,
  lockOrganization,
  lockRunningRun,
  toOrganization,
  type Executor,
} from "./rows.ts";
import {
  agents,
  approvals,
  flowTemplates,
  instructionCopies,
  organizations,
  wakes,
} from "./schema.ts";

// 목표 기록, 초기 연구 승인 요청과 결정의 저장. 단계 전이는 모두 조직 행 잠금 아래에서 단계를 다시 확인하고,
// 결정은 `pending`인 요청에만 조건부로 적용해 한 번만 일어난다. 도메인 효과(단계·팀·사본·템플릿·깨우기·Event)는
// 결정과 같은 transaction에 저장하고, 알림과 실행 시도 촉진만 commit 뒤에 한다.

type ActiveRunRef = { id: string; agentRole: AgentRole };

export type GateResult = ToolCheck & { event?: Event };

/**
 * 조직 도구 호출 전의 Role·단계 검사. 거부하면 그 실행 시도에 귀속한 `tool.refused` Event를 남긴다.
 * 실행 시도가 이미 끝났으면 `undefined`. 단계를 바꾸는 도구는 저장할 때 잠금 아래에서 다시 검사한다.
 */
export async function gateToolCall(
  db: Database,
  run: ActiveRunRef,
  tool: OrgToolName
): Promise<GateResult | undefined> {
  return db.transaction(async (tx) => {
    const locked = await lockRunningRun(tx, run.id, "share");
    if (!locked) return undefined;
    const [org] = await tx
      .select({ stage: organizations.stage })
      .from(organizations)
      .where(eq(organizations.id, locked.organizationId));
    const check = checkToolCall(tool, {
      role: run.agentRole,
      stage: org!.stage,
    });
    if (check.ok) return check;
    const event = await insertEvent(
      tx,
      toolRefusedEvent(locked, tool, org!.stage, check.reason)
    );
    return { ...check, event };
  });
}

export type ToolWrite<T> =
  | { kind: "ok"; value: T; events: Event[] }
  | { kind: "run_finished" }
  | { kind: "refused"; reason: "role" | "stage"; events: Event[] }
  | { kind: "invalid"; problem: ProposalProblem };

/** 조직 도구 쓰기의 공통 틀: 실행 중인 실행 시도와 그 조직 행을 잠그고, 단계 규칙을 다시 확인한 뒤 쓴다. */
async function toolWrite<T>(
  db: Database,
  run: ActiveRunRef,
  tool: OrgToolName,
  activity: PublicActivity,
  write: (
    tx: Executor,
    locked: { id: string; organizationId: string; agentId: string },
    org: typeof organizations.$inferSelect
  ) => Promise<
    | { kind: "ok"; value: T; events: Event[] }
    | { kind: "invalid"; problem: ProposalProblem }
  >
): Promise<ToolWrite<T>> {
  return db.transaction(async (tx) => {
    const locked = await lockRunningRun(tx, run.id, "share");
    if (!locked) return { kind: "run_finished" };
    const org = (await lockOrganization(tx, locked.organizationId))!;
    const check = checkToolCall(tool, {
      role: run.agentRole,
      stage: org.stage,
    });
    if (!check.ok) {
      const event = await insertEvent(
        tx,
        toolRefusedEvent(locked, tool, org.stage, check.reason)
      );
      return { kind: "refused", reason: check.reason, events: [event] };
    }
    const result = await write(tx, locked, org);
    if (result.kind !== "ok") return result;
    const summary = await insertEvent(tx, {
      organizationId: locked.organizationId,
      type: "run.activity",
      payload: { runId: locked.id, agentId: locked.agentId, activity },
    });
    return { ...result, events: [...result.events, summary] };
  });
}

/** Lead의 목표·완료 기준 기록. 목표 설정에서 기록하면 계획 수립으로 넘어간다. */
export function recordGoal(
  db: Database,
  run: ActiveRunRef,
  input: RecordGoalInput,
  activity: PublicActivity
): Promise<ToolWrite<Organization>> {
  return toolWrite(db, run, "record_goal", activity, async (tx, locked) => {
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
 * 반려·수정 요청 뒤의 재제출이면 직전 요청을 가리킨다.
 */
export function insertInitialApprovalRequest(
  db: Database,
  run: ActiveRunRef,
  input: RequestInitialApprovalInput,
  options: {
    library: HarnessLibraryContents;
    source: RecordSource;
    activity: PublicActivity;
  }
): Promise<ToolWrite<Approval>> {
  return toolWrite(
    db,
    run,
    "request_initial_approval",
    options.activity,
    async (tx, locked, org) => {
      const proposal = buildInitialResearchProposal(
        org,
        input,
        options.library
      );
      if (typeof proposal === "string")
        return { kind: "invalid", problem: proposal };
      const [previous] = await tx
        .select({ id: approvals.id })
        .from(approvals)
        .where(eq(approvals.organizationId, locked.organizationId))
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

export type DecisionResult =
  | { kind: "decided"; approval: Approval; event: Event; wake: Wake }
  | { kind: "already_decided"; approval: Approval }
  | { kind: "not_found" };

/**
 * 사용자의 승인 결정 제어 명령. 조직 행을 잠근 뒤 결정을 기다리는 요청에만 조건부로 결정을 적용하고,
 * 단계·작업자·각 작업자의 사본·조직 템플릿 사본·Lead 깨우기·Event를 같은 transaction에 저장한다.
 * 이미 결정한 요청은 같은 결정이라도 다시 적용하지 않는다. 다른 조직의 요청과 없는 요청은 같은 `not_found`다.
 */
export async function decideApproval(
  db: Database,
  organizationId: string,
  approvalId: string,
  input: DecideApprovalInput,
  source: RecordSource
): Promise<DecisionResult> {
  if (!isUuid(organizationId) || !isUuid(approvalId))
    return { kind: "not_found" };
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) return { kind: "not_found" };
    const [current] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, organizationId),
          eq(approvals.id, approvalId)
        )
      );
    if (!current) return { kind: "not_found" };
    if (current.status !== "pending")
      return { kind: "already_decided", approval: toApproval(current) };
    if (org.stage !== "awaiting_approval")
      throw new Error(
        `pending approval ${approvalId} in an organization at ${org.stage}`
      );

    const plan = planApprovalDecision(current, input, source);
    const [decided] = await tx
      .update(approvals)
      .set({
        status: plan.status,
        decisionNote: plan.note,
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
      await tx
        .insert(agents)
        .values(
          plan.workers.map((a) => ({ ...a, createdAt: new Date(a.createdAt) }))
        );
    if (plan.copies.length)
      await tx
        .insert(instructionCopies)
        .values(plan.copies.map(instructionCopyRow));
    if (plan.template)
      await tx.insert(flowTemplates).values({
        ...plan.template,
        createdAt: new Date(plan.template.createdAt),
      });
    await tx
      .update(organizations)
      .set({ stage: plan.stage })
      .where(eq(organizations.id, organizationId));
    await tx
      .insert(wakes)
      .values({ ...plan.wake, createdAt: new Date(plan.wake.createdAt) });
    const event = await insertEvent(tx, plan.event);
    return {
      kind: "decided",
      approval: toApproval(decided),
      event,
      wake: plan.wake,
    };
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

/** Inbox: 모든 조직에서 결정을 기다리는 승인 요청. 오래된 것부터. */
export async function listInbox(db: Database): Promise<InboxItem[]> {
  const rows = await db
    .select({ approval: approvals, organizationName: organizations.name })
    .from(approvals)
    .innerJoin(organizations, eq(organizations.id, approvals.organizationId))
    .where(eq(approvals.status, "pending"))
    .orderBy(asc(approvals.seq));
  return rows.map(({ approval, organizationName }) => ({
    kind: "approval",
    organizationName,
    approval: toApprovalSummary(approval),
  }));
}

const toApproval = ({
  seq: _seq,
  requestedByRunId: _run,
  createdAt,
  decidedAt,
  ...row
}: typeof approvals.$inferSelect): Approval => ({
  ...row,
  createdAt: createdAt.toISOString(),
  decidedAt: decidedAt?.toISOString() ?? null,
});

const toApprovalSummary = (
  row: typeof approvals.$inferSelect
): ApprovalSummary => {
  const {
    proposal: _proposal,
    decisionNote: _note,
    ...summary
  } = toApproval(row);
  return summary;
};
