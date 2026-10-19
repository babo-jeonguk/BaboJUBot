import type {
  AgentToAgentMessage,
  Artifact,
  ArtifactSummary,
  CreateTaskInput,
  Event,
  PublicActivity,
  RecordArtifactInput,
  SendAgentToAgentMessageInput,
  Task,
  TaskComment,
  TaskDetail,
} from "@babojubot/contracts";
import {
  planAgentTaskComment,
  planAgentToAgentMessage,
  planArtifactRecord,
  planOwnerTaskComment,
  planTaskCompletion,
  planTaskCreation,
  planTaskStart,
  type RecordSource,
  type TaskRuleProblem,
  type TaskState,
  type Wake,
} from "@babojubot/core";
import { and, asc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./client.ts";
import { insertEvent, isUuid, type Executor } from "./rows.ts";
import {
  agentToAgentMessages,
  agents,
  artifacts,
  taskComments,
  tasks,
  wakes,
} from "./schema.ts";
import { toolWrite, type ActiveRunRef, type ToolWrite } from "./tool-calls.ts";

// 작업·작업 댓글·산출물·에이전트 간 메시지의 저장. 도구 쓰기는 모두 `toolWrite`의 실행 시도 → 조직 잠금 아래에서
// 같은 조직 참조를 확인하고, 기록·깨우기·Event를 한 transaction에 남긴다. 다른 조직의 기록과 없는 기록은 같은 `not_found`다.

type WriteOptions = { source: RecordSource; activity: PublicActivity };

/** 작업 생성. 담당 에이전트와 부모 작업이 이 조직의 기록이어야 하며, 담당자를 깨운다. */
export function createTask(
  db: Database,
  run: ActiveRunRef,
  input: Required<Omit<CreateTaskInput, "parentTaskId">> &
    Pick<CreateTaskInput, "parentTaskId">,
  { source, activity }: WriteOptions
): Promise<ToolWrite<Task, "not_found">> {
  return toolWrite(db, run, "create_task", activity, async (tx, locked) => {
    const orgId = locked.organizationId;
    if (!(await agentInOrganization(tx, orgId, input.assigneeAgentId)))
      return { kind: "invalid", problem: "not_found" };
    if (
      input.parentTaskId &&
      !(await selectTask(tx, orgId, input.parentTaskId))
    )
      return { kind: "invalid", problem: "not_found" };
    const plan = planTaskCreation(locked, input, source);
    await tx.insert(tasks).values(taskRow(plan.task));
    if (plan.wake) await insertWake(tx, plan.wake);
    const event = await insertEvent(tx, plan.event);
    return {
      kind: "ok",
      value: plan.task,
      events: [event],
      woken: wokenBy(plan.wake),
    };
  });
}

/** 담당자의 작업 착수. */
export function startTask(
  db: Database,
  run: ActiveRunRef,
  taskId: string,
  { source, activity }: WriteOptions
): Promise<ToolWrite<Task, "not_found" | TaskRuleProblem>> {
  return toolWrite(db, run, "start_task", activity, async (tx, locked) => {
    const state = await selectTaskState(tx, locked.organizationId, taskId);
    if (!state) return { kind: "invalid", problem: "not_found" };
    const plan = planTaskStart(locked, state, source);
    if (typeof plan === "string") return { kind: "invalid", problem: plan };
    const [row] = await tx
      .update(tasks)
      .set({ status: "in_progress", startedAt: new Date(plan.startedAt) })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "open")))
      .returning();
    if (!row) throw new Error(`task ${taskId} changed under the lock`);
    const event = await insertEvent(tx, plan.event);
    return { kind: "ok", value: toTask(row), events: [event] };
  });
}

/**
 * 작업 완료와 자기 보고. 담당자와 Lead만 완료할 수 있고 완료는 한 번뿐이다. 완료와 깨우기(부모 작업 담당자,
 * 부모가 없으면 작업을 만든 에이전트)·Event를 같은 transaction에 저장하며, 조건부 갱신이 중복 완료를 막는다.
 */
export function completeTask(
  db: Database,
  run: ActiveRunRef,
  taskId: string,
  summary: string,
  { source, activity }: WriteOptions
): Promise<ToolWrite<Task, "not_found" | TaskRuleProblem>> {
  return toolWrite(db, run, "complete_task", activity, async (tx, locked) => {
    const state = await selectTaskState(tx, locked.organizationId, taskId);
    if (!state) return { kind: "invalid", problem: "not_found" };
    const plan = planTaskCompletion(locked, state, summary, source);
    if (typeof plan === "string") return { kind: "invalid", problem: plan };
    const [row] = await tx
      .update(tasks)
      .set({
        status: "completed",
        reportSummary: plan.report.summary,
        completedByAgentId: plan.report.agentId,
        completedByRunId: plan.report.runId,
        completedAt: new Date(plan.report.completedAt),
      })
      .where(and(eq(tasks.id, taskId), ne(tasks.status, "completed")))
      .returning();
    if (!row) throw new Error(`task ${taskId} changed under the lock`);
    if (plan.wake) await insertWake(tx, plan.wake);
    const event = await insertEvent(tx, plan.event);
    return {
      kind: "ok",
      value: toTask(row),
      events: [event],
      woken: wokenBy(plan.wake),
    };
  });
}

