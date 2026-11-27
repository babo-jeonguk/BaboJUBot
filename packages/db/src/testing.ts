import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { inject } from "vitest";
import type { TestProject } from "vitest/node";
import {
  planOrganizationCreation,
  type AgentRoleSource,
} from "@babojubot/core";
import {
  clusterUrl,
  ephemeralCluster,
  openDatabase,
  startEmbeddedCluster,
  withClient,
  type Database,
  type DatabaseHandle,
} from "./client.ts";
import { insertInstructionCopies } from "./harness.ts";
import { conversationRow } from "./conversations.ts";
import {
  agentRow,
  insertEvent,
  organizationRow,
  type Executor,
} from "./rows.ts";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  agents,
  conversations,
  organizations,
  runs,
  toolOperations,
} from "./schema.ts";
import { attemptEach, combinedFailure } from "@babojubot/contracts";
import { within } from "@babojubot/process/test-support";

export type TestDatabase = DatabaseHandle;

/** 곁 DB 정리의 단계마다 기다리는 상한. */
const sideDatabaseStepMs = 10_000;
/**
 * 시험이 따로 만든 DB(곁 DB)를 정리한다. 그 DB로 연 연결(풀·handle)을 상한 안에서 닫은 뒤에만 DB를 지운다. 닫지 못하면 지우지
 * 않고 DB를 남긴 채 그 원인으로 실패한다. 지우기도 상한 안에서 기다린다. 상한은 기다림만 끝내므로, 넘긴 단계는 그 원인과 함께
 * 실패로 남는다(그 연결·지우기를 대신 끝내지는 않는다). `stepMs`는 단계마다의 상한이고, 그 차례를 직접 보는 시험만 줄인다.
 */
export async function closeThenDrop(
  name: string,
  close: () => Promise<unknown>,
  drop: () => Promise<unknown>,
  stepMs = sideDatabaseStepMs
) {
  await within(
    close(),
    stepMs,
    `the connections to database ${name} did not close`
  );
  await within(drop(), stepMs, `database ${name} was not dropped`);
}

declare module "vitest" {
  export interface ProvidedContext {
    /** 테스트 실행이 띄운 cluster의 port. vitest globalSetup(`startTestCluster`)이 넘기고 시험이 `inject`로 받는다. */
    testClusterPort: number;
  }
}
const templateName = "babojubot_template";
// 서버 테스트 파일들이 동시에 연결을 연다. 임시 cluster라 디스크 확정 기록은 startEmbeddedCluster가 끈다.
const testSettings: readonly string[] = ["max_connections=500"];

/**
 * 테스트 실행 하나가 같이 쓰는 embedded Postgres를 띄우고, migration을 적용한 원본 DB를 만든다.
 * vitest globalSetup용이다. 돌려준 함수가 cluster를 멈추고 dataDir를 지운다.
 */
export async function startTestCluster(
  project: Pick<TestProject, "provide">
): Promise<() => Promise<void>> {
  const options = await ephemeralCluster();
  const { port, stop } = await startEmbeddedCluster(options, [...testSettings]);
  try {
    await withClient(clusterUrl(port, "postgres"), (client) =>
      client.query(`create database ${templateName}`)
    );
    // 원본에 연결이 남으면 복제할 수 없으므로 migration 뒤 바로 닫는다.
    await (await openDatabase({ url: clusterUrl(port, templateName) })).close();
    project.provide("testClusterPort", port);
    return stop;
  } catch (error) {
    // 준비 실패를 그대로 알린다. 멈추기가 실패하면 그 실패를 함께 알린다.
    throw combinedFailure(
      [error, ...(await attemptEach([stop]))],
      "the test cluster was not prepared and stopping it failed",
      { cause: error }
    );
  }
}

/** 테스트 실행이 띄운 cluster(`startTestCluster`)의 port. */
export function testClusterPort() {
  const port = inject("testClusterPort");
  if (!port)
    throw new Error(
      "테스트 cluster가 없습니다. vitest 설정의 globalSetup에 packages/db/src/test-cluster.ts를 넣으세요."
    );
  return port;
}

/**
 * `tag` 직전까지만 적용한 DB를 같은 cluster에 따로 만들어 `fn`에 넘긴다. `fn`은 옛 모양의 행을 넣고 `migrateAll`로 끝까지 올린다.
 * 정리(`fn`이 끝나거나 실패한 뒤)는 풀을 닫은 뒤에만 그 DB를 지우고(`closeThenDrop`), 그 뒤 옮긴 마이그레이션 폴더를 지운다.
 */
