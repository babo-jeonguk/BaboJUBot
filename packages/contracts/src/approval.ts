import { z } from "zod";
import {
  flowTemplateSnapshotSchema,
  harnessNameSchema,
  instructionSourceFileSchema,
} from "./harness.ts";

// 목표 기록과 승인 요청. 초기 연구 승인은 끌 수 없는 사용자 결정이다(ADR-0003).

const longText = (max: number) => z.string().trim().min(1).max(max);
export const goalMaxLength = 4_000;
export const proposalTextMaxLength = 20_000;
export const decisionNoteMaxLength = 4_000;

/** Lead의 목표·완료 기준 기록. 조직은 실행 시도별 토큰이 정한다. */
export const recordGoalInputSchema = z.strictObject({
  goal: longText(goalMaxLength),
  completionCriteria: longText(goalMaxLength),
});
export type RecordGoalInput = z.infer<typeof recordGoalInputSchema>;

/**
 * Lead의 초기 연구 승인 요청. 계획·팀 구성·연구 환경 명세·연구 흐름 템플릿을 하나로 제출한다.
 * 팀 구성은 하네스 라이브러리의 작업자 Role 이름과 인원이다. 연구 환경 명세는 문서로만 다룬다.
 */
export const requestInitialApprovalInputSchema = z.strictObject({
  plan: longText(proposalTextMaxLength),
  environment: longText(proposalTextMaxLength),
  team: z
    .array(
      z.strictObject({
        role: harnessNameSchema,
        count: z.number().int().min(1).max(10),
      })
    )
    .min(1)
    .max(10)
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
  plan: z.string(),
  environment: z.string(),
  team: z.array(
    z.object({
      role: harnessNameSchema,
      label: z.string(),
      count: z.number().int().positive(),
      files: z.array(instructionSourceFileSchema),
    })
  ),
  template: flowTemplateSnapshotSchema,
});
export type InitialResearchProposal = z.infer<
  typeof initialResearchProposalSchema
>;

export const approvalKinds = ["initial_research"] as const;
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

/** 승인 결정 제어 명령. 반려와 수정 요청은 Lead를 깨울 사유가 필요하다. */
export const decideApprovalInputSchema = z
  .strictObject({
    decision: approvalDecisionSchema,
    note: z.string().trim().max(decisionNoteMaxLength).optional(),
  })
  .refine((input) => input.decision === "approve" || !!input.note, {
    message: "반려와 수정 요청에는 사유가 필요하다",
    path: ["note"],
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

export const approvalSchema = approvalSummarySchema.extend({
  proposal: initialResearchProposalSchema,
  decisionNote: z.string().nullable(),
});
export type Approval = z.infer<typeof approvalSchema>;
