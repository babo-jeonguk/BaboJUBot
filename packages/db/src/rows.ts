import type {
  Agent,
  Event,
  InstructionCopy,
  NewEvent,
  Organization,
  Task,
} from "@babojubot/contracts";
import { acceptsToolCalls } from "@babojubot/core";
import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  agents,
  artifacts,
  events,
  instructionCopies,
  organizations,
  runs,
  tasks,
} from "./schema.ts";

/** Database 또는 그 안의 transaction. */
export type Executor =
  Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Event를 저장한다. payload의 에이전트·실행 시도 귀속을 조회용 열로도 남긴다. */
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
  return toEvent(row!);
}

export const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** DB 행의 시각을 계약의 ISO 문자열로 바꾼다. */
export const withIsoTime = <T extends { createdAt: Date }>(row: T) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
export const toOrganization = (
  row: typeof organizations.$inferSelect
): Organization => withIsoTime(row);
export const toAgent = (row: typeof agents.$inferSelect): Agent =>
  withIsoTime(row);
export const toEvent = ({
  agentId: _agentId,
  runId: _runId,
  ...row
}: typeof events.$inferSelect): Event => withIsoTime(row) as Event;

/**
 * 실행 중인 실행 시도 행을 잠근다. 종료(`update`)와 도구 쓰기(`share`)가 이 잠금으로 직렬화되므로
 * 끝난 실행 시도의 토큰으로는 아무것도 남지 않는다. 실행 중이 아니면 `undefined`.
 */
export async function lockRunningRun(
  tx: Executor,
  runId: string,
  strength: "update" | "share"
) {
  const [run] = await tx
    .select({
      id: runs.id,
      organizationId: runs.organizationId,
      agentId: runs.agentId,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for(strength);
  return run && acceptsToolCalls(run.status) ? run : undefined;
}

/**
 * 조직 행을 `FOR NO KEY UPDATE`로 잠근다. 단계 전이는 모두 이 잠금 아래에서 단계를 다시 확인한다.
 * 다른 기록의 FK 확인(`KEY SHARE`)과는 부딪히지 않아 에이전트 행을 잠근 admission과 교착하지 않는다.
 */
export async function lockOrganization(tx: Executor, organizationId: string) {
  const [row] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("no key update");
  return row;
}

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
