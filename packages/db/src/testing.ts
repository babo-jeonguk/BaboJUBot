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
    // 만들기의 답을 받지 못해도 그 DB는 따로 지우지 않는다: 준비가 실패하면 아래 `stop`이 cluster를 멈추고 그 data 폴더째 지운다.
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
  await createDatabase(admin, name, templateName, 60_000);
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
 * 서버(`admin`)에 DB `name`을 `template`에서 만든다(`askServer`). 만들기의 답을 받지 못하면(상한·연결 실패) 서버는 그 DB를 이미
 * 만들었거나 아직 만드는 중일 수 있다: 연결을 끊어도 그 서버 쪽 연결(backend)은 잠금을 기다리는 동안 끊김을 보지 못하고, 잠금이 풀리면
 * 만들기를 마친다. 그래서 묻던 연결의 끝을 확인한 뒤(`askServer`) 그 backend를 끝내고 그 끝을 서버에서 본 다음 DB를 지운다(진행 중인
 * 만들기와 지우기가 경쟁하지 않는다). 지우기도 실패하면 두 실패를 함께 알린다.
 */
export async function createDatabase(
  admin: string,
  name: string,
  template: string,
  limitMs: number
) {
  let creator: Backend | undefined;
  try {
    await askServer(
      admin,
      async (client) => {
        creator = await backendOf(client);
        return client.query(`create database ${name} template ${template}`);
      },
      limitMs,
      `the test cluster did not create ${name}`
    );
  } catch (error) {
    throw combinedFailure(
      [
        error,
        ...(await attemptEach([
          () =>
            askServer(
              admin,
              async (client) => {
                if (creator) await endBackend(client, creator, limitMs);
                await client.query(
                  `drop database if exists ${name} with (force)`
                );
              },
              limitMs,
              `the test cluster did not drop ${name}, which it gave up creating`
            ),
        ])),
      ],
      `${name} was not created, and dropping it failed`,
      { cause: error }
    );
  }
}

/**
 * 서버 쪽 연결(backend) 하나. 번호는 그 연결이 끝나면 다른 연결에 다시 주어질 수 있어, 시작 시각(`pg_stat_activity.backend_start`,
 * 마이크로초까지 비교하려고 글자로 둔다)과 함께 신원으로 쓴다.
 */
type Backend = { pid: number; started: string };

/** `client`의 backend. */
async function backendOf(client: pg.Client): Promise<Backend> {
  const { rows } = await client.query<Backend>(
    "select pid, backend_start::text as started from pg_stat_activity where pid = pg_backend_pid()"
  );
  return rows[0]!;
}

/**
 * backend가 아직 그 연결이면 끝내고, 끝난 것을 서버에서 확인한다. `pg_terminate_backend(pid, timeout)`은 그 프로세스가 끝나기를
 * `timeout`ms까지 기다린다(PostgreSQL 문서 「Server Signaling Functions」, 14판부터). 끝은 그 뒤 `pg_stat_activity`에 그 연결이 없는
 * 것으로 본다(그 함수는 상한을 넘겨도, 이미 끝난 번호여도 거짓을 돌려준다).
 */
async function endBackend(
  client: pg.Client,
  { pid, started }: Backend,
  limitMs: number
) {
  const same = "pid = $1 and backend_start::text = $2";
  await client.query(
    `select pg_terminate_backend(pid, $3) from pg_stat_activity where ${same}`,
    [pid, started, limitMs]
  );
  const { rowCount } = await client.query(
    `select from pg_stat_activity where ${same}`,
    [pid, started]
  );
  if (rowCount !== 0)
    throw new Error(`backend ${pid} did not end within ${limitMs} ms`);
}

/** 시험이 만든 소켓. 만든 직후 그 닫힘(`close`)을 지켜본다. 연결의 끝은 이것으로만 판정한다(`endSockets`). */
function testSocket() {
  const socket = new net.Socket();
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve())
  );
  return { socket, closed };
}

type TestSocket = ReturnType<typeof testSocket>;

