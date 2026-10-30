import {
  agentRoles,
  approvalKinds,
  artifactFormats,
  approvalStatuses,
  defaultHeartbeatMinutes,
  inboxItemKinds,
  notificationKinds,
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
  type AgentAppearance,
  type ApprovalProposal,
  type DecidedWorker,
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
    /** 사용자가 생성 때 적는다. 목표 없이 만든 예전 조직은 Lead가 목표 설정에서 기록하기 전까지 없다. */
    goal: text("goal"),
    /** 사용자가 생성 때 적거나, 비워 두었으면 승인된 Lead 제안이다. 그 전에는 없다. */
    completionCriteria: text("completion_criteria"),
    /** 승인 정책 `작업자 추가`. 켜져 있으면 Lead의 작업자 추가가 승인 요청이 된다. 사용자 제어 명령만 바꾼다. */
    addWorkerApproval: boolean("add_worker_approval").notNull().default(false),
    /** 승인 정책 `GitHub에 올리기`. 켜져 있으면 Lead가 올리기 전에 사용자에게 확인받는다(에이전트 지침, ADR-0005). 사용자 제어 명령만 바꾼다. */
    publishToGitHubApproval: boolean("publish_to_github_approval")
      .notNull()
      .default(false),
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
    // 완료 기준은 목표가 있을 때만 있다. 사용자가 비워 둔 완료 기준은 Lead 제안을 승인할 때까지 없다.
    check(
      "organizations_goal_check",
      sql`${t.completionCriteria} is null or ${t.goal} is not null`
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
      .default(defaultHeartbeatMinutes),
    /** 에이전트가 생길 때 Role에서 받은 기본 heartbeat 간격(분). */
    heartbeatDefaultMinutes: integer("heartbeat_default_minutes")
      .notNull()
      .default(defaultHeartbeatMinutes),
    /** 다음 heartbeat 예정 시각. scheduler가 지난 예정을 처리하면 간격만큼 뒤로 옮긴다. */
    heartbeatNextAt: timestamp("heartbeat_next_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** 사용자가 고른 얼굴. 고르지 않았으면 없고, 화면에는 ID에서 정한 기본 얼굴이 보인다. 사용자 변경만 바꾼다. */
    appearance: jsonb("appearance").$type<AgentAppearance>(),
    /**
     * 실행 시도를 맡는 프로바이더 연결 ID. 만들 때 역할의 전역 기본값을 복사하며 사용자 설정 변경만 바꾼다.
     * 이 열 전에 생긴 에이전트는 가짜 프로바이더(migration 0021)다.
     */
    provider: text("provider").notNull(),
    /** 모델. 없으면 프로바이더의 기본 모델이다. */
    model: text("model"),
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
    // 조직 안에서 대소문자만 다른 이름도 겹친다(core `agentNameKey`). 이름을 정하는 규칙은 core가 맡고, 이 index는
    // 그 규칙을 거치지 않거나 경합한 쓰기를 막는 마지막 방어선이다. locale C의 lower()는 ASCII만 바꾸므로 core 규칙보다 넓지 않다.
    uniqueIndex("agents_organization_name_unique").on(
      t.organizationId,
      sql`lower(${t.name})`
    ),
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
    /** 지금 내용의 revision 번호. 편집할 때마다 하나 늘고 그 revision이 instruction_revisions에 남는다. */
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "instruction_copies_kind_check",
      sql`${t.kind} in (${inList(instructionKinds)})`
    ),
    check("instruction_copies_revision_check", sql`${t.revision} >= 1`),
    foreignKey({
      columns: [t.organizationId, t.agentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    uniqueIndex("instruction_copies_agent_path_unique").on(t.agentId, t.path),
    unique("instruction_copies_organization_id_agent_id_id_unique").on(
      t.organizationId,
      t.agentId,
      t.id
    ),
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
    /** 사용자 제어가 요청한 취소. 요청한 순간 토큰이 닫히고, 프로바이더가 정리를 끝내면 `cancelled`로 끝난다. */
    cancelReason: text("cancel_reason", { enum: runCancelReasons }),
    tokenDigest: text("token_digest").notNull().unique(),
    /** admission이 에이전트 설정에서 고정한 프로바이더 연결과 모델. 이 열 전의 실행 시도는 가짜 프로바이더(migration 0021)다. */
    provider: text("provider").notNull(),
    model: text("model"),
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
    // admission이 프로바이더 연결별 진행 중 실행 시도를 센다.
    index("runs_running_provider_idx")
      .on(t.provider)
      .where(sql`${t.status} = 'running'`),
    index("runs_organization_agent_idx").on(t.organizationId, t.agentId, t.seq),
  ]
);

/**
 * 사용자와 조직 Research Lead의 대화. 조직마다 기본 대화(`is_default`) 하나가 조직과 함께 생기고,
 * 새 대화는 첫 사용자 메시지와 함께 생긴다. `read_message_seq`는 사용자가 마지막으로 본 메시지의 대화 속 위치
 * (`messages`의 받은 순서 값: Lead 메시지는 `seq`, 받은 사용자 메시지는 `delivered_seq`)이며 사용자의 보기만 바꾸고 앞으로만 간다.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    readMessageSeq: bigint("read_message_seq", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("conversations_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
    // 조직마다 기본 대화는 하나뿐이다.
    uniqueIndex("conversations_one_default_per_organization")
      .on(t.organizationId)
      .where(sql`${t.isDefault}`),
  ]
);

/**
 * Lead 대화의 메시지. 대화 하나에 속하며, 사용자 메시지는 전달 방식(과 거두었으면 그 시각)을, 에이전트 메시지는 보낸 실행 시도를 갖는다.
 * 대화는 Lead가 받은 순서로 보인다. Lead 메시지는 저장 순서(`seq`)에, 사용자 메시지는 실행 시도가 받은 순간(`delivered_seq`)에 놓인다.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: uuid("agent_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    author: text("author", { enum: messageAuthors }).notNull(),
    body: text("body").notNull(),
    delivery: text("delivery", { enum: messageDeliveries }),
    sentByRunId: uuid("sent_by_run_id"),
    /**
     * 실행 시도가 사용자 메시지를 받은 순간의 위치. admission이 깨우기를 가져가는 transaction에서 `seq`와 같은 sequence의
     * 다음 값을 실행 시도마다 하나 뽑아 그 실행 시도가 받은 메시지에 함께 적는다. 받기 전(줄 세운 메시지)과
     * 서버 재시작으로 다시 대기한 동안은 비어 있다.
     */
    deliveredSeq: bigint("delivered_seq", { mode: "number" }),
    /** 실행 시도가 사용자 메시지를 받은 시각(그 실행 시도의 시작 시각). `delivered_seq`와 함께 적고 함께 비운다. */
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** 사용자가 줄 세운 메시지를 거둔 시각. 거둔 메시지는 남지만 대화·Lead 맥락에서 빠지고 그 깨우기는 지운다. */
    withdrawnAt: timestamp("withdrawn_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "messages_delivered_check",
      sql`${t.deliveredSeq} is null or ${t.author} = 'owner'`
    ),
    check(
      "messages_delivered_at_check",
      sql`(${t.deliveredSeq} is null) = (${t.deliveredAt} is null)`
    ),
    check(
      "messages_withdrawn_check",
      sql`${t.withdrawnAt} is null or ${t.author} = 'owner'`
    ),
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
      columns: [t.organizationId, t.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.sentByRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    unique("messages_organization_id_id_unique").on(t.organizationId, t.id),
    index("messages_conversation_idx").on(t.organizationId, t.agentId, t.seq),
    index("messages_conversation_id_idx").on(t.conversationId, t.seq),
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
    /** 승인으로 생긴 작업자마다의 프로바이더·모델. 승인한 요청에만 있고, 이 열이 생기기 전에 승인한 요청에는 없다. */
    decidedWorkers: jsonb("decided_workers").$type<DecidedWorker[]>(),
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

/**
 * 지침 사본의 revision. 사본마다 1부터 하나씩 늘고, 그때의 전체 본문을 담으며 바뀌지 않는다. revision 1은 복사로 생긴 처음 내용이다
 * (편집자 `copy`, 시각은 사본을 만든 때). 조직·에이전트·사본은 복합 FK로 묶어 다른 조직·에이전트의 사본을 가리킬 수 없다.
 * 에이전트 편집자 열은 이후 Lead 편집을 위한 자리다.
 */
export const instructionRevisions = pgTable(
  "instruction_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    agentId: uuid("agent_id").notNull(),
    copyId: uuid("copy_id").notNull(),
    number: integer("number").notNull(),
    editorAuthor: text("editor_author", {
      enum: ["copy", "owner", "agent"],
    }).notNull(),
    editorAgentId: uuid("editor_agent_id"),
    editorRunId: uuid("editor_run_id"),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("instruction_revisions_number_check", sql`${t.number} >= 1`),
    check(
      "instruction_revisions_editor_check",
      sql`(${t.editorAuthor} in ('copy', 'owner') and ${t.editorAgentId} is null and ${t.editorRunId} is null)
      or (${t.editorAuthor} = 'agent' and ${t.editorAgentId} is not null and ${t.editorRunId} is not null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.agentId, t.copyId],
      foreignColumns: [
        instructionCopies.organizationId,
        instructionCopies.agentId,
        instructionCopies.id,
      ],
    }),
    foreignKey({
      columns: [t.organizationId, t.editorAgentId],
      foreignColumns: [agents.organizationId, agents.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.editorRunId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    uniqueIndex("instruction_revisions_copy_number_unique").on(
      t.copyId,
      t.number
    ),
    unique("instruction_revisions_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
  ]
);

/** 가리키는 기록이 없는 깨우기 종류: 조직 생성(목표는 조직 행에 있음)과 heartbeat. */
const sourcelessWakeKinds = ["organization_created", "heartbeat"] as const;
type SourcelessWakeKind = (typeof sourcelessWakeKinds)[number];

/** 깨우기 종류마다 사유가 된 기록을 가리키는 열. 깨우기는 이 열 하나만 채우고, 조직 생성·heartbeat는 가리키는 기록이 없다. */
const wakeSourceColumns = {
  owner_message: "message_id",
  approval_decision: "approval_id",
  task_assigned: "task_id",
  task_completed: "task_id",
  task_comment: "comment_id",
  agent_to_agent_message: "agent_to_agent_message_id",
  research_map_edit: "map_edit_id",
  instruction_edit: "instruction_revision_id",
  result_changes_requested: "result_submission_id",
} as const satisfies Record<Exclude<WakeKind, SourcelessWakeKind>, string>;
const wakeKinds = [
  ...Object.keys(wakeSourceColumns),
  ...sourcelessWakeKinds,
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
    instructionRevisionId: uuid("instruction_revision_id"),
    resultSubmissionId: uuid("result_submission_id"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("wakes_kind_check", sql`${t.kind} in (${inList(wakeKinds)})`),
    check(
      "wakes_source_check",
      sql`(${t.kind} in (${inList([...sourcelessWakeKinds])})
          and num_nonnulls(${t.messageId}, ${t.approvalId}, ${t.taskId}, ${t.commentId}, ${t.agentToAgentMessageId}, ${t.mapEditId}, ${t.instructionRevisionId}, ${t.resultSubmissionId}) = 0)
        or num_nonnulls(${t.messageId}, ${t.approvalId}, ${t.taskId}, ${t.commentId}, ${t.agentToAgentMessageId}, ${t.mapEditId}, ${t.instructionRevisionId}, ${t.resultSubmissionId}) = 1
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
      columns: [t.organizationId, t.instructionRevisionId],
      foreignColumns: [
        instructionRevisions.organizationId,
        instructionRevisions.id,
      ],
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
    // 조직 생성은 Lead 깨우기 하나만 만든다.
    uniqueIndex("wakes_one_organization_created_per_organization")
      .on(t.organizationId)
      .where(sql`${t.kind} = 'organization_created'`),
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
    // 사본 저장 하나는 깨우기 하나만 만든다.
    uniqueIndex("wakes_instruction_revision_unique").on(
      t.instructionRevisionId
    ),
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
/**
 * 전역 Lead·작업자 기본 프로바이더·모델. 역할마다 한 행이며 그 역할의 에이전트를 만들 때 복사한다(가짜 프로바이더로 시작, migration 0021).
 * 바꿔도 이미 있는 에이전트는 그대로다. 전역 설정이라 조직 Event로 남기지 않는다.
 */
export const providerDefaults = pgTable(
  "provider_defaults",
  {
    role: text("role", { enum: agentRoles }).primaryKey(),
    provider: text("provider").notNull(),
    model: text("model"),
  },
  (t) => [
    check(
      "provider_defaults_role_check",
      sql`${t.role} in (${inList(agentRoles)})`
    ),
  ]
);

/**
 * 프로바이더 연결별 동시 실행 상한. 행이 없으면 기본값(contracts `defaultMaxConcurrentRuns`)이고 0은 무제한이다.
 * admission이 이 행을 `FOR UPDATE`로 잠근 뒤 진행 중 실행 시도를 세므로 같은 연결의 admission은 서로 직렬화된다.
 */
export const providerLimits = pgTable(
  "provider_limits",
  {
    provider: text("provider").primaryKey(),
    maxConcurrentRuns: integer("max_concurrent_runs").notNull(),
  },
  (t) => [
    check(
      "provider_limits_max_concurrent_runs_check",
      sql`${t.maxConcurrentRuns} >= 0`
    ),
  ]
);

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
    unique("events_organization_id_id_unique").on(t.organizationId, t.id),
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

/**
 * 알림 outbox. 알림을 쌓는 사건의 Event와 같은 transaction에 남는 전송 의도이며 Event 하나에 항목 하나다.
 * 전송은 짧은 transaction의 claim(`claimToken`·`claimExpiresAt`) → transaction 밖 채널 전송 → claim이 그대로일 때만 정산이다.
 * claim이 만료되면 다른 전송이 다시 가져가고, 오래된 claim의 정산은 아무것도 바꾸지 않는다.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    eventId: bigint("event_id", { mode: "number" }).notNull(),
    kind: text("kind", { enum: notificationKinds }).notNull(),
    sourceId: uuid("source_id").notNull(),
    /** 전송 시도(claim) 횟수. 내용을 만들지 못해 채널에 넘기지 못한 시도도 센다. claim 번호로도 쓴다. */
    attempts: integer("attempts").notNull().default(0),
    /** 실패 뒤 다음 시도 예정. 없으면 곧바로 보낸다. */
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "notification_outbox_kind_check",
      sql`${t.kind} in (${inList(notificationKinds)})`
    ),
    check(
      "notification_outbox_claim_check",
      sql`(${t.claimToken} is null) = (${t.claimExpiresAt} is null)
        and (${t.sentAt} is null or ${t.claimToken} is null)`
    ),
    foreignKey({
      columns: [t.organizationId, t.eventId],
      foreignColumns: [events.organizationId, events.id],
    }),
    uniqueIndex("notification_outbox_event_unique").on(t.eventId),
    unique("notification_outbox_organization_id_id_unique").on(
      t.organizationId,
      t.id
    ),
    index("notification_outbox_due_idx")
      .on(t.seq)
      .where(sql`${t.sentAt} is null`),
  ]
);

/** 가짜 채널이 받은 알림. 알림(outbox 항목)마다 하나뿐이라 다시 보낸 알림은 기록을 늘리지 않는다. */
export const fakeChannelMessages = pgTable(
  "fake_channel_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: sequence(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    notificationId: uuid("notification_id").notNull(),
    kind: text("kind", { enum: notificationKinds }).notNull(),
    sourceId: uuid("source_id").notNull(),
    organizationName: text("organization_name").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.notificationId],
      foreignColumns: [
        notificationOutbox.organizationId,
        notificationOutbox.id,
      ],
    }),
    uniqueIndex("fake_channel_messages_notification_unique").on(
      t.notificationId
    ),
  ]
);

