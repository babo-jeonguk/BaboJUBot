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

/**
 * 조직별 승인 정책(ADR-0003). 켜진 항목의 도구 호출은 제품이 승인 요청으로 바꾸고, 새 조직은 모든 항목이 꺼져 있다.
 * 첫 판의 항목은 작업자 추가뿐이다. 초기 연구 승인과 최종 완료는 항상 사용자 결정이라 항목이 아니다.
 */
export const approvalPolicySchema = z.object({ addWorker: z.boolean() });
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export const defaultApprovalPolicy: ApprovalPolicy = { addWorker: false };

/** 승인 정책 변경 제어 명령. 사용자만 바꾸며 조직 도구가 없다. */
export const updateApprovalPolicyInputSchema = z.strictObject({
  addWorker: z.boolean(),
});
export type UpdateApprovalPolicyInput = z.infer<
  typeof updateApprovalPolicyInputSchema
>;

/** 연구 조직. 연구 목표와 완료 기준은 목표 설정에서 Lead가 기록하기 전에는 없다. */
export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  stage: lifecycleStageSchema,
  goal: z.string().nullable(),
  completionCriteria: z.string().nullable(),
  approvalPolicy: approvalPolicySchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationDetailSchema = organizationSchema.extend({
  agents: z.array(agentSchema),
});
export type OrganizationDetail = z.infer<typeof organizationDetailSchema>;

export const organizationListSchema = z.array(organizationSchema);
