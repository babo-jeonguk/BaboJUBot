import type {
  Agent,
  AgentHeartbeat,
  Event,
  InstructionCopy,
  NewEvent,
  Organization,
  Task,
} from "@babojubot/contracts";
import {
  acceptsToolCalls,
  notificationOf,
  type NewAgent,
  type RunCancellation,
} from "@babojubot/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  agents,
  artifacts,
  events,
  instructionCopies,
  notificationOutbox,
  organizations,
  runs,
  tasks,
  wakes,
} from "./schema.ts";

/** Database 또는 그 안의 transaction. */
export type Executor =
  Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Event를 저장한다. payload의 에이전트·실행 시도 귀속을 조회용 열로도 남긴다.
 * 알림을 쌓는 사건(core `notificationOf`)이면 같은 transaction에 알림 outbox 항목도 남긴다.
 */
export async function insertEvent(
  db: Executor,
  event: NewEvent
): Promise<Event> {
  const payload = event.payload as { agentId?: string; runId?: string | null };
  const [row] = await db
    .insert(events)
    .values({
      ...event,
      agentId: payload.agentId ?? null,
      runId: payload.runId ?? null,
    })
    .returning();
  const stored = toEvent(row!);
  const notification = notificationOf(stored);
  if (notification)
    await db.insert(notificationOutbox).values({
      organizationId: stored.organizationId,
      eventId: stored.id,
      ...notification,
    });
  return stored;
}

export const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** DB 행의 시각을 계약의 ISO 문자열로 바꾼다. */
export const withIsoTime = <T extends { createdAt: Date }>(row: T) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
export const toOrganization = ({
  addWorkerApproval,
  ...row
}: typeof organizations.$inferSelect): Organization => ({
  ...withIsoTime(row),
  approvalPolicy: { addWorker: addWorkerApproval },
});
export const organizationRow = ({
  approvalPolicy,
  ...organization
}: Organization): typeof organizations.$inferInsert => ({
  ...organization,
  addWorkerApproval: approvalPolicy.addWorker,
  createdAt: new Date(organization.createdAt),
});
export const toAgent = ({
  id,
  organizationId,
  role,
  name,
  createdAt,
}: typeof agents.$inferSelect): Agent =>
  withIsoTime({ id, organizationId, role, name, createdAt });
/** 새 에이전트 행. heartbeat는 꺼져 있고 간격은 Role의 기본 간격이다. */
export const agentRow = ({
  heartbeatMinutes,
  ...agent
}: NewAgent): typeof agents.$inferInsert => ({
  ...agent,
  heartbeatIntervalMinutes: heartbeatMinutes,
  heartbeatDefaultMinutes: heartbeatMinutes,
  createdAt: new Date(agent.createdAt),
});
export const toAgentHeartbeat = (
  row: typeof agents.$inferSelect
): AgentHeartbeat => ({
  enabled: row.heartbeatEnabled,
  intervalMinutes: row.heartbeatIntervalMinutes,
  roleDefaultMinutes: row.heartbeatDefaultMinutes,
  nextAt: row.heartbeatNextAt?.toISOString() ?? null,
});
export const toEvent = ({
  agentId: _agentId,
  runId: _runId,
  ...row
}: typeof events.$inferSelect): Event => withIsoTime(row) as Event;

/**
 * 조직 도구를 쓸 수 있는 실행 시도 행을 `FOR SHARE`로 잠근다. 종료와 취소 요청(`FOR UPDATE`)이 이 잠금으로 직렬화되므로
 * 끝났거나 취소를 요청받은 실행 시도의 토큰으로는 아무것도 남지 않는다. 쓸 수 없으면 `undefined`.
 */
