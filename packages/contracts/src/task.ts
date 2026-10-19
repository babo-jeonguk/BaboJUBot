import { z } from "zod";
import { messageAuthorSchema, messageBodyMaxLength } from "./message.ts";

// 작업·작업 댓글·산출물·에이전트 간 메시지. 같은 조직 안의 협력 기록이며, 조직·작성자·실행 시도는
// 입력이 아니라 실행 시도별 토큰(에이전트) 또는 경로(사용자)가 정한다.

const text = (max: number) => z.string().trim().min(1).max(max);
export const taskTitleMaxLength = 200;
export const taskDescriptionMaxLength = 20_000;
export const taskReportMaxLength = 4_000;
export const artifactTitleMaxLength = 200;
export const artifactContentMaxLength = 100_000;

/**
 * 작업 상태. 담당자가 착수하면 `in_progress`, 완료하면 `completed`이며 완료는 다시 바뀌지 않는다.
 * 실행 시도 상태를 작업 상태로 옮기지 않는다. 작업 완료는 자기 보고일 뿐 검증된 결과가 아니다.
 */
export const taskStatuses = ["open", "in_progress", "completed"] as const;
export const taskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** 작업 생성. 담당 에이전트와 부모 작업은 같은 조직의 기록이어야 한다. */
export const createTaskInputSchema = z.strictObject({
  title: text(taskTitleMaxLength),
  description: z.string().trim().max(taskDescriptionMaxLength).default(""),
  assigneeAgentId: z.uuid(),
  parentTaskId: z.uuid().optional(),
});
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;

/** 작업 착수. 담당자만 할 수 있다. */
export const startTaskInputSchema = z.strictObject({});

/** 작업 완료와 자기 보고 요약. 담당자와 Lead만 할 수 있다. */
export const completeTaskInputSchema = z.strictObject({
  summary: text(taskReportMaxLength),
});
export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;

/** 작업 댓글. 사용자 댓글은 그 작업 담당자를 깨운다. */
export const addTaskCommentInputSchema = z.strictObject({
  body: text(messageBodyMaxLength),
});
export type AddTaskCommentInput = z.infer<typeof addTaskCommentInputSchema>;

/** 산출물 형식. 첫 판은 본문을 그대로 저장하는 Markdown·일반 텍스트뿐이다. */
export const artifactFormats = ["markdown", "text"] as const;
export const artifactFormatSchema = z.enum(artifactFormats);
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

/** 산출물 기록. 연결 작업은 같은 조직의 작업이어야 한다. */
export const recordArtifactInputSchema = z.strictObject({
  taskId: z.uuid(),
  title: text(artifactTitleMaxLength),
  format: artifactFormatSchema,
  content: z.string().min(1).max(artifactContentMaxLength),
});
export type RecordArtifactInput = z.infer<typeof recordArtifactInputSchema>;

/** 같은 조직의 다른 에이전트에게 보내는 메시지. 받는 에이전트를 깨운다. */
export const sendAgentToAgentMessageInputSchema = z.strictObject({
  recipientAgentId: z.uuid(),
  body: text(messageBodyMaxLength),
});
export type SendAgentToAgentMessageInput = z.infer<
  typeof sendAgentToAgentMessageInputSchema
>;

const time = z.iso.datetime({ offset: true });

/** 작업 완료 때 완료한 에이전트가 남긴 자기 보고. 검증 결과나 최종 완료가 아니다. */
export const taskReportSchema = z.object({
  summary: z.string(),
  agentId: z.uuid(),
  runId: z.uuid(),
  completedAt: time,
});
export type TaskReport = z.infer<typeof taskReportSchema>;

export const taskSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  title: z.string(),
  description: z.string(),
  status: taskStatusSchema,
  assigneeAgentId: z.uuid(),
  parentTaskId: z.uuid().nullable(),
  createdByAgentId: z.uuid(),
  createdByRunId: z.uuid(),
  startedAt: time.nullable(),
  report: taskReportSchema.nullable(),
  createdAt: time,
});
export type Task = z.infer<typeof taskSchema>;
export const taskListSchema = z.array(taskSchema);

/**
 * 작업 댓글. 사용자 댓글은 받은 실행 시도(`deliveredToRunId`, 아직 없으면 다음 실행 시도 대기)를,
 * 에이전트 댓글은 쓴 에이전트·실행 시도를 가리킨다.
 */
export const taskCommentSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  taskId: z.uuid(),
  author: messageAuthorSchema,
  agentId: z.uuid().nullable(),
  runId: z.uuid().nullable(),
  body: z.string(),
  deliveredToRunId: z.uuid().nullable(),
  createdAt: time,
});
export type TaskComment = z.infer<typeof taskCommentSchema>;

/** 산출물. 출처(조직·연결 작업·작성 에이전트·실행 시도)는 서버가 정한다. 산출물이 있다고 결과가 확인된 것은 아니다. */
export const artifactSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  taskId: z.uuid(),
  title: z.string(),
  format: artifactFormatSchema,
  content: z.string(),
  createdByAgentId: z.uuid(),
  createdByRunId: z.uuid(),
  createdAt: time,
});
export type Artifact = z.infer<typeof artifactSchema>;
export const artifactSummarySchema = artifactSchema.omit({ content: true });
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

/** 작업 상세: 작업과 댓글 thread(오래된 것부터), 연결 산출물. */
export const taskDetailSchema = taskSchema.extend({
  comments: z.array(taskCommentSchema),
  artifacts: z.array(artifactSummarySchema),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/** 같은 조직 에이전트 사이의 메시지. 보낸 실행 시도를 가리킨다. */
export const agentToAgentMessageSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  senderAgentId: z.uuid(),
  senderRunId: z.uuid(),
  recipientAgentId: z.uuid(),
  body: z.string(),
  createdAt: time,
});
export type AgentToAgentMessage = z.infer<typeof agentToAgentMessageSchema>;
