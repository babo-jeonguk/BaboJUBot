import { z } from "zod";
import {
  flowTemplateSnapshotSchema,
  harnessNameSchema,
  instructionSourceFileSchema,
} from "./harness.ts";
import { heartbeatIntervalSchema } from "./heartbeat.ts";
import { agentSchema, goalMaxLength } from "./organization.ts";
import {
  modelIdSchema,
  providerChoiceSchema,
  providerIdSchema,
  type ProviderChoice,
} from "./provider.ts";

// 목표 기록과 승인 요청. 초기 연구 승인은 끌 수 없는 사용자 결정이고, 작업자 추가는 조직별 승인 정책을 따른다(ADR-0003).

const longText = (max: number) => z.string().trim().min(1).max(max);
export const proposalTextMaxLength = 20_000;
export const decisionNoteMaxLength = 4_000;

/** Lead의 목표·완료 기준 기록. 목표 없이 만든 예전 조직(`목표 설정`)에서만 쓴다. 조직은 실행 시도별 토큰이 정한다. */
export const recordGoalInputSchema = z.strictObject({
  goal: longText(goalMaxLength),
  completionCriteria: longText(goalMaxLength),
});
export type RecordGoalInput = z.infer<typeof recordGoalInputSchema>;

/**
 * Lead가 제안하는 작업자의 프로바이더·모델 칸. 프로바이더를 비우면 요청할 때의 전역 작업자 기본값이고,
 * 프로바이더만 적으면 그 프로바이더의 기본 모델이다. 모델만 적을 수는 없다.
 */
const proposedChoiceFields = {
  provider: providerIdSchema.optional(),
  model: modelIdSchema.nullable().optional(),
};
export type ProposedChoiceInput = {
  provider?: string;
  model?: string | null;
};
const modelNeedsProvider = {
  check: (input: ProposedChoiceInput) =>
    input.model == null || input.provider !== undefined,
  params: { message: "모델은 프로바이더와 함께 적는다", path: ["model"] },
};
/** Lead가 직접 적은 프로바이더·모델. 비웠으면 없다. 서버가 등록된 연결·모델인지 확인한다. */
export const explicitProposedChoice = (
  input: ProposedChoiceInput
): ProviderChoice | undefined =>
  input.provider === undefined
    ? undefined
    : { provider: input.provider, model: input.model ?? null };
/** Lead가 적은 칸에서 프로바이더·모델 하나를 정한다. 프로바이더를 비웠으면 `workerDefault`다. */
export const resolveProposedChoice = (
  input: ProposedChoiceInput,
  workerDefault: ProviderChoice
): ProviderChoice => explicitProposedChoice(input) ?? workerDefault;

/** 팀 구성 줄 수와 한 줄의 인원 상한. */
export const maxTeamLines = 10;
export const maxTeamLineCount = 10;

/**
 * Lead의 초기 연구 승인 요청. 계획·팀 구성·연구 환경 명세·연구 흐름 템플릿을 하나로 제출한다.
 * 팀 구성은 하네스 라이브러리의 작업자 Role 이름과 인원, 그 작업자들의 프로바이더·모델 제안이다. 연구 환경 명세는 문서로만 다룬다.
 * 조직에 완료 기준이 없으면 Lead가 제안하는 완료 기준(`completionCriteria`)을 함께 내야 하고,
 * 이미 있으면 낼 수 없다. 이 규칙은 제품이 강제한다(core `buildInitialResearchProposal`).
 */
export const requestInitialApprovalInputSchema = z.strictObject({
  plan: longText(proposalTextMaxLength),
  completionCriteria: longText(goalMaxLength).optional(),
  environment: longText(proposalTextMaxLength),
  team: z
    .array(
      z
        .strictObject({
          role: harnessNameSchema,
          count: z.number().int().min(1).max(maxTeamLineCount),
          ...proposedChoiceFields,
        })
        .refine(modelNeedsProvider.check, modelNeedsProvider.params)
    )
    .min(1)
    .max(maxTeamLines)
    .refine((team) => new Set(team.map((m) => m.role)).size === team.length, {
      message: "Role은 한 번씩만 적는다",
    }),
  template: harnessNameSchema,
});
export type RequestInitialApprovalInput = z.infer<
  typeof requestInitialApprovalInputSchema
>;

