import { randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
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
import { attemptAll, attemptEach, combinedFailure } from "@babojubot/contracts";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";

export type TestDatabase = DatabaseHandle;

declare module "vitest" {
  export interface ProvidedContext {
    /** 테스트 실행이 띄운 cluster의 port. vitest globalSetup(`startTestCluster`)이 넘기고 시험이 `inject`로 받는다. */
    testClusterPort: number;
  }
}
const templateName = "babojubot_template";
// 서버 테스트 파일들이 동시에 연결을 연다. 임시 cluster라 디스크 확정 기록은 startEmbeddedCluster가 끈다.
const testSettings = ["max_connections=500"];

/**
 * 테스트 실행 하나가 같이 쓰는 embedded Postgres를 띄우고, migration을 적용한 원본 DB를 만든다.
 * vitest globalSetup용이다. 돌려준 함수가 cluster를 멈추고 dataDir를 지운다.
 */
export async function startTestCluster(
  project: Pick<TestProject, "provide">
): Promise<() => Promise<void>> {
  const options = await ephemeralCluster();
  const { port, stop } = await startEmbeddedCluster(options, testSettings);
  try {
    await askServer(
      clusterUrl(port, "postgres"),
      (client) => client.query(`create database ${templateName}`),
      60_000,
      "the test cluster did not create the template database"
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
 * 테스트마다 따로 쓰는 DB. 테스트 실행이 띄운 cluster(`startTestCluster`)에 원본 DB를 복제하며,
 * `close`가 연결을 닫고 그 DB를 지운다.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const port = testClusterPort();
  const admin = clusterUrl(port, "postgres");
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await askServer(
    admin,
    (client) =>
      client.query(`create database ${name} template ${templateName}`),
    60_000,
    `the test cluster did not create ${name}`
  );
  const drop = () =>
    askServer(
      admin,
      (client) => client.query(`drop database if exists ${name} with (force)`),
      60_000,
      `the test cluster did not drop ${name}`
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
    // 연결 닫기가 실패해도 DB를 지우고, 둘 다 실패하면 둘 다 알린다.
    close: () => attemptAll([() => handle.close(), drop]),
  };
}

/**
 * 시험이 여는 pg 연결. 연결의 소켓은 시험이 만든다(pg 설정 `stream`, `@types/pg` `ConnectionConfig.stream`). `close`는 `end()`를
 * 부르고, `cut`이면 그 소켓을 끊은 뒤, 연결의 끝(`end()`의 이행, 소켓의 `close`)을 `limitMs` 안에서 확인한다. pg의 `end()`는 답 없는
 * 질의가 있으면 소켓을 닫지만 연결 중이거나 쉬는 연결은 정중히 끝내며 상대의 끝을 기다리므로(pg 8.23 `lib/client.js` `end`), 상대가
 * 답하지 않았거나 멈췄을 수 있으면 끊어야 끝난다. `end()`를 먼저 불러 pg가 이 끝을 예상한 끝으로 다룬다(예상하지 못한 끊김의 오류
 * 이벤트를 내지 않는다). 제품 `withClient`는 시한을 두지 않으므로 시험의 연결에 쓰지 않는다.
 */
export function testConnection(url: string) {
  const socket = new net.Socket();
  const client = new pg.Client({ connectionString: url, stream: () => socket });
  return {
    client,
    close: (cut: boolean, limitMs: number, what: string) => {
      const ended = client.end();
      if (cut) socket.destroy();
      return within(ended, limitMs, what);
    },
  };
}

/**
 * 시험이 서버(`url`)에 `ask`로 묻는다(`testConnection`). 연결과 묻기를 합쳐 `limitMs` 안에 끝나지 않으면 `what`으로 실패하고, 성공·실패
 * 모두 그 연결을 끝내고 끝난 것을 확인한다(CODING_STANDARDS 「정리」). 상한이 거절만 하면 연결 시도나 묻기가 그대로 돌아 연결이 남는다.
 * 답을 받았으면 정중히 끝내고, 받지 못했으면 끊는다.
 */
export function askServer<T>(
  url: string,
  ask: (client: pg.Client) => Promise<T>,
  limitMs: number,
  what: string
) {
  return withCleanup(async (defer) => {
    const { client, close } = testConnection(url);
    let answered = false;
    defer(() =>
      close(!answered, limitMs, `${what}, and its connection did not close`)
    );
    const answer = await within(
      client.connect().then(() => ask(client)),
      limitMs,
      what
    );
    answered = true;
    return answer;
  });
}

/**
 * 시험이 여는 pg pool(`testConnection`과 같은 기준). 연결마다 pg-pool의 연결 상한(`connectionTimeoutMillis`: 넘기면 그 연결의 소켓을
 * 끊는다)과 pg의 질의 상한(`query_timeout`: 넘긴 질의는 실패하고, pool은 오류와 함께 돌려받은 연결을 끝낸다. pg의 `end()`는 답 없는
 * 질의가 남은 연결의 소켓을 닫는다)을 `limitMs`로 둔다(pg-pool 3.14 `index.js` `newClient`·`_release`, pg 8.23 `lib/client.js`). 연결의
 * 소켓은 시험이 만든다(pg 설정 `stream`). 돌려준 `close`는 pool을 끝내고, `cut`이면(시험이 다 쓰지 못함: 상대가 멈췄을 수 있다) 그
 * 소켓들을 끊은 뒤, pool의 끝(`end()`의 이행: 모든 연결이 끝남)을 `limitMs` 안에서 확인한다.
 */
export function testPool(url: string, limitMs: number) {
  const sockets = new Set<net.Socket>();
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: limitMs,
    query_timeout: limitMs,
    stream: () => {
      const socket = new net.Socket();
      sockets.add(socket);
      return socket;
    },
  });
  return {
    pool,
    close: (cut: boolean, what: string) => {
      const ended = pool.end();
      if (cut) for (const socket of sockets) socket.destroy();
      return within(ended, limitMs, what);
    },
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
 * 돌려준 함수가 되돌린다. 한 DB에 하나만 걸 수 있다.
 */
export async function failArtifactRecord(
  db: Database
): Promise<() => Promise<void>> {
  await db.execute(`
    create function fail_artifact_record() returns trigger as $$
    begin
      if new.type = 'artifact.recorded' then
        raise exception 'artifact record could not be saved';
      end if;
      return new;
    end $$ language plpgsql;
    create trigger fail_artifact_record before insert on events
      for each row execute function fail_artifact_record();
  `);
  return async () => {
    await db.execute(
      "drop trigger fail_artifact_record on events; drop function fail_artifact_record();"
    );
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
