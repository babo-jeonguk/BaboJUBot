import { randomUUID } from "node:crypto";
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
import { agentRow, insertEvent, organizationRow } from "./rows.ts";
import { agents, conversations, organizations } from "./schema.ts";

export { freePort } from "./client.ts";

export type TestDatabase = DatabaseHandle;

/** 테스트 실행이 띄운 cluster의 port를 담는 환경 변수. vitest globalSetup이 정하고 작업자 프로세스가 물려받는다. */
const clusterPortEnv = "BABOJUBOT_TEST_CLUSTER_PORT";
const templateName = "babojubot_template";
// 테스트 DB는 버리므로 디스크에 내려 쓰기를 기다리지 않는다. 서버 테스트 파일들이 동시에 연결을 연다.
const testSettings = [
  "fsync=off",
  "synchronous_commit=off",
  "full_page_writes=off",
  "max_connections=500",
];

/**
 * 테스트 실행 하나가 같이 쓰는 embedded Postgres를 띄우고, migration을 적용한 원본 DB를 만든다.
 * vitest globalSetup용이다. 돌려준 함수가 cluster를 멈추고 dataDir를 지운다.
 */
export async function startTestCluster(): Promise<() => Promise<void>> {
  const options = await ephemeralCluster();
  const stop = await startEmbeddedCluster(options, testSettings);
  try {
    await withClient(clusterUrl(options.port, "postgres"), (client) =>
      client.query(`create database ${templateName}`)
    );
    // 원본에 연결이 남으면 복제할 수 없으므로 migration 뒤 바로 닫는다.
    await (
      await openDatabase({ url: clusterUrl(options.port, templateName) })
    ).close();
    process.env[clusterPortEnv] = String(options.port);
    return async () => {
      delete process.env[clusterPortEnv];
      await stop();
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * 테스트마다 따로 쓰는 DB. 테스트 실행이 띄운 cluster(`startTestCluster`)에 원본 DB를 복제하며,
 * `close`가 그 DB를 지운다.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const port = Number(process.env[clusterPortEnv]);
  if (!port)
    throw new Error(
      "테스트 cluster가 없습니다. vitest 설정의 globalSetup에 packages/db/src/test-cluster.ts를 넣으세요."
    );
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