/**
 * 채널에 보낸 앱 메시지 → 알림. 글 답장은 원본을 답장한 앱 메시지로만 알 수 있으므로, 전송 성공을 적을 때 adapter가 돌려준
 * 앱 메시지 번호를 남긴다. 번호는 채널마다 따로라 채널 이름과 함께 열쇠다.
 */
export const channelMessages = pgTable(
  "channel_messages",
  {
    channel: text("channel").notNull(),
    appMessageId: text("app_message_id").notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    notificationId: uuid("notification_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channel, t.appMessageId] }),
    foreignKey({
      columns: [t.organizationId, t.notificationId],
      foreignColumns: [
        notificationOutbox.organizationId,
        notificationOutbox.id,
      ],
    }),
  ]
);

/**
 * 사용자의 알림 정리 상태(읽음·보관). 원본과 따로 두며, 원본 열 하나만 종류에 맞게 채워 같은 조직의 원본을 FK로 가리킨다.
 * 행이 없으면 안 읽음·보관 안 함이다.
 */
export const inboxStates = pgTable(
  "inbox_states",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind", { enum: inboxItemKinds }).notNull(),
    approvalId: uuid("approval_id"),
    resultSubmissionId: uuid("result_submission_id"),
    runId: uuid("run_id"),
    read: boolean("read").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "inbox_states_kind_check",
      sql`${t.kind} in (${inList(inboxItemKinds)})`
    ),
    // 보관할 수 있는가(결정을 기다리지 않는 원본인가)는 원본 상태에 달려 있어 열 제약으로 쓰지 못한다.
    // db/inbox.ts `updateInboxItem`이 원본을 읽어 지킨다(contracts `canArchiveInboxItem`).
    check(
      "inbox_states_source_check",
      sql`num_nonnulls(${t.approvalId}, ${t.resultSubmissionId}, ${t.runId}) = 1
        and ((${t.kind} = 'approval' and ${t.approvalId} is not null)
          or (${t.kind} = 'result_submission' and ${t.resultSubmissionId} is not null)
          or (${t.kind} = 'run_failure' and ${t.runId} is not null))`
    ),
    foreignKey({
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.resultSubmissionId],
      foreignColumns: [resultSubmissions.organizationId, resultSubmissions.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    uniqueIndex("inbox_states_approval_unique").on(t.approvalId),
    uniqueIndex("inbox_states_result_submission_unique").on(
      t.resultSubmissionId
    ),
    uniqueIndex("inbox_states_run_unique").on(t.runId),
  ]
);
