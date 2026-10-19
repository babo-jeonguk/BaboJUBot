import type {
  Event,
  Organization,
  OrganizationDetail,
} from "@babojubot/contracts";
import type { OrganizationCreation } from "@babojubot/core";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  insertEvent,
  instructionCopyRow,
  isUuid,
  toAgent,
  toEvent,
  toOrganization,
} from "./rows.ts";
import { agents, events, instructionCopies, organizations } from "./schema.ts";

/** 조직·에이전트·Lead 지침 사본·Event를 한 transaction으로 저장하고 저장된 Event를 돌려준다. 하나라도 실패하면 아무것도 남지 않는다. */
export async function insertOrganizationCreation(
  db: Database,
  records: OrganizationCreation
): Promise<Event> {
  return db.transaction(async (tx) => {
    const { organization } = records;
    await tx
      .insert(organizations)
      .values({ ...organization, createdAt: new Date(organization.createdAt) });
    await tx
      .insert(agents)
      .values(
        records.agents.map((a) => ({ ...a, createdAt: new Date(a.createdAt) }))
      );
    if (records.instructionCopies.length)
      await tx
        .insert(instructionCopies)
        .values(records.instructionCopies.map(instructionCopyRow));
    return insertEvent(tx, records.event);
  });
}

export async function listOrganizations(db: Database): Promise<Organization[]> {
  const rows = await db
    .select()
    .from(organizations)
    .orderBy(asc(organizations.createdAt), asc(organizations.id));
  return rows.map(toOrganization);
}

export async function findOrganization(
  db: Database,
  id: string
): Promise<OrganizationDetail | undefined> {
  if (!isUuid(id)) return undefined;
  const row = await db.query.organizations.findFirst({
    where: eq(organizations.id, id),
  });
  if (!row) return undefined;
  const members = await db
    .select()
    .from(agents)
    .where(eq(agents.organizationId, id))
    .orderBy(asc(agents.createdAt));
  return { ...toOrganization(row), agents: members.map(toAgent) };
}

/** 조직의 Event log. `agentId`를 주면 그 에이전트에 귀속된 Event만 돌려준다. */
export async function listOrganizationEvents(
  db: Database,
  organizationId: string,
  { agentId }: { agentId?: string } = {}
): Promise<Event[]> {
  if (!isUuid(organizationId)) return [];
  if (agentId !== undefined && !isUuid(agentId)) return [];
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.organizationId, organizationId),
        agentId === undefined ? undefined : eq(events.agentId, agentId)
      )
    )
    .orderBy(asc(events.id));
  return rows.map(toEvent);
}