export async function withDatabaseBefore(
  t: TestDatabase,
  tag: string,
  fn: (pool: pg.Pool, migrateAll: () => Promise<void>) => Promise<void>
) {
  const migrations = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../migrations"
  );
  await withCleanup(async (defer) => {
    const before = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-mig-"));
    defer(() => removeFolder(before));
    await fsp.cp(migrations, before, { recursive: true });
    const journalPath = path.join(before, "meta/_journal.json");
    const journal = JSON.parse(await fsp.readFile(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    const index = journal.entries.findIndex((e) => e.tag === tag);
    journal.entries = journal.entries.slice(0, index);
    await fsp.writeFile(journalPath, JSON.stringify(journal));

    const name = `before_${randomUUID().replaceAll("-", "")}`;
    await t.db.execute(sql.raw(`create database ${name}`));
    const url = new URL(t.url);
    url.pathname = `/${name}`;
    // 풀은 만들 때 연결하지 않는다. 정리는 풀을 닫은 뒤에만 DB를 지운다(`closeThenDrop`).
    const pool = new pg.Pool({ connectionString: url.toString() });
    defer(() =>
      closeThenDrop(
        name,
        () => pool.end(),
        () => t.db.execute(sql.raw(`drop database ${name}`))
      )
    );
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: before });
    await fn(pool, () => migrate(db, { migrationsFolder: migrations }));
  });
}

/**
 * 테스트마다 따로 쓰는 DB. 테스트 실행이 띄운 cluster(`startTestCluster`)에 원본 DB를 복제하며,
 * `close`가 연결을 닫고 그 DB를 지운다.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const port = testClusterPort();
  const admin = clusterUrl(port, "postgres");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await withClient(admin, (client) =>
    client.query(`create database ${name} template ${templateName}`)
  );
  const drop = () =>
    withClient(admin, (client) =>
      client.query(`drop database if exists ${name} with (force)`)
    );
  let handle: DatabaseHandle;
  try {
    handle = await openDatabase({ url: clusterUrl(port, name) });
  } catch (error) {
    throw combinedFailure(
      [error, ...(await attemptEach([drop]))],
      "the test database did not open and dropping it failed",
      { cause: error }
    );
  }
  return {
    ...handle,
    // 연결을 닫은 뒤에만 DB를 지운다. 닫지 못하면 DB를 남기고 그 원인으로 실패한다(`closeThenDrop`).
    close: () => closeThenDrop(name, () => handle.close(), drop),
  };
}

/**
 * 생성 때 목표를 받기 전에 만든 예전 조직을 저장한다. 목표·완료 기준 없이 `목표 설정`에 있고(기본 대화는 있음) Lead를 깨우지 않는다.
 * 예전 조직에 남은 목표 기록 경로(`record_goal`)를 검사할 때만 쓴다.
 */
export async function insertLegacyOrganization(
  db: Database,
  name: string,
  leadRole: AgentRoleSource = { files: [] }
) {
  const creation = planOrganizationCreation(
    { name, goal: "-", lead: { provider: "fake", model: null } },
    leadRole,
    {
      newId: randomUUID,
      now: () => new Date(),
    }
  );
  const organization = {
    ...creation.organization,
    stage: "goal_setting" as const,
    goal: null,
    completionCriteria: null,
  };
  const lead = creation.agents[0]!;
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values(organizationRow(organization));
    await tx.insert(agents).values(creation.agents.map(agentRow));
    await insertInstructionCopies(tx, creation.instructionCopies);
    await tx
      .insert(conversations)
      .values(conversationRow(creation.defaultConversation));
    await insertEvent(tx, {
      organizationId: organization.id,
      type: "organization.created",
      payload: {
        name,
        stage: organization.stage,
        leadAgentId: lead.id,
      },
    });
  });
  return { id: organization.id, lead };
}

/**
 * 그 실행 시도의 종료 Event 기록이 실패하게 한다. 종료 저장 transaction의 마지막 쓰기가 실패하는 경우다.
 * 돌려준 함수가 되돌린다. 한 DB에 하나만 걸 수 있다.
 */
export async function failRunEnd(
  db: Database,
  runId: string
): Promise<() => Promise<void>> {
  await db.execute(`
    create function fail_run_end() returns trigger as $$
    begin
      if new.type = 'run.finished' and new.payload->>'runId' = '${runId}' then
        raise exception 'run end could not be saved';
      end if;
      return new;
    end $$ language plpgsql;
    create trigger fail_run_end before insert on events
      for each row execute function fail_run_end();
  `);
  return async () => {
    await db.execute(
      "drop trigger fail_run_end on events; drop function fail_run_end();"
    );
  };
}

/**
 * 산출물 기록 Event(`artifact.recorded`) 저장이 실패하게 한다. 산출물 행을 넣은 뒤 같은 정산 transaction이 실패하는 실제 DB 실패다.
 * DB는 시험마다 복제하므로 그 시험의 DB에만 걸린다. `failed`는 트리거가 실패시킨 기록 수다: 실패한 transaction이 되돌려져도 남도록
 * sequence로 센다(Postgres는 sequence 증가를 되돌리지 않는다). 시험은 이 수로 결함이 실제로 그 기록에서 났는지 본다. `remove`가
 * 되돌린다. 한 DB에 하나만 걸 수 있다.
 */
