import {
  agentRoles,
  approvalKinds,
  artifactFormats,
  approvalStatuses,
  instructionKinds,
  lifecycleStages,
  messageAuthors,
  messageDeliveries,
  runStatuses,
  taskStatuses,
  type FlowKind,
  type InitialResearchProposal,
  type NewEvent,
  type SessionState,
  type Usage,
  type WakeKind,
} from "@babojubot/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(", "));
const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull();
/** 테이블 전체의 저장 순서. 시각이 같아도 기록 순서를 지킨다. */
const sequence = () =>
  bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity();

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    stage: text("stage", { enum: lifecycleStages }).notNull(),
    /** Lead가 목표 설정에서 기록한다. 기록 전에는 없다. */
    goal: text("goal"),
    completionCriteria: text("completion_criteria"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check(
      "organizations_goal_check",
      sql`(${t.goal} is null) = (${t.completionCriteria} is null)`
    ),
    check(
      "organizations_stage_check",
      sql`${t.stage} in (${inList(lifecycleStages)})`
    ),
  ]
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    role: text("role", { enum: agentRoles }).notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("agents_role_check", sql`${t.role} in (${inList(agentRoles)})`),
    index("agents_organization_idx").on(t.organizationId),
    // 다른 기록이 (조직, 에이전트)로 참조해 다른 조직의 에이전트에 묶이지 않게 한다.
    unique("agents_organization_id_id_unique").on(t.organizationId, t.id),
    // 조직마다 전용 Research Lead는 하나뿐이다.
    uniqueIndex("agents_one_lead_per_organization")
      .on(t.organizationId)
      .where(sql`${t.role} = 'lead'`),
  ]
);

/**
 * 에이전트 소유 지침 사본(Role·Soul·Skill). 하네스 라이브러리에서 복사한 내용과 그 출처·digest를 둔다.
 * 사본은 에이전트마다 따로이며 같은 Role의 에이전트끼리도 행을 공유하지 않는다. 편집·revision은 #64.
 */
export const instructionCopies = pgTable(
  "instruction_copies",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: uuid("agent_id").notNull(),
    kind: text("kind", { enum: instructionKinds }).notNull(),
    path: text("path").notNull(),
    content: text("content").notNull(),
    source: text("source").notNull(),
    sourceDigest: text("source_digest").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "instruction_copies_kind_check",
      sql`${t.kind} in (${inList(instructionKinds)})`
    ),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    uniqueIndex("instruction_copies_agent_path_unique").on(t.agentId, t.path),
  ]
);

