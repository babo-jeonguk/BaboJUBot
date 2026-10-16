import type { Agent, CreateOrganizationInput, LifecycleStage, NewEvent, Organization } from "@babojubot/contracts";

export const initialStage: LifecycleStage = "goal_setting";
export const leadAgentName = "Research Lead";

export type RecordSource = { newId: () => string; now: () => Date };

/** 조직 생성이 함께 저장해야 하는 기록. 전부 저장되거나 아무것도 저장되지 않아야 한다. */
export type OrganizationCreation = {
  organization: Organization;
  agents: Agent[];
  event: NewEvent;
};

/** 새 조직은 `목표 설정`에서 시작하고 전용 Research Lead 하나를 갖는다. */
export function planOrganizationCreation(input: CreateOrganizationInput, { newId, now }: RecordSource): OrganizationCreation {
  const createdAt = now().toISOString();
  const organization: Organization = { id: newId(), name: input.name, stage: initialStage, createdAt };
  const lead: Agent = { id: newId(), organizationId: organization.id, role: "lead", name: leadAgentName, createdAt };
  return {
    organization,
    agents: [lead],
    event: {
      organizationId: organization.id,
      type: "organization.created",
      payload: { name: organization.name, stage: organization.stage, leadAgentId: lead.id },
    },
  };
}