export async function failArtifactRecord(db: Database): Promise<{
  failed: () => Promise<number>;
  remove: () => Promise<void>;
}> {
  await db.execute(`
    create sequence fail_artifact_record_failed;
    create function fail_artifact_record() returns trigger as $$
    begin
      if new.type = 'artifact.recorded' then
        perform nextval('fail_artifact_record_failed');
        raise exception 'artifact record could not be saved';
      end if;
      return new;
    end $$ language plpgsql;
    create trigger fail_artifact_record before insert on events
      for each row execute function fail_artifact_record();
  `);
  return {
    failed: async () => {
      const result = await db.execute(
        sql`select case when is_called then last_value else 0 end::int as n from fail_artifact_record_failed`
      );
      return (result.rows[0] as { n: number }).n;
    },
    remove: async () => {
      await db.execute(
        "drop trigger fail_artifact_record on events; drop function fail_artifact_record(); drop sequence fail_artifact_record_failed;"
      );
    },
  };
}

/**
 * 실행 의도의 고정한 원본 자료를 바꾼다. 원본 자료가 사라진 기록(`null`)이나 되찾은 기록을 만드는 테스트 전용 조작이다.
 */
export async function setIntentSource(
  db: Database,
  intentId: string,
  source: unknown
) {
  await db
    .update(toolOperations)
    .set({ source })
    .where(eq(toolOperations.id, intentId));
}

/**
 * 에이전트의 같은 호출 키 실행 의도가 고정한 입력 표기를 바꾼다. 이 기능 전 판이 남긴 기록(`null`)이나 읽을 수 없게 손상된 기록을
 * 만드는 테스트 전용 조작이다.
 */
export async function setIntentRequest(
  db: Database,
  agentId: string,
  key: string,
  request: string | null
) {
  await db
    .update(toolOperations)
    .set({ request })
    .where(
      and(eq(toolOperations.agentId, agentId), eq(toolOperations.key, key))
    );
}

/** 에이전트의 같은 호출 키 실행 의도의 정산 상태. */
export async function intentStatusOf(
  db: Database,
  agentId: string,
  key: string
) {
  const [row] = await db
    .select({ status: toolOperations.status })
    .from(toolOperations)
    .where(
      and(eq(toolOperations.agentId, agentId), eq(toolOperations.key, key))
    );
  return row?.status;
}

/** 에이전트의 실행 의도(만든 순서): 같은 호출 키·도구·고정한 입력·정산 상태. */
export async function intentsOf(db: Database, agentId: string) {
  return db
    .select({
      key: toolOperations.key,
      tool: toolOperations.tool,
      request: toolOperations.request,
      status: toolOperations.status,
      runId: toolOperations.runId,
    })
    .from(toolOperations)
    .where(eq(toolOperations.agentId, agentId))
    .orderBy(asc(toolOperations.createdAt), asc(toolOperations.id));
}

/** 실행 의도의 복구 정산 시도 횟수를 정한다. 서버 재시작을 거듭하며 정산하다 멈춘 기록을 만드는 테스트 전용 조작이다. */
export async function setIntentSettleAttempts(
  db: Database,
  intentId: string,
  attempts: number
) {
  await db
    .update(toolOperations)
    .set({ settleAttempts: attempts })
    .where(eq(toolOperations.id, intentId));
}

/**
 * 실행 시도 행을 배타 잠금한 채 `body`를 한 transaction에서 실행하고 commit한다. 도구 호출의 Role·단계 검사는 그 행을 공유 잠금하므로
 * 그동안 기다린다. 동시 호출의 검사 직전에 다른 commit을 끼워 넣는 테스트 전용 조작이다.
 */
export async function whileHoldingRun(
  db: Database,
  runId: string,
  body: (tx: Executor) => Promise<void>
) {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    await body(tx);
  });
}

/** 이 DB에서 잠금을 기다리는 연결 수. */
export async function lockWaiters(db: Database) {
  const result = await db.execute(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
  );
  return (result.rows[0] as { n: number }).n;
}

/** 정산이 끝난(`completed`) 실행 의도 하나를 그대로 남긴다. 다른 요청이 먼저 수락·정산한 상태를 만드는 테스트 전용 조작이다. */
export async function insertCompletedIntent(
  tx: Executor,
  intent: {
    organizationId: string;
    agentId: string;
    runId: string;
    key: string;
    tool: string;
    request: string;
    digest: string;
    result: unknown;
  }
) {
  await tx.insert(toolOperations).values({
    organizationId: intent.organizationId,
    agentId: intent.agentId,
    runId: intent.runId,
    key: intent.key,
    tool: intent.tool,
    request: intent.request,
    requestDigest: intent.digest,
    result: intent.result,
    status: "completed",
    settledRunId: intent.runId,
  });
}

/** 조직 단계를 바로 바꾼다(일시정지 외). 그 단계가 닫은 도구를 만드는 테스트 전용 조작이다. */
export async function setOrganizationStage(
  tx: Executor,
  organizationId: string,
  stage: "researching" | "result_review"
) {
  await tx
    .update(organizations)
    .set({ stage })
    .where(eq(organizations.id, organizationId));
}