/**
 * 실행 시도. 에이전트당 실행 중인 실행 시도는 하나뿐이다(부분 unique). 토큰은 digest만 저장한다.
 * 묶은 깨우기는 wakes.run_id가 가리킨다.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: uuid("agent_id").notNull(),
    status: text("status", { enum: runStatuses }).notNull(),
    tokenDigest: text("token_digest").notNull().unique(),
    instructionsBundleVersion: text("instructions_bundle_version"),
    sessionBefore: jsonb("session_before").$type<SessionState>(),
    sessionAfter: jsonb("session_after").$type<SessionState>(),
    summary: text("summary"),
    error: text("error"),
    usage: jsonb("usage").$type<Usage>(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    check("runs_status_check", sql`${t.status} in (${inList(runStatuses)})`),
    check(
      "runs_finished_check",
      sql`(${t.status} = 'running') = (${t.finishedAt} is null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    unique("runs_organization_id_id_unique").on(t.organizationId, t.id),
    uniqueIndex("runs_one_running_per_agent")
      .on(t.agentId)
      .where(sql`${t.status} = 'running'`),
    index("runs_organization_agent_idx").on(t.organizationId, t.agentId, t.seq),
  ]
);

/** Lead 대화의 메시지. 사용자 메시지는 전달 방식을, 에이전트 메시지는 보낸 실행 시도를 갖는다. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: uuid("agent_id").notNull(),
    author: text("author", { enum: messageAuthors }).notNull(),
    body: text("body").notNull(),
    delivery: text("delivery", { enum: messageDeliveries }),
    sentByRunId: uuid("sent_by_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "messages_author_check",
      sql`${t.author} in (${inList(messageAuthors)})`
    ),
    check(
      "messages_delivery_check",
      sql`${t.delivery} in (${inList(messageDeliveries)})`
    ),
    check(
      "messages_origin_check",
      sql`(${t.author} = 'owner' and ${t.delivery} is not null and ${t.sentByRunId} is null)
        or (${t.author} = 'agent' and ${t.delivery} is null and ${t.sentByRunId} is not null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sentByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    unique("messages_organization_id_id_unique").on(t.organizationId, t.id),
    index("messages_conversation_idx").on(t.organizationId, t.agentId, t.seq),
  ]
);

/**
 * 승인 요청. 제안 내용은 제출 때 고정한 snapshot이고 다시 바뀌지 않는다. 결정은 `pending`에서 한 번만 하며,
 * 반려·수정 요청 뒤의 재제출은 직전 요청을 가리키는 새 행이다. 조직마다 결정을 기다리는 요청은 하나뿐이다.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind", { enum: approvalKinds }).notNull(),
    status: text("status", { enum: approvalStatuses }).notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").notNull(),
    requestedByRunId: uuid("requested_by_run_id").notNull(),
    previousApprovalId: uuid("previous_approval_id"),
    proposal: jsonb("proposal").$type<InitialResearchProposal>().notNull(),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("approvals_kind_check", sql`${t.kind} in (${inList(approvalKinds)})`),
    check(
      "approvals_status_check",
      sql`${t.status} in (${inList(approvalStatuses)})`
    ),
    check(
      "approvals_decided_check",
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.requestedByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.requestedByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.previousApprovalId],
      foreignColumns: [t.organizationId, t.id],
    }),
    unique("approvals_organization_id_id_unique").on(t.organizationId, t.id),
    uniqueIndex("approvals_one_pending_per_organization")
      .on(t.organizationId)
      .where(sql`${t.status} = 'pending'`),
    index("approvals_organization_idx").on(t.organizationId, t.seq),
  ]
);

/** 조직이 소유한 연구 흐름 템플릿 사본. 초기 연구 승인 때 승인한 snapshot에서 한 번 만든다. */
export const flowTemplates = pgTable(
  "flow_templates",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id)
      .unique(),
    approvalId: uuid("approval_id").notNull(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    nodeKinds: jsonb("node_kinds").$type<FlowKind[]>().notNull(),
    linkKinds: jsonb("link_kinds").$type<FlowKind[]>().notNull(),
    source: text("source").notNull(),
    sourceDigest: text("source_digest").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
  ]
);