/**
 * 사용자가 검토하고 승인하는 내용 그대로의 snapshot. 제출할 때 서버가 하네스 라이브러리에서 읽어 고정하고,
 * 승인하면 라이브러리를 다시 읽지 않고 이 내용으로 팀의 사본과 조직 템플릿 사본을 만든다.
 */
export const initialResearchProposalSchema = z.object({
  goal: z.string(),
  completionCriteria: z.string(),
  /**
   * 조직에 완료 기준이 없어 Lead가 이 요청에서 제안한 기준이면 참이다. 승인하면 조직의 완료 기준이 되고,
   * 반려·수정 요청이면 조직은 계속 완료 기준이 없다. 이 필드가 생기기 전의 요청에는 없다(조직의 기준).
   */
  completionCriteriaProposed: z.boolean().optional(),
  plan: z.string(),
  environment: z.string(),
  team: z.array(
    z.object({
      role: harnessNameSchema,
      label: z.string(),
      count: z.number().int().positive(),
      files: z.array(instructionSourceFileSchema),
      /** Role의 기본 heartbeat 간격(분). 이 필드가 생기기 전의 요청에는 없다. */
      heartbeatMinutes: heartbeatIntervalSchema.optional(),
      /** 이 줄 작업자들의 Lead 제안 프로바이더·모델. 비웠으면 요청 때의 작업자 기본값이다. 이 필드가 생기기 전의 요청에는 없다. */
      choice: providerChoiceSchema.optional(),
    })
  ),
  template: flowTemplateSnapshotSchema,
});
export type InitialResearchProposal = z.infer<
  typeof initialResearchProposalSchema
>;

/** Lead의 작업자 추가. 하네스 라이브러리의 작업자 Role 이름 하나와 프로바이더·모델 제안으로 작업자 한 명을 더한다. */
export const addWorkerInputSchema = z
  .strictObject({ role: harnessNameSchema, ...proposedChoiceFields })
  .refine(modelNeedsProvider.check, modelNeedsProvider.params);
export type AddWorkerInput = z.infer<typeof addWorkerInputSchema>;

/**
 * 작업자 추가 승인 요청의 snapshot. 호출할 때 서버가 라이브러리에서 읽은 Role·Soul·Skill 내용 그대로이며,
 * 승인하면 라이브러리를 다시 읽지 않고 이 내용으로 새 작업자의 사본을 만든다.
 */
export const addWorkerProposalSchema = z.object({
  role: harnessNameSchema,
  label: z.string(),
  files: z.array(instructionSourceFileSchema),
  /** Role의 기본 heartbeat 간격(분). 이 필드가 생기기 전의 요청에는 없다. */
  heartbeatMinutes: heartbeatIntervalSchema.optional(),
  /** Lead 제안 프로바이더·모델. 비웠으면 호출 때의 작업자 기본값이다. 이 필드가 생기기 전의 요청에는 없다. */
  choice: providerChoiceSchema.optional(),
});
export type AddWorkerProposal = z.infer<typeof addWorkerProposalSchema>;

export const approvalKinds = ["initial_research", "add_worker"] as const;
export const approvalKindSchema = z.enum(approvalKinds);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

/** 승인 요청 상태. `pending` 밖의 값은 모두 결정이며 다시 바뀌지 않는다. */
export const approvalStatuses = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
] as const;
export const approvalStatusSchema = z.enum(approvalStatuses);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** 사용자의 결정. 결정마다 승인 요청 상태 하나가 된다. */
export const approvalDecisions = [
  "approve",
  "reject",
  "request_changes",
] as const;
export const approvalDecisionSchema = z.enum(approvalDecisions);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** 종류마다 사용자가 내릴 수 있는 결정. 작업자 추가에는 수정 요청이 없다. */
export const approvalKindDecisions = {
  initial_research: approvalDecisions,
  add_worker: ["approve", "reject"],
} as const satisfies Record<ApprovalKind, readonly ApprovalDecision[]>;

/** 승인 요청 하나로 생기는 작업자 수의 최댓값. */
export const maxProposedWorkers = maxTeamLines * maxTeamLineCount;

/**
 * 승인 결정 제어 명령. 반려와 수정 요청은 Lead를 깨울 사유가 필요하다.
 * 승인할 때는 생길 작업자마다의 프로바이더·모델(`choices`)을 {@link proposedWorkers} 순서대로 모두 낼 수 있다.
 * 비우면 Lead 제안 그대로다. 승인 밖의 결정에는 낼 수 없다.
 */
