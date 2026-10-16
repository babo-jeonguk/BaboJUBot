import type { Agent, Event, Organization, OrganizationDetail } from "@babojubot/contracts";
import type { OrganizationCreation } from "@babojubot/core";
import { asc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { agents, events, organizations } from "./schema.ts";

/** 조직·에이전트·Event를 한 transaction으로 저장하고 저장된 Event를 돌려준다. 하나라도 실패하면 아무것도 남지 않는다. */
export async function insertOrganizationCreation(db: Database, records: OrganizationCreation): Promise<Event> {
  return db.transaction(async (tx) => {
    const { organization } = records;
    await tx.insert(organizations).values({ ...organization, createdAt: new Date(organization.createdAt) });
    await tx.insert(agents).values(records.agents.map((a) => ({ ...a, createdAt: new Date(a.createdAt) })));
    const [row] = await tx.insert(events).values(records.event).returning();
    return toEvent(row!);
  });
}

export async function listOrganizations(db: Database): Promise<Organization[]> {
  const rows = await db.select().from(organizations).orderBy(asc(organizations.createdAt), asc(organizations.id));
  return rows.map(toOrganization);
}

export async function findOrganization(db: Database, id: string): Promise<OrganizationDetail | undefined> {
  if (!isUuid(id)) return undefined;
  const row = await db.query.organizations.findFirst({ where: eq(organizations.id, id) });
  if (!row) return undefined;
  const members = await db.select().from(agents).where(eq(agents.organizationId, id)).orderBy(asc(agents.createdAt));
  return { ...toOrganization(row), agents: members.map(toAgent) };
}

export async function listOrganizationEvents(db: Database, organizationId: string): Promise<Event[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db.select().from(events).where(eq(events.organizationId, organizationId)).orderBy(asc(events.id));
  return rows.map(toEvent);
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** DB 행의 시각을 계약의 ISO 문자열로 바꾼다. */
const withIsoTime = <T extends { createdAt: Date }>(row: T) => ({ ...row, createdAt: row.createdAt.toISOString() });
const toOrganization = (row: typeof organizations.$inferSelect): Organization => withIsoTime(row);
const toAgent = (row: typeof agents.$inferSelect): Agent => withIsoTime(row);
const toEvent = (row: typeof events.$inferSelect): Event => withIsoTime(row) as Event;