/**
 * 작업. 담당·부모·생성·완료 참조는 모두 같은 조직의 기록이다(복합 FK). 완료하면 자기 보고(요약·완료한 에이전트·실행 시도·시각)가
 * 함께 남고, 완료는 다시 바뀌지 않는다(저장 쪽 조건부 갱신).
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status", { enum: taskStatuses }).notNull(),
    assigneeAgentId: uuid("assignee_agent_id").notNull(),
    parentTaskId: uuid("parent_task_id"),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    createdByRunId: uuid("created_by_run_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    reportSummary: text("report_summary"),
    completedByAgentId: uuid("completed_by_agent_id"),
    completedByRunId: uuid("completed_by_run_id"),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    check("tasks_status_check", sql`${t.status} in (${inList(taskStatuses)})`),
    check(
      "tasks_report_check",
      sql`(${t.status} = 'completed') = (${t.completedAt} is not null)
        and num_nulls(${t.completedAt}, ${t.reportSummary}, ${t.completedByAgentId}, ${t.completedByRunId}) in (0, 4)`
    ),
    check(
      "tasks_started_check",
      sql`(${t.status} <> 'open' or ${t.startedAt} is null)
        and (${t.status} <> 'in_progress' or ${t.startedAt} is not null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.assigneeAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.parentTaskId],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.completedByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.completedByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    unique("tasks_organization_id_id_unique").on(t.organizationId, t.id),
    index("tasks_organization_idx").on(t.organizationId, t.seq),
  ]
);

/** 작업 댓글. 사용자 댓글은 작성 에이전트·실행 시도가 없고, 에이전트 댓글은 둘 다 있다. */
export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: uuid("task_id").notNull(),
    author: text("author", { enum: messageAuthors }).notNull(),
    agentId: uuid("agent_id"),
    runId: uuid("run_id"),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "task_comments_author_check",
      sql`(${t.author} = 'owner' and ${t.agentId} is null and ${t.runId} is null)
        or (${t.author} = 'agent' and ${t.agentId} is not null and ${t.runId} is not null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    unique("task_comments_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
    index("task_comments_task_idx").on(t.organizationId, t.taskId, t.seq),
  ]
);

/** 산출물. 첫 판은 Markdown·텍스트 본문을 그대로 둔다. 연결 작업과 작성 에이전트·실행 시도는 같은 조직의 기록이다. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    taskId: uuid("task_id").notNull(),
    title: text("title").notNull(),
    format: text("format", { enum: artifactFormats }).notNull(),
    content: text("content").notNull(),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    createdByRunId: uuid("created_by_run_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "artifacts_format_check",
      sql`${t.format} in (${inList(artifactFormats)})`
    ),
    foreignKey({
      columns: [t.organizationId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    unique("artifacts_organization_id_id_unique").on(t.organizationId, t.id),
    index("artifacts_task_idx").on(t.organizationId, t.taskId, t.seq),
  ]
);

/** 같은 조직 에이전트 사이의 메시지. 보낸 실행 시도를 가리킨다. */
export const agentToAgentMessages = pgTable(
  "agent_to_agent_messages",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    senderAgentId: uuid("sender_agent_id").notNull(),
    senderRunId: uuid("sender_run_id").notNull(),
    recipientAgentId: uuid("recipient_agent_id").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "agent_to_agent_messages_recipient_check",
      sql`${t.senderAgentId} <> ${t.recipientAgentId}`
    ),
    foreignKey({
      columns: [t.organizationId, t.senderAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.senderRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.recipientAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    unique("agent_to_agent_messages_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
  ]
);

/** 깨우기 종류마다 사유가 된 기록을 가리키는 열. 깨우기는 이 열 하나만 채운다. */
const wakeSourceColumns = {
  owner_message: "message_id",
  approval_decision: "approval_id",
  task_assigned: "task_id",
  task_completed: "task_id",
  task_comment: "comment_id",
  agent_to_agent_message: "agent_to_agent_message_id",
} as const satisfies Record<WakeKind, string>;
const wakeKinds = Object.keys(wakeSourceColumns) as WakeKind[];

/** 깨우기 대기열. `run_id`가 없으면 대기 중이고, 실행 시도가 가져가면 그 실행 시도에 고정된다. */
export const wakes = pgTable(
  "wakes",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: uuid("agent_id").notNull(),
    kind: text("kind", {
      enum: wakeKinds as [WakeKind, ...WakeKind[]],
    }).notNull(),
    messageId: uuid("message_id"),
    approvalId: uuid("approval_id"),
    taskId: uuid("task_id"),
    commentId: uuid("comment_id"),
    agentToAgentMessageId: uuid("agent_to_agent_message_id"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("wakes_kind_check", sql`${t.kind} in (${inList(wakeKinds)})`),
    check(
      "wakes_source_check",
      sql`num_nonnulls(${t.messageId}, ${t.approvalId}, ${t.taskId}, ${t.commentId}, ${t.agentToAgentMessageId}) = 1
        and (${sql.raw(
          Object.entries(wakeSourceColumns)
            .map(
              ([kind, column]) =>
                `("kind" = '${kind}' and "${column}" is not null)`
            )
            .join(" or ")
        )})`
    ),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.commentId],
      foreignColumns: [taskComments.organizationId, taskComments.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.agentToAgentMessageId],
      foreignColumns: [
        agentToAgentMessages.organizationId,
        agentToAgentMessages.id,
      ],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    index("wakes_pending_idx")
      .on(t.agentId, t.seq)
      .where(sql`${t.runId} is null`),
    index("wakes_run_idx").on(t.runId),
    // 메시지 하나는 깨우기 하나만 만든다.
    uniqueIndex("wakes_message_unique").on(t.messageId),
    // 승인 결정 하나는 깨우기 하나만 만든다.
    uniqueIndex("wakes_approval_unique").on(t.approvalId),
    // 작업 하나의 할당과 완료는 각각 깨우기 하나만 만든다.
    uniqueIndex("wakes_task_kind_unique")
      .on(t.taskId, t.kind)
      .where(sql`${t.taskId} is not null`),
    uniqueIndex("wakes_comment_unique").on(t.commentId),
    uniqueIndex("wakes_agent_to_agent_message_unique").on(
      t.agentToAgentMessageId
    ),
  ]
);

/** Event log. 모든 상태 변화는 조직 ID와 함께 여기에 남고, Event stream은 저장된 행을 알린다. */
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** payload에서 옮긴 귀속. 에이전트별 활동·실행 시도 transcript 조회에 쓴다. */
    agentId: uuid("agent_id"),
    runId: uuid("run_id"),
    type: text("type").$type<NewEvent["type"]>().notNull(),
    payload: jsonb("payload").$type<NewEvent["payload"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("events_organization_idx").on(t.organizationId, t.id),
    index("events_agent_idx").on(t.organizationId, t.agentId, t.id),
    index("events_run_idx").on(t.runId, t.id),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
  ]
);
