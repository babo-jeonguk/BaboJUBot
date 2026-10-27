import {
  defaultApprovalPolicy,
  defaultHeartbeatMinutes,
  type Agent,
  type ApprovalPolicy,
  type Conversation,
  type CreateOrganizationInput,
  type InstructionCopy,
  type InstructionSourceFile,
  type LifecycleStage,
  type NewEvent,
  type Organization,
  type UpdateApprovalPolicyInput,
} from "@babojubot/contracts";
import { copyInstructions } from "./harness.ts";
import { planDefaultConversation, type Wake } from "./run.ts";

/** 새 조직은 사용자가 생성 때 연구 목표를 적으므로 목표 설정을 건너뛰고 계획 수립에서 시작한다. */
export const initialStage: LifecycleStage = "planning";
export const leadAgentName = "Research Lead";

export type RecordSource = { newId: () => string; now: () => Date };

/**
 * 새 에이전트와 Role에서 받은 기본 heartbeat 간격(분). heartbeat는 꺼진 채로 생긴다.
 * 얼굴은 저장하지 않고 ID에서 정한 기본 얼굴로 시작한다.
 */
export type NewAgent = Omit<Agent, "appearance"> & { heartbeatMinutes: number };

/** 에이전트가 생길 때 받는 하네스 Role 내용: 지침 원본과 기본 heartbeat 간격. */
export type AgentRoleSource = {
  files: InstructionSourceFile[];
  heartbeatMinutes?: number;
};

/** 조직 생성이 함께 저장해야 하는 기록. 전부 저장되거나 아무것도 저장되지 않아야 한다. */
export type OrganizationCreation = {
  organization: Organization;
  agents: NewAgent[];
  instructionCopies: InstructionCopy[];
  /** 사용자와 Lead의 기본 대화. */
  defaultConversation: Conversation;
  wake: Wake;
  event: NewEvent;
};

/**
 * 새 조직은 사용자가 적은 연구 목표와 완료 기준(비웠으면 없음)을 가진 채 `계획 수립`에서 시작하고,
 * 전용 Research Lead 하나와 그 Lead와의 기본 대화를 가지며 승인 정책은 모두 꺼져 있다. 목표는 사용자 입력이므로 생성 Event가 그 내용을 남긴다.
 * Lead는 하네스 라이브러리의 Lead Role에서 복사한 자기 Role·Soul 사본과 기본 heartbeat 간격을 받고,
 * 초기 연구 승인 요청을 준비하도록 곧바로 깨어난다.
 */
export function planOrganizationCreation(
  input: CreateOrganizationInput,
  leadRole: AgentRoleSource,
  { newId, now }: RecordSource
): OrganizationCreation {
  const createdAt = now().toISOString();
  const organization: Organization = {
    id: newId(),
    name: input.name,
    stage: initialStage,
    goal: input.goal,
    completionCriteria: input.completionCriteria || null,
    approvalPolicy: defaultApprovalPolicy,
    pausedFrom: null,
    createdAt,
  };
  const lead: NewAgent = {
    id: newId(),
    organizationId: organization.id,
    role: "lead",
    name: leadAgentName,
    createdAt,
    heartbeatMinutes: leadRole.heartbeatMinutes ?? defaultHeartbeatMinutes,
  };
  return {
    organization,
    agents: [lead],
    instructionCopies: copyInstructions(lead, leadRole.files, {
      newId,
      createdAt,
    }),
    defaultConversation: planDefaultConversation(organization.id, {
      id: newId(),
      createdAt,
    }),
    wake: {
      id: newId(),
      organizationId: organization.id,
      agentId: lead.id,
      kind: "organization_created",
      createdAt,
    },
    event: {
      organizationId: organization.id,
      type: "organization.created",
      payload: {
        name: organization.name,
        stage: organization.stage,
        leadAgentId: lead.id,
        goal: input.goal,
        completionCriteria: organization.completionCriteria,
        wokenAgentId: lead.id,
      },
    },
  };
}

/**
 * 사용자의 승인 정책 변경. 바뀐 정책과 그 Event를 돌려주고, 값이 그대로면 `undefined`다.
 * 이미 결정을 기다리는 승인 요청은 그대로 두며, 바뀐 정책은 이후의 도구 호출에만 적용된다(#58 사용자 결정).
 */
export function planApprovalPolicyChange(
  organization: { id: string; approvalPolicy: ApprovalPolicy },
  input: UpdateApprovalPolicyInput
): { policy: ApprovalPolicy; event: NewEvent } | undefined {
  const previous = organization.approvalPolicy;
  const policy: ApprovalPolicy = { ...previous, ...input };
  if (policy.addWorker === previous.addWorker) return undefined;
  return {
    policy,
    event: {
      organizationId: organization.id,
      type: "organization.approval_policy_changed",
      payload: { by: "owner", previous, policy },
    },
  };
}
