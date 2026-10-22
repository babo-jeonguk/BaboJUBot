import {
  agentRoles,
  approvalKinds,
  artifactFormats,
  approvalStatuses,
  heartbeatIntervalMaxMinutes,
  instructionKinds,
  lifecycleStages,
  memoryScopes,
  messageAuthors,
  messageDeliveries,
  researchMapOperations,
  researchNodeStatuses,
  researchNodeWorkStatuses,
  resultSubmissionStatuses,
  runCancelReasons,
  runStatuses,
  taskStatuses,
  type ApprovalProposal,
  type FlowKind,
  type NewEvent,
  type SessionState,
  type Usage,
  type WakeKind,
} from "@babojubot/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    /** 승인 정책 `작업자 추가`. 켜져 있으면 Lead의 작업자 추가가 승인 요청이 된다. 사용자 제어 명령만 바꾼다. */
    addWorkerApproval: boolean("add_worker_approval").notNull().default(false),
    /** 일시정지 전 단계. 일시정지 중에만 있고 재개하면 이 단계로 돌아간다. */
    pausedFrom: text("paused_from", { enum: lifecycleStages }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check(
      "organizations_paused_from_check",
      sql`(${t.stage} = 'paused') = (${t.pausedFrom} is not null)
        and ${t.pausedFrom} not in ('paused', 'completed', 'stopped')`
    ),
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
    /** 사용자가 이 에이전트를 일시정지했다. 사용자 제어 명령만 바꾸며 켜져 있으면 admission이 실행 시도를 시작하지 않는다. */
    paused: boolean("paused").notNull().default(false),
    /** heartbeat 켜짐. 켜져 있을 때만 다음 heartbeat 예정 시각이 있다. 사용자 설정 변경만 바꾼다. */
    heartbeatEnabled: boolean("heartbeat_enabled").notNull().default(false),
    /** heartbeat 간격(분). 처음에는 Role의 기본 간격이다. */
    heartbeatIntervalMinutes: integer("heartbeat_interval_minutes")
      .notNull()
      .default(60),
    /** 에이전트가 생길 때 Role에서 받은 기본 heartbeat 간격(분). */
    heartbeatDefaultMinutes: integer("heartbeat_default_minutes")
      .notNull()
      .default(60),
    /** 다음 heartbeat 예정 시각. scheduler가 지난 예정을 처리하면 간격만큼 뒤로 옮긴다. */
    heartbeatNextAt: timestamp("heartbeat_next_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check("agents_role_check", sql`${t.role} in (${inList(agentRoles)})`),
    check(
      "agents_heartbeat_check",
      sql`${t.heartbeatEnabled} = (${t.heartbeatNextAt} is not null)
        and ${t.heartbeatIntervalMinutes} between 1 and ${sql.raw(String(heartbeatIntervalMaxMinutes))}
        and ${t.heartbeatDefaultMinutes} between 1 and ${sql.raw(String(heartbeatIntervalMaxMinutes))}`
    ),
    // scheduler가 지난 heartbeat를 찾는다.
    index("agents_heartbeat_due_idx")
      .on(t.heartbeatNextAt)
      .where(sql`${t.heartbeatEnabled}`),
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
 * 묶은 깨우기는 run_wakes가 기록하고, 지금 그 깨우기를 가진 실행 시도는 wakes.run_id가 가리킨다.
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
    /** 사용자 제어가 요청한 취소. 요청한 순간 토큰이 닫히고, 실행기가 정리를 끝내면 `cancelled`로 끝난다. */
    cancelReason: text("cancel_reason", { enum: runCancelReasons }),
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
      "runs_cancel_reason_check",
      sql`${t.cancelReason} in (${inList(runCancelReasons)})
        and (${t.cancelReason} is null or ${t.status} in ('running', 'cancelled'))`
    ),
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
 * 승인 요청. 제안 내용은 제출 때 고정한 snapshot이고 다시 바뀌지 않으며 모양은 종류(`kind`)가 정한다.
 * 결정은 `pending`에서 한 번만 하며, 반려·수정 요청 뒤의 재제출은 직전 요청을 가리키는 새 행이다.
 * 결정을 기다리는 초기 연구 승인 요청은 조직마다 하나뿐이고, 작업자 추가 요청은 호출마다 따로 여럿일 수 있다.
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
    proposal: jsonb("proposal").$type<ApprovalProposal>().notNull(),
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
    uniqueIndex("approvals_one_pending_initial_per_organization")
      .on(t.organizationId)
      .where(sql`${t.status} = 'pending' and ${t.kind} = 'initial_research'`),
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

/** 기록을 만든 쪽(`<prefix>_author`·`_agent_id`·`_run_id`). 사용자는 에이전트·실행 시도가 없고, 에이전트는 둘 다 있다. */
const authorCheck = (
  name: string,
  author: AnyPgColumn,
  agentId: AnyPgColumn,
  runId: AnyPgColumn
) =>
  check(
    name,
    sql`(${author} = 'owner' and ${agentId} is null and ${runId} is null)
      or (${author} = 'agent' and ${agentId} is not null and ${runId} is not null)`
  );

/**
 * 연구 노드. 주 부모는 같은 조직의 노드 하나(`parent_node_id`)라서 노드마다 최대 하나다. 주 연결 순환 금지는 조직 행 잠금 아래에서
 * 최신 주 연결을 읽어 검사하는 저장 쪽이 강제한다. 폐기는 상태이며 폐기 직전 상태를 함께 둔다. 노드는 지우지 않는다.
 */
export const researchNodes = pgTable(
  "research_nodes",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: researchNodeStatuses }).notNull(),
    statusBeforeDiscard: text("status_before_discard", {
      enum: researchNodeWorkStatuses,
    }),
    parentNodeId: uuid("parent_node_id"),
    createdByAuthor: text("created_by_author", {
      enum: messageAuthors,
    }).notNull(),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByRunId: uuid("created_by_run_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    check(
      "research_nodes_status_check",
      sql`${t.status} in (${inList(researchNodeStatuses)})
        and (${t.statusBeforeDiscard} is null or ${t.statusBeforeDiscard} in (${inList(researchNodeWorkStatuses)}))
        and (${t.status} = 'discarded') = (${t.statusBeforeDiscard} is not null)`
    ),
    check(
      "research_nodes_parent_check",
      sql`${t.parentNodeId} is null or ${t.parentNodeId} <> ${t.id}`
    ),
    authorCheck(
      "research_nodes_author_check",
      t.createdByAuthor,
      t.createdByAgentId,
      t.createdByRunId
    ),
    foreignKey({
      columns: [t.organizationId, t.parentNodeId],
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
    unique("research_nodes_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
    index("research_nodes_organization_idx").on(t.organizationId, t.seq),
  ]
);

/** 보조 연결. 관계마다 ID가 있고 개수·순환 제한이 없다. 양 끝은 같은 조직의 서로 다른 노드다. */
export const researchLinks = pgTable(
  "research_links",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    sourceNodeId: uuid("source_node_id").notNull(),
    targetNodeId: uuid("target_node_id").notNull(),
    kind: text("kind").notNull(),
    createdByAuthor: text("created_by_author", {
      enum: messageAuthors,
    }).notNull(),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByRunId: uuid("created_by_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "research_links_endpoints_check",
      sql`${t.sourceNodeId} <> ${t.targetNodeId}`
    ),
    authorCheck(
      "research_links_author_check",
      t.createdByAuthor,
      t.createdByAgentId,
      t.createdByRunId
    ),
    foreignKey({
      columns: [t.organizationId, t.sourceNodeId],
      foreignColumns: [researchNodes.organizationId, researchNodes.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.targetNodeId],
      foreignColumns: [researchNodes.organizationId, researchNodes.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    unique("research_links_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
    index("research_links_organization_idx").on(t.organizationId, t.seq),
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
    /** 연결된 연구 노드. 열 하나라서 작업은 노드 0~1개에 연결된다. */
    researchNodeId: uuid("research_node_id"),
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
      columns: [t.organizationId, t.researchNodeId],
      foreignColumns: [researchNodes.organizationId, researchNodes.id],
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
    index("tasks_research_node_idx").on(t.organizationId, t.researchNodeId),
  ]
);

/**
 * 연구 지도 편집 기록. 편집 하나(사용자 또는 에이전트·실행 시도)마다 한 행이며, 사용자 편집은 이 행을 가리키는 Lead 깨우기를 만든다.
 */
export const researchMapEdits = pgTable(
  "research_map_edits",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    editorAuthor: text("editor_author", { enum: messageAuthors }).notNull(),
    editorAgentId: uuid("editor_agent_id"),
    editorRunId: uuid("editor_run_id"),
    operation: text("operation", { enum: researchMapOperations }).notNull(),
    nodeId: uuid("node_id"),
    linkId: uuid("link_id"),
    taskId: uuid("task_id"),
    summary: text("summary").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "research_map_edits_operation_check",
      sql`${t.operation} in (${inList(researchMapOperations)})`
    ),
    authorCheck(
      "research_map_edits_editor_check",
      t.editorAuthor,
      t.editorAgentId,
      t.editorRunId
    ),
    foreignKey({
      columns: [t.organizationId, t.editorAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.editorRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.nodeId],
      foreignColumns: [researchNodes.organizationId, researchNodes.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.linkId],
      foreignColumns: [researchLinks.organizationId, researchLinks.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.taskId],
      foreignColumns: [tasks.organizationId, tasks.id],
    }),
    unique("research_map_edits_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
    index("research_map_edits_node_idx").on(t.organizationId, t.nodeId, t.seq),
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

/**
 * 결과 제출. 요약·검토 기준(목표·완료 기준 사본)·근거 산출물은 제출 때 고정하고 다시 바뀌지 않는다. 결정은 `pending`에서
 * 한 번만 하며, 수정 요청 뒤의 재제출은 직전 제출을 가리키는 새 행이다. 조직마다 결정을 기다리는 제출은 하나뿐이다.
 */
export const resultSubmissions = pgTable(
  "result_submissions",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    status: text("status", { enum: resultSubmissionStatuses }).notNull(),
    submittedByAgentId: uuid("submitted_by_agent_id").notNull(),
    submittedByRunId: uuid("submitted_by_run_id").notNull(),
    previousSubmissionId: uuid("previous_submission_id"),
    summary: text("summary").notNull(),
    goal: text("goal").notNull(),
    completionCriteria: text("completion_criteria").notNull(),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "result_submissions_status_check",
      sql`${t.status} in (${inList(resultSubmissionStatuses)})`
    ),
    check(
      "result_submissions_decided_check",
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.submittedByAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.submittedByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.previousSubmissionId],
      foreignColumns: [t.organizationId, t.id],
    }),
    unique("result_submissions_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
    uniqueIndex("result_submissions_one_pending_per_organization")
      .on(t.organizationId)
      .where(sql`${t.status} = 'pending'`),
    index("result_submissions_organization_idx").on(t.organizationId, t.seq),
  ]
);

/** 결과 제출의 근거 산출물. 같은 조직의 산출물만 묶이고, `position`이 제출한 순서다. */
export const resultSubmissionArtifacts = pgTable(
  "result_submission_artifacts",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    submissionId: uuid("submission_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.submissionId, t.artifactId] }),
    unique("result_submission_artifacts_position_unique").on(
      t.submissionId,
      t.position
    ),
    foreignKey({
      columns: [t.organizationId, t.submissionId],
      foreignColumns: [resultSubmissions.organizationId, resultSubmissions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifacts.organizationId, artifacts.id],
    }),
  ]
);

/** 깨우기 종류마다 사유가 된 기록을 가리키는 열. 깨우기는 이 열 하나만 채우고, heartbeat는 가리키는 기록이 없다. */
const wakeSourceColumns = {
  owner_message: "message_id",
  approval_decision: "approval_id",
  task_assigned: "task_id",
  task_completed: "task_id",
  task_comment: "comment_id",
  agent_to_agent_message: "agent_to_agent_message_id",
  research_map_edit: "map_edit_id",
  result_changes_requested: "result_submission_id",
} as const satisfies Record<Exclude<WakeKind, "heartbeat">, string>;
const wakeKinds = [
  ...Object.keys(wakeSourceColumns),
  "heartbeat",
] as WakeKind[];

/**
 * 깨우기 대기열. `run_id`가 없으면 대기 중이고, 실행 시도가 가져가면 그 실행 시도에 고정된다.
 * 서버 재시작으로 끝난 실행 시도의 깨우기는 다시 대기하며(`run_id` 없음), 받았던 실행 시도는 run_wakes에 남는다.
 */
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
    mapEditId: uuid("map_edit_id"),
    resultSubmissionId: uuid("result_submission_id"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("wakes_kind_check", sql`${t.kind} in (${inList(wakeKinds)})`),
    check(
      "wakes_source_check",
      sql`(${t.kind} = 'heartbeat'
          and num_nonnulls(${t.messageId}, ${t.approvalId}, ${t.taskId}, ${t.commentId}, ${t.agentToAgentMessageId}, ${t.mapEditId}, ${t.resultSubmissionId}) = 0)
        or num_nonnulls(${t.messageId}, ${t.approvalId}, ${t.taskId}, ${t.commentId}, ${t.agentToAgentMessageId}, ${t.mapEditId}, ${t.resultSubmissionId}) = 1
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
      columns: [t.organizationId, t.mapEditId],
      foreignColumns: [researchMapEdits.organizationId, researchMapEdits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resultSubmissionId],
      foreignColumns: [resultSubmissions.organizationId, resultSubmissions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    index("wakes_pending_idx")
      .on(t.agentId, t.seq)
      .where(sql`${t.runId} is null`),
    index("wakes_run_idx").on(t.runId),
    unique("wakes_organization_id_id_unique").on(t.organizationId, t.id),
    // 에이전트마다 대기 중인 heartbeat 깨우기는 하나뿐이다. 지난 heartbeat는 쌓지 않고 합친다.
    uniqueIndex("wakes_one_pending_heartbeat_per_agent")
      .on(t.agentId)
      .where(sql`${t.kind} = 'heartbeat' and ${t.runId} is null`),
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
    // 사용자 편집 하나는 깨우기 하나만 만든다.
    uniqueIndex("wakes_map_edit_unique").on(t.mapEditId),
    // 수정 요청 하나는 깨우기 하나만 만든다.
    uniqueIndex("wakes_result_submission_unique").on(t.resultSubmissionId),
  ]
);

/**
 * 실행 시도가 받은 깨우기의 기록. 한 번 남으면 바뀌지 않는다. 서버 재시작으로 다시 대기한 깨우기는
 * 다음 실행 시도에도 묶이므로 깨우기 하나가 여러 실행 시도에 남을 수 있다. 실행 시도 상세·대화 전달 경계가 이 기록을 읽는다.
 */
export const runWakes = pgTable(
  "run_wakes",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    runId: uuid("run_id").notNull(),
    wakeId: uuid("wake_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.wakeId] }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.wakeId],
      foreignColumns: [wakes.organizationId, wakes.id],
    }),
    index("run_wakes_wake_idx").on(t.wakeId),
  ]
);

/**
 * 조직 기억·에이전트 기억(Memory port 첫 판). `agent_id`는 에이전트 기억의 주인이며 조직 기억이면 없다.
 * 범위와 출처(쓴 에이전트·실행 시도)는 같은 조직이어야 한다(복합 FK).
 */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    scope: text("scope", { enum: memoryScopes }).notNull(),
    agentId: uuid("agent_id"),
    content: text("content").notNull(),
    sourceAgentId: uuid("source_agent_id").notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "memories_scope_check",
      sql`${t.scope} in (${inList(memoryScopes)})
        and (${t.scope} = 'agent') = (${t.agentId} is not null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sourceAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sourceRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    index("memories_scope_idx").on(t.organizationId, t.agentId, t.seq),
  ]
);

/**
 * 같은 효과를 한 번만 남기는 조직 도구 호출(`Idempotency-Key`). 에이전트마다 키 하나에 처음 저장한 결과를 둔다.
 * 효과와 같은 transaction에 남으므로, 효과가 commit되었으면 이 기록도 있다. 결과는 다시 처리할 수 있는 동안 지우지 않는다.
 */
export const toolOperations = pgTable(
  "tool_operations",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: uuid("agent_id").notNull(),
    key: text("key").notNull(),
    tool: text("tool").notNull(),
    requestDigest: text("request_digest").notNull(),
    result: jsonb("result").notNull(),
    /** 처음 쓴 실행 시도. */
    runId: uuid("run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.key] }),
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
