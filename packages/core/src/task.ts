import type {
  AgentRole,
  AgentToAgentMessage,
  Artifact,
  NewEvent,
  RecordArtifactInput,
  SendAgentToAgentMessageInput,
  Task,
  TaskComment,
  TaskReport,
  TaskStatus,
} from "@babojubot/contracts";
import type { RecordSource } from "./organization.ts";
import type { Wake } from "./run.ts";

// 같은 조직 안의 협력: 작업 생성·착수·완료, 작업 댓글, 산출물, 에이전트 간 메시지.
// 기록과 그 기록이 만든 깨우기·Event는 함께 저장해야 한다(ADR-0002). 같은 조직 참조인지는 저장 쪽이 확인한다.
// 자기 행동으로 자기 자신은 깨우지 않는다. 행동한 실행 시도가 이미 그 내용을 안다.

type RunRef = { id: string; organizationId: string; agentId: string };
type Actor = RunRef & { role: AgentRole };

/** 작업 규칙의 거부. 저장 쪽은 이 값을 그대로 도구 응답으로 옮긴다. */
export type TaskRuleProblem =
  "not_assignee" | "already_completed" | "invalid_transition";

/** 착수·완료 판단에 필요한 작업의 현재 상태. 부모 작업 담당자는 부모가 없으면 `null`이다. */
export type TaskState = {
  id: string;
  organizationId: string;
  title: string;
  status: TaskStatus;
  assigneeAgentId: string;
  createdByAgentId: string;
  parentAssigneeAgentId: string | null;
};

/** 작업 생성은 담당자를 깨운다. 담당자·부모 작업·연구 노드가 같은 조직인지는 저장 쪽이 확인한다. */
export function planTaskCreation(
  run: RunRef,
  input: {
    title: string;
    description: string;
    assigneeAgentId: string;
    parentTaskId?: string;
    researchNodeId?: string;
  },
  { newId, now }: RecordSource
): { task: Task; wake: Wake | undefined; event: NewEvent } {
  const createdAt = now().toISOString();
  const task: Task = {
    id: newId(),
    organizationId: run.organizationId,
    title: input.title,
    description: input.description,
    status: "open",
    assigneeAgentId: input.assigneeAgentId,
    parentTaskId: input.parentTaskId ?? null,
    researchNodeId: input.researchNodeId ?? null,
    createdByAgentId: run.agentId,
    createdByRunId: run.id,
    startedAt: null,
    report: null,
    createdAt,
  };
  const wake = wakeOther(run, task.assigneeAgentId, {
    id: newId(),
    organizationId: run.organizationId,
    agentId: task.assigneeAgentId,
    kind: "task_assigned",
    taskId: task.id,
    createdAt,
  });
  return {
    task,
    wake,
    event: {
      organizationId: run.organizationId,
      type: "task.created",
      payload: {
        taskId: task.id,
        runId: run.id,
        agentId: run.agentId,
        assigneeAgentId: task.assigneeAgentId,
        parentTaskId: task.parentTaskId,
        wokenAgentId: wake?.agentId ?? null,
      },
    },
  };
}

/** 담당자가 열린 작업에 착수한다. */
export function planTaskStart(
  actor: Actor,
  task: TaskState,
  { now }: Pick<RecordSource, "now">
): TaskRuleProblem | { startedAt: string; event: NewEvent } {
  if (actor.agentId !== task.assigneeAgentId) return "not_assignee";
  if (task.status !== "open") return "invalid_transition";
  return {
    startedAt: now().toISOString(),
    event: {
      organizationId: task.organizationId,
      type: "task.started",
      payload: { taskId: task.id, runId: actor.id, agentId: actor.agentId },
    },
  };
}

/** 완료가 깨우는 에이전트: 부모 작업이 있으면 그 담당자, 없으면 작업을 만든 에이전트. */
export const completionWakeTarget = (task: TaskState) =>
  task.parentAssigneeAgentId ?? task.createdByAgentId;

/**
 * 담당자 또는 Lead(조정)가 작업을 한 번 완료하고 자기 보고 요약을 남긴다. 완료마다 부모 작업 담당자를,
 * 부모가 없으면 작업을 만든 에이전트를 깨운다. 형제 작업이 끝나기를 기다리지 않는다.
 */