export const decideApprovalInputSchema = z
  .strictObject({
    decision: approvalDecisionSchema,
    note: z.string().trim().max(decisionNoteMaxLength).optional(),
    choices: z
      .array(providerChoiceSchema)
      .min(1)
      .max(maxProposedWorkers)
      .optional(),
  })
  .refine((input) => input.decision === "approve" || !!input.note, {
    message: "반려와 수정 요청에는 사유가 필요하다",
    path: ["note"],
  })
  .refine((input) => input.decision === "approve" || !input.choices, {
    message: "프로바이더·모델은 승인할 때만 정한다",
    path: ["choices"],
  });
export type DecideApprovalInput = z.infer<typeof decideApprovalInputSchema>;

export const approvalSummarySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  kind: approvalKindSchema,
  status: approvalStatusSchema,
  requestedByAgentId: z.uuid(),
  /** 반려·수정 요청 뒤 다시 제출한 요청이면 직전 요청. 직전 요청의 내용과 결정은 그대로 남는다. */
  previousApprovalId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;
export const approvalSummaryListSchema = z.array(approvalSummarySchema);

/** 승인 결정으로 생긴 작업자 한 명과 그 프로바이더·모델. */
export const decidedWorkerSchema = providerChoiceSchema.extend({
  agentId: z.uuid(),
});
export type DecidedWorker = z.infer<typeof decidedWorkerSchema>;

const decisionFields = {
  decisionNote: z.string().nullable(),
  /**
   * 승인으로 생긴 작업자마다의 프로바이더·모델({@link proposedWorkers} 순서). 반려·수정 요청·결정 전에는 없고,
   * 이 필드가 생기기 전에 승인한 요청에도 없다.
   */
  decidedWorkers: z.array(decidedWorkerSchema).nullable(),
};

/** 승인 요청 상세. 검토 내용(`proposal`)의 모양은 종류마다 다르다. */
export const approvalSchema = z.discriminatedUnion("kind", [
  approvalSummarySchema.extend({
    kind: z.literal("initial_research"),
    proposal: initialResearchProposalSchema,
    ...decisionFields,
  }),
  approvalSummarySchema.extend({
    kind: z.literal("add_worker"),
    proposal: addWorkerProposalSchema,
    ...decisionFields,
  }),
]);
export type Approval = z.infer<typeof approvalSchema>;
export type ApprovalProposal = Approval["proposal"];

/** 승인하면 생길 작업자 한 명: Role, 그 Role 안의 순번(1부터), Lead 제안 프로바이더·모델(예전 요청에는 없음). */
export type ProposedWorker = {
  role: string;
  label: string;
  ordinal: number;
  choice: ProviderChoice | undefined;
};

/**
 * 승인하면 생길 작업자를 생기는 순서대로 한 명씩 편다: 초기 연구 승인은 팀 구성 줄 순서, 줄 안에서 인원 순서이고,
 * 작업자 추가는 한 명이다. 결정의 `choices`와 `decidedWorkers`가 이 순서를 따른다.
 */
export function proposedWorkers(
  subject:
    | { kind: "initial_research"; proposal: InitialResearchProposal }
    | { kind: "add_worker"; proposal: AddWorkerProposal }
): ProposedWorker[] {
  if (subject.kind === "add_worker") {
    const { role, label, choice } = subject.proposal;
    return [{ role, label, ordinal: 1, choice }];
  }
  return subject.proposal.team.flatMap(({ role, label, count, choice }) =>
    Array.from({ length: count }, (_, i) => ({
      role,
      label,
      ordinal: i + 1,
      choice,
    }))
  );
}

/**
 * 작업자 추가 도구의 결과. 승인 정책이 꺼져 있으면 곧바로 생긴 작업자(`added`), 켜져 있으면
 * 사용자 결정을 기다리는 승인 요청(`pending_approval`)이며 작업자는 아직 없다.
 */
export const addWorkerResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("added"), agent: agentSchema }),
  z.object({
    status: z.literal("pending_approval"),
    approval: approvalSummarySchema,
  }),
]);
export type AddWorkerResult = z.infer<typeof addWorkerResultSchema>;