/** 에이전트의 작업 댓글. 아무도 깨우지 않는다. */
export function commentTask(
  db: Database,
  run: ActiveRunRef,
  taskId: string,
  body: string,
  { source, activity }: WriteOptions
): Promise<ToolWrite<TaskComment, "not_found">> {
  return toolWrite(db, run, "comment_task", activity, async (tx, locked) => {
    if (!(await selectTask(tx, locked.organizationId, taskId)))
      return { kind: "invalid", problem: "not_found" };
    const plan = planAgentTaskComment(locked, taskId, body, source);
    await tx.insert(taskComments).values(commentRow(plan.comment));
    const event = await insertEvent(tx, plan.event);
    return { kind: "ok", value: plan.comment, events: [event] };
  });
}

/** 산출물 기록. 연결 작업이 이 조직의 작업이어야 한다. */
export function recordArtifact(
  db: Database,
  run: ActiveRunRef,
  input: RecordArtifactInput,
  { source, activity }: WriteOptions
): Promise<ToolWrite<Artifact, "not_found">> {
  return toolWrite(db, run, "record_artifact", activity, async (tx, locked) => {
    if (!(await selectTask(tx, locked.organizationId, input.taskId)))
      return { kind: "invalid", problem: "not_found" };
    const plan = planArtifactRecord(locked, input, source);
    await tx.insert(artifacts).values({
      ...plan.artifact,
      createdAt: new Date(plan.artifact.createdAt),
    });
    const event = await insertEvent(tx, plan.event);
    return { kind: "ok", value: plan.artifact, events: [event] };
  });
}

/** 같은 조직 에이전트에게 메시지를 보내고 그 에이전트를 깨운다. */
export function sendAgentToAgentMessage(
  db: Database,
  run: ActiveRunRef,
  input: SendAgentToAgentMessageInput,
  { source, activity }: WriteOptions
): Promise<ToolWrite<AgentToAgentMessage, "not_found" | "self_message">> {
  return toolWrite(db, run, "message_agent", activity, async (tx, locked) => {
    if (
      !(await agentInOrganization(
        tx,
        locked.organizationId,
        input.recipientAgentId
      ))
    )
      return { kind: "invalid", problem: "not_found" };
    const plan = planAgentToAgentMessage(locked, input, source);
    if (typeof plan === "string") return { kind: "invalid", problem: plan };
    await tx
      .insert(agentToAgentMessages)
      .values({ ...plan.message, createdAt: new Date(plan.message.createdAt) });
    await insertWake(tx, plan.wake);
    const event = await insertEvent(tx, plan.event);
    return {
      kind: "ok",
      value: plan.message,
      events: [event],
      woken: wokenBy(plan.wake),
    };
  });
}

export type OwnerCommentResult =
  | { kind: "ok"; comment: TaskComment; event: Event; wake: Wake }
  | { kind: "not_found" };

/**
 * 사용자의 작업 댓글. 댓글·담당자 깨우기·Event를 한 transaction으로 저장한다. 완료된 작업에도 남길 수 있으며
 * 작업 상태는 바꾸지 않는다. 다른 조직의 작업과 없는 작업은 같은 `not_found`다.
 */
export async function insertOwnerTaskComment(
  db: Database,
  organizationId: string,
  taskId: string,
  body: string,
  source: RecordSource
): Promise<OwnerCommentResult> {
  if (!isUuid(organizationId) || !isUuid(taskId)) return { kind: "not_found" };
  return db.transaction(async (tx) => {
    const task = await selectTask(tx, organizationId, taskId);
    if (!task) return { kind: "not_found" };
    const plan = planOwnerTaskComment(task, body, source);
    await tx.insert(taskComments).values(commentRow(plan.comment));
    await insertWake(tx, plan.wake);
    const event = await insertEvent(tx, plan.event);
    return { kind: "ok", comment: plan.comment, event, wake: plan.wake };
  });
}

// ---------- 조회 ----------

/** 조직의 작업. 만든 순서대로. */
export async function listTasks(
  db: Executor,
  organizationId: string
): Promise<Task[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.organizationId, organizationId))
    .orderBy(asc(tasks.seq));
  return rows.map(toTask);
}

