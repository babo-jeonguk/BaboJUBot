import { z } from "zod";
import { agentAppearanceSchema } from "./agent-profile.ts";
import {
  modelIdSchema,
  providerChoiceSchema,
  providerIdSchema,
} from "./provider.ts";

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
/**
 * 에이전트 제어 명령: 일시정지·재개·실행 중단. 조직 제어와 따로 저장한다.
 * 실행 중단(`interrupt`)은 메시지 없이 지금 실행 시도만 취소하고 일시정지하지 않으므로, 이후 깨우기는 그대로 실행 시도를 시작한다.
 */
export const agentCommands = ["pause", "resume", "interrupt"] as const;
export type AgentCommand = (typeof agentCommands)[number];

export const agentRoles = ["lead", "worker"] as const;
export const agentRoleSchema = z.enum(agentRoles);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const organizationNameMaxLength = 120;
/** 연구 목표·완료 기준 한 칸의 최대 글자 수. */
export const goalMaxLength = 4_000;

/**
 * 조직 생성 입력. 사용자가 이름·연구 목표와, 정했다면 완료 기준을 적는다. ID·단계·Lead는 서버가 정한다.
 * 완료 기준을 비우면(빈 칸·생략) 조직은 완료 기준 없이 시작하고, Lead가 초기 연구 승인 요청에서 제안한다.
 * `lead`는 Lead의 프로바이더·모델이며, 생략하면 전역 Lead 기본값을 복사한다.
 */
export const createOrganizationInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(organizationNameMaxLength),
  goal: z.string().trim().min(1).max(goalMaxLength),
  completionCriteria: z.string().trim().max(goalMaxLength).optional(),
  lead: providerChoiceSchema.optional(),
});
export type CreateOrganizationInput = z.infer<
  typeof createOrganizationInputSchema
>;

export const agentSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  role: agentRoleSchema,
  name: z.string(),
  /** 얼굴. 사용자가 고르지 않았으면 ID에서 정한 기본 얼굴이다. */
  appearance: agentAppearanceSchema,
  /** 실행 시도를 맡는 프로바이더 연결. 만들 때 역할의 전역 기본값을 복사하고 사용자만 바꾼다. */
  provider: providerIdSchema,
  /** 모델. 없으면 프로바이더의 기본 모델이다. */
  model: modelIdSchema.nullable(),
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

/**
 * 연구 조직. 연구 목표는 사용자가 생성 때 적는다. 완료 기준은 사용자가 비워 두었으면 Lead가 제안한 기준을
 * 초기 연구 승인으로 정하기 전까지 없다. 이 규칙 전에 만든 `목표 설정` 조직은 Lead가 기록하기 전까지 둘 다 없다.
 */
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