export async function lockRunningRun(tx: Executor, runId: string) {
  const [run] = await tx
    .select({
      id: runs.id,
      organizationId: runs.organizationId,
      agentId: runs.agentId,
      status: runs.status,
      cancelReason: runs.cancelReason,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("share");
  return run && acceptsToolCalls(run) ? run : undefined;
}

/**
 * 조직 행을 `FOR NO KEY UPDATE`로 잠근다. 단계 전이는 모두 이 잠금 아래에서 단계를 다시 확인한다.
 * (Inbox 정리 상태·알림 outbox 행 잠금은 그 뒤에 다른 행을 기다리지 않는 마지막 잠금이라 이 순서 밖이다.)
 * 다른 기록의 FK 확인(`KEY SHARE`)과는 부딪히지 않는다. 행 잠금 순서는 어디서나 조직 → 에이전트 → 실행 시도다.
 * 실행 시도 admission은 같은 행을 `FOR SHARE`로 잠근 뒤 에이전트 행을 잠그고, 도구 쓰기는 이 잠금 뒤에 실행 시도 행을,
 * 제어 명령은 이 잠금 뒤에 취소할 실행 시도 행을 잠그므로 이 잠금 아래에서 다른 행을 기다려도 교착하지 않는다.
 */
export async function lockOrganization(tx: Executor, organizationId: string) {
  const [row] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("no key update");
  return row;
}

/**
 * 취소를 요청받지 않은 진행 중 실행 시도를 잠그고 ID를 돌려준다. 종료 저장이 먼저 잠갔으면 그 종료를 기다린 뒤
 * 끝난 실행 시도는 빼고 돌려준다(Read Committed의 재확인).
 */
export async function lockCancellableRuns(
  tx: Executor,
  where: ReturnType<typeof eq>
): Promise<string[]> {
  const rows = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(where, eq(runs.status, "running"), isNull(runs.cancelReason)))
    .orderBy(runs.seq)
    .for("update");
  return rows.map((r) => r.id);
}

/**
 * 에이전트의 진행 중 실행 시도를 잠그고 ID를 돌려준다. 취소 정리 중인 실행 시도도 끝날 때까지 진행 중이므로 포함한다.
 * `중단하고 반영`은 그 정리에 합류하고, 취소 사유는 `requestCancellation`이 처음 것을 그대로 둔다.
 */
export async function lockRunningRunOfAgent(
  tx: Executor,
  agentId: string
): Promise<string | null> {
  const [run] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")))
    .for("update");
  return run?.id ?? null;
}

/** 잠근 실행 시도에 취소 요청을 남긴다. 이미 요청받은 실행 시도는 처음 사유를 그대로 둔다. */
export async function requestCancellation(
  tx: Executor,
  cancellation: RunCancellation | null
) {
  if (!cancellation?.runIds.length) return;
  await tx
    .update(runs)
    .set({ cancelReason: cancellation.reason })
    .where(
      and(
        inArray(runs.id, cancellation.runIds),
        eq(runs.status, "running"),
        isNull(runs.cancelReason)
      )
    );
}

/**
 * 조직 안의 에이전트 행을 `FOR NO KEY UPDATE`로 잠근다. 실행 시도 행을 잠근 채 Event FK로 에이전트 행(KEY SHARE)을
 * 기다리는 쓰기와 교착하지 않는다. 다른 조직의 에이전트와 없는 에이전트는 `undefined`다.
 */
export async function lockAgent(
  tx: Executor,
  organizationId: string,
  agentId: string
) {
  const [agent] = await tx
    .select()
    .from(agents)
    .where(
      and(eq(agents.organizationId, organizationId), eq(agents.id, agentId))
    )
    .for("no key update");
  return agent;
}

/** 아직 실행 시도가 받지 않은 heartbeat 깨우기가 있는가. 에이전트마다 하나뿐이다(부분 unique). */
export async function hasPendingHeartbeat(tx: Executor, agentId: string) {
  const [pending] = await tx
    .select({ id: wakes.id })
    .from(wakes)
    .where(
      and(
        eq(wakes.agentId, agentId),
        eq(wakes.kind, "heartbeat"),
        isNull(wakes.runId)
      )
    );
  return pending !== undefined;
}

/** 조직 에이전트의 이름. 새 작업자 번호를 정할 때 쓴다. */
export const agentNamesOf = async (tx: Executor, organizationId: string) =>
  (
    await tx
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.organizationId, organizationId))
  ).map((a) => a.name);

export const instructionCopyRow = (copy: InstructionCopy) => ({
  ...copy,
  createdAt: new Date(copy.createdAt),
});
export const toInstructionCopy = ({
  seq: _seq,
  ...row
}: typeof instructionCopies.$inferSelect): InstructionCopy => withIsoTime(row);

export const toTask = (row: typeof tasks.$inferSelect): Task => ({
  id: row.id,
  organizationId: row.organizationId,
  title: row.title,
  description: row.description,
  status: row.status,
  assigneeAgentId: row.assigneeAgentId,
  parentTaskId: row.parentTaskId,
  researchNodeId: row.researchNodeId,
  createdByAgentId: row.createdByAgentId,
  createdByRunId: row.createdByRunId,
  startedAt: row.startedAt?.toISOString() ?? null,
  report:
    row.completedAt &&
    row.reportSummary !== null &&
    row.completedByAgentId &&
    row.completedByRunId
      ? {
          summary: row.reportSummary,
          agentId: row.completedByAgentId,
          runId: row.completedByRunId,
          completedAt: row.completedAt.toISOString(),
        }
      : null,
  createdAt: row.createdAt.toISOString(),
});

/** 산출물 요약(본문 제외) 열. */
export const artifactSummaryColumns = {
  id: artifacts.id,
  organizationId: artifacts.organizationId,
  taskId: artifacts.taskId,
  title: artifacts.title,
  format: artifacts.format,
  createdByAgentId: artifacts.createdByAgentId,
  createdByRunId: artifacts.createdByRunId,
  createdAt: artifacts.createdAt,
};