export function planTaskCompletion(
  actor: Actor,
  task: TaskState,
  summary: string,
  { newId, now }: RecordSource
):
  | TaskRuleProblem
  | { report: TaskReport; wake: Wake | undefined; event: NewEvent } {
  if (actor.agentId !== task.assigneeAgentId && actor.role !== "lead")
    return "not_assignee";
  if (task.status === "completed") return "already_completed";
  const completedAt = now().toISOString();
  const target = completionWakeTarget(task);
  const wake = wakeOther(actor, target, {
    id: newId(),
    organizationId: task.organizationId,
    agentId: target,
    kind: "task_completed",
    taskId: task.id,
    createdAt: completedAt,
  });
  return {
    report: { summary, agentId: actor.agentId, runId: actor.id, completedAt },
    wake,
    event: {
      organizationId: task.organizationId,
      type: "task.completed",
      payload: {
        taskId: task.id,
        runId: actor.id,
        agentId: actor.agentId,
        wokenAgentId: wake?.agentId ?? null,
      },
    },
  };
}

/**
 * 사용자의 작업 댓글은 그 작업 담당자를 깨운다. 완료된 작업이어도 깨우며, 댓글이 작업 상태를 바꾸지는 않는다.
 * 담당자가 실행 중이면 다음 실행 시도에 반영된다.
 */
export function planOwnerTaskComment(
  task: Pick<TaskState, "id" | "organizationId" | "assigneeAgentId">,
  body: string,
  { newId, now }: RecordSource
): { comment: TaskComment; wake: Wake; event: NewEvent } {
  const createdAt = now().toISOString();
  const comment: TaskComment = {
    id: newId(),
    organizationId: task.organizationId,
    taskId: task.id,
    author: "owner",
    agentId: null,
    runId: null,
    body,
    deliveredToRunId: null,
    createdAt,
  };
  return {
    comment,
    wake: {
      id: newId(),
      organizationId: task.organizationId,
      agentId: task.assigneeAgentId,
      kind: "task_comment",
      commentId: comment.id,
      createdAt,
    },
    event: commentedEvent(comment, task.assigneeAgentId),
  };
}

/** 에이전트의 작업 댓글. 사용자에게 답하는 통로이며 아무도 깨우지 않는다. */
export function planAgentTaskComment(
  run: RunRef,
  taskId: string,
  body: string,
  { newId, now }: RecordSource
): { comment: TaskComment; event: NewEvent } {
  const comment: TaskComment = {
    id: newId(),
    organizationId: run.organizationId,
    taskId,
    author: "agent",
    agentId: run.agentId,
    runId: run.id,
    body,
    deliveredToRunId: null,
    createdAt: now().toISOString(),
  };
  return { comment, event: commentedEvent(comment, null) };
}

/** 산출물 기록. 출처(작성 에이전트·실행 시도)는 실행 시도가 정한다. */
export function planArtifactRecord(
  run: RunRef,
  input: RecordArtifactInput,
  { newId, now }: RecordSource
): { artifact: Artifact; event: NewEvent } {
  const artifact: Artifact = {
    id: newId(),
    organizationId: run.organizationId,
    ...input,
    createdByAgentId: run.agentId,
    createdByRunId: run.id,
    createdAt: now().toISOString(),
  };
  return {
    artifact,
    event: {
      organizationId: run.organizationId,
      type: "artifact.recorded",
      payload: {
        artifactId: artifact.id,
        taskId: artifact.taskId,
        runId: run.id,
        agentId: run.agentId,
      },
    },
  };
}

/** 같은 조직 에이전트에게 보내는 메시지는 받는 에이전트를 깨운다. 자기 자신에게는 보낼 수 없다. */
export function planAgentToAgentMessage(
  run: RunRef,
  input: SendAgentToAgentMessageInput,
  { newId, now }: RecordSource
):
  | "self_message"
  | { message: AgentToAgentMessage; wake: Wake; event: NewEvent } {
  if (input.recipientAgentId === run.agentId) return "self_message";
  const createdAt = now().toISOString();
  const message: AgentToAgentMessage = {
    id: newId(),
    organizationId: run.organizationId,
    senderAgentId: run.agentId,
    senderRunId: run.id,
    recipientAgentId: input.recipientAgentId,
    body: input.body,
    createdAt,
  };
  return {
    message,
    wake: {
      id: newId(),
      organizationId: run.organizationId,
      agentId: message.recipientAgentId,
      kind: "agent_to_agent_message",
      agentToAgentMessageId: message.id,
      createdAt,
    },
    event: {
      organizationId: run.organizationId,
      type: "agent_to_agent_message.created",
      payload: {
        messageId: message.id,
        runId: run.id,
        agentId: run.agentId,
        recipientAgentId: message.recipientAgentId,
      },
    },
  };
}

const wakeOther = (actor: RunRef, target: string, wake: Wake) =>
  target === actor.agentId ? undefined : wake;

const commentedEvent = (
  comment: TaskComment,
  wokenAgentId: string | null
): NewEvent => ({
  organizationId: comment.organizationId,
  type: "task.commented",
  payload: {
    taskId: comment.taskId,
    commentId: comment.id,
    author: comment.author,
    agentId: comment.agentId,
    runId: comment.runId,
    wokenAgentId,
  },
});