/** 작업 상세: 댓글 thread와 연결 산출물. 다른 조직의 작업과 없는 작업을 구별하지 않는다. */
export async function findTaskDetail(
  db: Executor,
  organizationId: string,
  taskId: string
): Promise<TaskDetail | undefined> {
  const task = await selectTask(db, organizationId, taskId);
  if (!task) return undefined;
  const comments = await db
    .select({ comment: taskComments, deliveredToRunId: wakes.runId })
    .from(taskComments)
    .leftJoin(wakes, eq(wakes.commentId, taskComments.id))
    .where(
      and(
        eq(taskComments.organizationId, organizationId),
        eq(taskComments.taskId, taskId)
      )
    )
    .orderBy(asc(taskComments.seq));
  const linked = await db
    .select(artifactSummaryColumns)
    .from(artifacts)
    .where(
      and(
        eq(artifacts.organizationId, organizationId),
        eq(artifacts.taskId, taskId)
      )
    )
    .orderBy(asc(artifacts.seq));
  return {
    ...task,
    comments: comments.map(
      ({
        comment: { seq: _seq, createdAt, ...comment },
        deliveredToRunId,
      }) => ({
        ...comment,
        deliveredToRunId,
        createdAt: createdAt.toISOString(),
      })
    ),
    artifacts: linked.map(({ createdAt, ...a }): ArtifactSummary => ({
      ...a,
      createdAt: createdAt.toISOString(),
    })),
  };
}

/** 산출물 하나. 다른 조직의 산출물과 없는 산출물을 구별하지 않는다. */
export async function findArtifact(
  db: Executor,
  organizationId: string,
  artifactId: string
): Promise<Artifact | undefined> {
  if (!isUuid(organizationId) || !isUuid(artifactId)) return undefined;
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.organizationId, organizationId),
        eq(artifacts.id, artifactId)
      )
    );
  if (!row) return undefined;
  const { seq: _seq, createdAt, ...artifact } = row;
  return { ...artifact, createdAt: createdAt.toISOString() };
}

// ---------- 내부 ----------

async function agentInOrganization(
  db: Executor,
  organizationId: string,
  agentId: string
) {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.organizationId, organizationId), eq(agents.id, agentId))
    );
  return row !== undefined;
}

async function selectTask(
  db: Executor,
  organizationId: string,
  taskId: string
): Promise<Task | undefined> {
  if (!isUuid(organizationId) || !isUuid(taskId)) return undefined;
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));
  return row && toTask(row);
}

const parentTasks = alias(tasks, "parent_task");

/** 착수·완료 판단에 필요한 작업 상태와 부모 작업 담당자. */
async function selectTaskState(
  db: Executor,
  organizationId: string,
  taskId: string
): Promise<TaskState | undefined> {
  if (!isUuid(taskId)) return undefined;
  const [row] = await db
    .select({
      id: tasks.id,
      organizationId: tasks.organizationId,
      title: tasks.title,
      status: tasks.status,
      assigneeAgentId: tasks.assigneeAgentId,
      createdByAgentId: tasks.createdByAgentId,
      parentAssigneeAgentId: parentTasks.assigneeAgentId,
    })
    .from(tasks)
    .leftJoin(
      parentTasks,
      and(
        eq(parentTasks.organizationId, tasks.organizationId),
        eq(parentTasks.id, tasks.parentTaskId)
      )
    )
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));
  return row;
}

const insertWake = (tx: Executor, wake: Wake) =>
  tx.insert(wakes).values({ ...wake, createdAt: new Date(wake.createdAt) });

const wokenBy = (wake: Wake | undefined) => (wake ? [wake.agentId] : []);

const taskRow = (task: Task) => ({
  id: task.id,
  organizationId: task.organizationId,
  title: task.title,
  description: task.description,
  status: task.status,
  assigneeAgentId: task.assigneeAgentId,
  parentTaskId: task.parentTaskId,
  createdByAgentId: task.createdByAgentId,
  createdByRunId: task.createdByRunId,
  createdAt: new Date(task.createdAt),
});

const toTask = (row: typeof tasks.$inferSelect): Task => ({
  id: row.id,
  organizationId: row.organizationId,
  title: row.title,
  description: row.description,
  status: row.status,
  assigneeAgentId: row.assigneeAgentId,
  parentTaskId: row.parentTaskId,
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

const commentRow = ({ deliveredToRunId: _delivered, ...c }: TaskComment) => ({
  ...c,
  createdAt: new Date(c.createdAt),
});

const artifactSummaryColumns = {
  id: artifacts.id,
  organizationId: artifacts.organizationId,
  taskId: artifacts.taskId,
  title: artifacts.title,
  format: artifacts.format,
  createdByAgentId: artifacts.createdByAgentId,
  createdByRunId: artifacts.createdByRunId,
  createdAt: artifacts.createdAt,
};
