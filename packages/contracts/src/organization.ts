import { z } from "zod";

/**
 * 조직 생애주기. 일시정지·중단은 최종 완료 전 어느 단계에서든 걸 수 있고, 일시정지는 재개하면 직전 단계로 돌아간다.
 * 최종 완료와 중단은 되돌릴 수 없는 끝이다(docs/architecture.md).
 */
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

/** 끝난 단계. 제어 명령(일시정지·재개·중단)을 받지 않는다. */
export const closedStages = [
  "completed",
  "stopped",
] as const satisfies readonly LifecycleStage[];
export const isClosedStage = (stage: LifecycleStage) =>
  (closedStages as readonly LifecycleStage[]).includes(stage);

/** 조직 제어 명령: 일시정지·재개·중단. 사용자만 내리며 조직 도구가 없다. */
export const organizationCommands = ["pause", "resume", "stop"] as const;
export type OrganizationCommand = (typeof organizationCommands)[number];
/** 에이전트 제어 명령: 일시정지·재개. 조직 제어와 따로 저장한다. */
export const agentCommands = ["pause", "resume"] as const;
export type AgentCommand = (typeof agentCommands)[number];

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
  /** 일시정지 전 단계. 재개하면 이 단계로 돌아간다. 일시정지 중이 아니면 없다. */
  pausedFrom: lifecycleStageSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationDetailSchema = organizationSchema.extend({
  agents: z.array(agentSchema),
});
export type OrganizationDetail = z.infer<typeof organizationDetailSchema>;

export const organizationListSchema = z.array(organizationSchema);
