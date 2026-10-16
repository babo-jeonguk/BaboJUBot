import { z } from "zod";

/** 조직 생애주기. 중단은 어느 단계에서든 갈 수 있다(docs/architecture.md). */
export const lifecycleStages = [
  "goal_setting",
  "planning",
  "awaiting_approval",
  "researching",
  "paused",
  "result_review",
  "completed",
  "stopped",
] as const;
export const lifecycleStageSchema = z.enum(lifecycleStages);
export type LifecycleStage = z.infer<typeof lifecycleStageSchema>;

export const agentRoles = ["lead", "worker"] as const;
export const agentRoleSchema = z.enum(agentRoles);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const organizationNameMaxLength = 120;

/** 조직 생성 입력. 이름만 받고 ID·단계·Lead는 서버가 정한다. */
export const createOrganizationInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(organizationNameMaxLength),
});
export type CreateOrganizationInput = z.infer<
  typeof createOrganizationInputSchema
>;

export const agentSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  role: agentRoleSchema,
  name: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Agent = z.infer<typeof agentSchema>;

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  stage: lifecycleStageSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationDetailSchema = organizationSchema.extend({
  agents: z.array(agentSchema),
});
export type OrganizationDetail = z.infer<typeof organizationDetailSchema>;

export const organizationListSchema = z.array(organizationSchema);
