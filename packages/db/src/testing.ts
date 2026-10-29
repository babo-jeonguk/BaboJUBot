import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  planOrganizationCreation,
  type AgentRoleSource,
} from "@babojubot/core";
import {
  clusterUrl,
  freePort,
  openDatabase,
  openEphemeralDatabase,
  startEmbeddedCluster,
  type Database,
  type DatabaseHandle,
} from "./client.ts";
import { insertInstructionCopies } from "./harness.ts";
import { conversationRow } from "./conversations.ts";
import { agentRow, insertEvent, organizationRow } from "./rows.ts";
import { agents, conversations, organizations } from "./schema.ts";

export { freePort } from "./client.ts";

export type TestDatabase = DatabaseHandle;

/** 검사 실행이 띄운 cluster의 관리 DB 주소. vitest globalSetup이 정하고 작업자 프로세스가 물려받는다. */
const clusterVariable = "BABOJUBOT_TEST_CLUSTER_URL";
const templateName = "babojubot_template";
// 검사 DB는 버리므로 디스크에 내려 쓰기를 기다리지 않는다. 서버 검사 파일들이 동시에 연결을 연다.
const testSettings = [
  "fsync=off",
  "synchronous_commit=off",
  "full_page_writes=off",
  "max_connections=500",
];

/**
 * 검사 실행 하나가 같이 쓰는 embedded Postgres를 띄우고, migration을 적용한 원본 DB를 만든다.
 * vitest globalSetup용이다. 돌려준 함수가 cluster를 멈추고 dataDir를 지운다.
 */
export async function startTestCluster(): Promise<() => Promise<void>> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
  const port = await freePort();
  const stop = await startEmbeddedCluster(
    { dataDir, port, persistent: false },
    testSettings
  );
  try {
    const admin = clusterUrl(port, "postgres");
    await runAdmin(admin, `create database ${templateName}`);
    // 원본에 연결이 남으면 복제할 수 없으므로 migration 뒤 바로 닫는다.
    await (await openDatabase({ url: clusterUrl(port, templateName) })).close();
    process.env[clusterVariable] = admin;
    return async () => {
      delete process.env[clusterVariable];
      await stop();
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * 검사마다 따로 쓰는 DB. 검사 실행이 cluster를 띄웠으면(`startTestCluster`) 원본 DB를 복제하고,
 * 아니면 임시 embedded Postgres를 띄운다. `close`가 그 DB(또는 cluster)를 지운다.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const admin = process.env[clusterVariable];
  if (!admin) return openEphemeralDatabase();
  const name = `test_${randomUUID().replaceAll("-", "")}`;
  await runAdmin(admin, `create database ${name} template ${templateName}`);
  const drop = () =>
    runAdmin(admin, `drop database if exists ${name} with (force)`);
  let handle: DatabaseHandle;
  try {
    const url = new URL(admin);
    url.pathname = `/${name}`;
    handle = await openDatabase({ url: url.toString() });
  } catch (error) {
    await drop();
    throw error;
  }
  return {
    ...handle,
    close: async () => {
      try {
        await handle.close();
      } finally {
        await drop();
      }
    },
  };
}

async function runAdmin(url: string, sql: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
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
  const creation = planOrganizationCreation({ name, goal: "-" }, leadRole, {
    newId: randomUUID,
    now: () => new Date(),
  });
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
