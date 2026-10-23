import type {
  Event,
  Organization,
  OrganizationDetail,
  UpdateApprovalPolicyInput,
} from "@babojubot/contracts";
import {
  planApprovalPolicyChange,
  type OrganizationCreation,
} from "@babojubot/core";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { insertInstructionCopies } from "./harness.ts";
import {
  agentRow,
  insertEvent,
  isUuid,
  lockOrganization,
  organizationRow,
  toAgent,
  toEvent,
  toOrganization,
} from "./rows.ts";
import { agents, events, organizations } from "./schema.ts";

/** 조직·에이전트·Lead 지침 사본·Event를 한 transaction으로 저장하고 저장된 Event를 돌려준다. 하나라도 실패하면 아무것도 남지 않는다. */
export async function insertOrganizationCreation(
  db: Database,
  records: OrganizationCreation
): Promise<Event> {
  return db.transaction(async (tx) => {
    const { organization } = records;
    await tx.insert(organizations).values(organizationRow(organization));
    await tx.insert(agents).values(records.agents.map(agentRow));
    await insertInstructionCopies(tx, records.instructionCopies);
    return insertEvent(tx, records.event);
  });
}

export type PolicyChange =
  | { kind: "changed"; organization: Organization; event: Event }
  | { kind: "unchanged"; organization: Organization }
  | { kind: "not_found" };

/**
 * 사용자의 승인 정책 변경 제어 명령. 조직 행 잠금 아래에서 바꾸고 그 Event를 같은 transaction에 남긴다.
 * 조직 도구 쓰기도 같은 잠금 아래에서 정책을 읽으므로, 작업자 추가는 바뀌기 전 정책이나 바뀐 뒤 정책 하나로만 갈린다.
 */
export async function updateApprovalPolicy(
  db: Database,
  organizationId: string,
  input: UpdateApprovalPolicyInput
): Promise<PolicyChange> {
  if (!isUuid(organizationId)) return { kind: "not_found" };
  return db.transaction(async (tx) => {
    const row = await lockOrganization(tx, organizationId);
    if (!row) return { kind: "not_found" };
    const organization = toOrganization(row);
    const change = planApprovalPolicyChange(organization, input);
    if (!change) return { kind: "unchanged", organization };
    const [updated] = await tx
      .update(organizations)
      .set({ addWorkerApproval: change.policy.addWorker })
      .where(eq(organizations.id, organizationId))
      .returning();
    const event = await insertEvent(tx, change.event);
    return { kind: "changed", organization: toOrganization(updated!), event };
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
