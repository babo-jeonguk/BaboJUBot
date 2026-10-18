import {
  agentRoles,
  lifecycleStages,
  messageAuthors,
  messageDeliveries,
  runStatuses,
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
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
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

const wakeKinds = ["owner_message"] as const satisfies readonly WakeKind[];

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
    kind: text("kind", { enum: wakeKinds }).notNull(),
    messageId: uuid("message_id"),
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("wakes_kind_check", sql`${t.kind} in (${inList(wakeKinds)})`),
    check(
      "wakes_message_check",
      sql`${t.kind} <> 'owner_message' or ${t.messageId} is not null`
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
      columns: [t.organizationId, t.runId],
      foreignColumns: [runs.organizationId, runs.id],
    }),
    index("wakes_pending_idx")
      .on(t.agentId, t.seq)
      .where(sql`${t.runId} is null`),
    index("wakes_run_idx").on(t.runId),
    // 메시지 하나는 깨우기 하나만 만든다.
    uniqueIndex("wakes_message_unique").on(t.messageId),
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