/**
 * 시험이 만든 소켓들(`testConnection`·`testPool`)을 끝낸다. 라이브러리의 정중한 끝(`end`)을 먼저 부른다: pg가 이 끝을 예상한 끝으로
 * 다룬다(예상하지 못한 끊김의 오류 이벤트를 내지 않는다). 끝은 라이브러리 Promise의 이행이 아니라 소켓들의 닫힘으로 본다: pg-pool의
 * `end()`는 연결을 목록에서 먼저 빼고 끝내므로 소켓이 닫히기 전에 이행할 수 있다(pg-pool 3.14 `_remove`·`_pulseQueue`). `end`의 이행과
 * 소켓들의 닫힘을 `limitMs` 안에서 확인하고, 정중한 끝이 실패하거나 상한을 넘기면(상대가 끝에 답하지 않음) 끊고 닫힘을 다시 `limitMs`
 * 안에서 확인한다. 끊어 닫았어도 정중한 끝의 실패는 알리고, 끊어도 닫히지 않으면 두 실패를 함께 알린다. `cut`이면(상대가 답하지
 * 않았거나 멈췄을 수 있다) 처음부터 끊고, 끝은 마찬가지로 소켓들의 닫힘으로 본다.
 */
async function endSockets(
  sockets: Iterable<TestSocket>,
  end: () => Promise<unknown>,
  cut: boolean,
  limitMs: number,
  what: string
) {
  const owned = [...sockets];
  const closed = Promise.all(owned.map(({ closed }) => closed));
  const ended = new Promise((resolve) => resolve(end()));
  const cutAll = () => {
    for (const { socket } of owned) socket.destroy();
  };
  const settled = () =>
    within(Promise.all([ended, closed]), limitMs, what).then(() => {});
  if (cut) {
    cutAll();
    return settled();
  }
  const polite = await attemptEach([settled]);
  if (polite.length === 0) return;
  cutAll();
  throw combinedFailure(
    [
      ...polite,
      ...(await attemptEach([
        () => within(closed, limitMs, `${what}, even after it was cut`),
      ])),
    ],
    `${what} politely, and cutting it did not close it either`,
    { cause: polite[0] }
  );
}

/**
 * 시험이 여는 pg 연결. 연결의 소켓은 시험이 만든다(pg 설정 `stream`, `@types/pg` `ConnectionConfig.stream`). `close`는 그 연결을
 * 끝내고 소켓의 닫힘을 확인한다(`endSockets`). pg의 `end()`는 답 없는 질의가 있으면 소켓을 닫지만 연결 중이거나 쉬는 연결은 정중히
 * 끝내며 상대의 끝을 기다린다(pg 8.23 `lib/client.js` `end`). 상대가 답하지 않았거나 멈췄을 수 있으면 `cut`으로 처음부터 끊는다.
 * 제품 `withClient`는 시한을 두지 않으므로 시험의 연결에 쓰지 않는다.
 */
export function testConnection(url: string) {
  const owned = testSocket();
  const client = new pg.Client({
    connectionString: url,
    stream: () => owned.socket,
  });
  return {
    client,
    close: (cut: boolean, limitMs: number, what: string) =>
      endSockets([owned], () => client.end(), cut, limitMs, what),
  };
}

/**
 * 시험이 서버(`url`)에 `ask`로 묻는다(`testConnection`). 연결과 묻기를 합쳐 `limitMs` 안에 끝나지 않으면 `what`으로 실패하고, 성공·실패
 * 모두 그 연결을 끝내고 끝난 것을 확인한다(CODING_STANDARDS 「정리」). 상한이 거절만 하면 연결 시도나 묻기가 그대로 돌아 연결이 남는다.
 * 답을 받았으면 정중히 끝내고(끝나지 않으면 끊고 그 실패를 알린다), 받지 못했으면 끊는다.
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
 * 소켓은 시험이 만든다(pg 설정 `stream`). 돌려준 `close`는 pool을 끝내고 그 연결들의 소켓이 모두 닫힌 것을 확인한다(`endSockets`).
 * 시험이 다 쓰지 못했으면(상대가 멈췄을 수 있다) `cut`으로 처음부터 끊는다.
 */
export function testPool(url: string, limitMs: number) {
  const sockets = new Set<TestSocket>();
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: limitMs,
    query_timeout: limitMs,
    stream: () => {
      const owned = testSocket();
      sockets.add(owned);
      return owned.socket;
    },
  });
  return {
    pool,
    close: (cut: boolean, what: string) =>
      endSockets(sockets, () => pool.end(), cut, limitMs, what),
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
