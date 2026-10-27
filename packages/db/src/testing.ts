import { randomUUID } from "node:crypto";
import {
  planOrganizationCreation,
  type AgentRoleSource,
} from "@babojubot/core";
import {
  openEphemeralDatabase,
  type Database,
  type DatabaseHandle,
} from "./client.ts";
import { insertInstructionCopies } from "./harness.ts";
import { conversationRow } from "./conversations.ts";
import { agentRow, insertEvent, organizationRow } from "./rows.ts";
import { agents, conversations, organizations } from "./schema.ts";

export { freePort } from "./client.ts";

export type TestDatabase = DatabaseHandle;

/** 테스트마다 따로 쓰는 임시 embedded Postgres. */
export const createTestDatabase = openEphemeralDatabase;

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
