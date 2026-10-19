import type { AgentInstructions, FlowTemplateCopy } from "@babojubot/contracts";
import { instructionsBundleVersion } from "@babojubot/core";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { isUuid, toInstructionCopy, withIsoTime } from "./rows.ts";
import { agents, flowTemplates, instructionCopies } from "./schema.ts";

/** 에이전트의 Role·Soul·Skill 사본과 그 내용의 bundle 버전. 다른 조직의 에이전트와 없는 에이전트를 구별하지 않는다. */
export async function findAgentInstructions(
  db: Database,
  organizationId: string,
  agentId: string
): Promise<AgentInstructions | undefined> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return undefined;
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.organizationId, organizationId), eq(agents.id, agentId))
    );
  if (!agent) return undefined;
  const rows = await db
    .select()
    .from(instructionCopies)
    .where(
      and(
        eq(instructionCopies.organizationId, organizationId),
        eq(instructionCopies.agentId, agentId)
      )
    )
    .orderBy(asc(instructionCopies.path));
  const copies = rows.map(toInstructionCopy);
  return {
    agentId,
    bundleVersion: instructionsBundleVersion(copies),
    copies,
  };
}

/** 조직의 연구 흐름 템플릿 사본. 초기 연구 승인 전에는 없다. */
export async function findFlowTemplate(
  db: Database,
  organizationId: string
): Promise<FlowTemplateCopy | undefined> {
  if (!isUuid(organizationId)) return undefined;
  const [row] = await db
    .select()
    .from(flowTemplates)
    .where(eq(flowTemplates.organizationId, organizationId));
  return row && withIsoTime(row);
}
