import { z } from "zod";
import { decisionNoteMaxLength } from "./approval.ts";
import { artifactSummarySchema } from "./task.ts";

// 결과 제출과 최종 완료. Lead는 결과를 제출만 하고, 최종 완료는 끌 수 없는 사용자 결정이다(ADR-0003).

export const resultSummaryMaxLength = 20_000;
export const resultArtifactsMax = 50;

/**
 * Lead의 결과 제출. 완료 기준을 충족했다고 판단한 요약과 근거 산출물(같은 조직의 산출물 ID, 보일 순서대로)이다.
 * 조직·제출자·실행 시도와 검토 기준(목표·완료 기준)은 서버가 정한다.
 */
export const submitResultInputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(resultSummaryMaxLength),
  artifactIds: z
    .array(z.uuid())
    .min(1)
    .max(resultArtifactsMax)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "근거 산출물은 한 번씩만 적는다",
    }),
});
export type SubmitResultInput = z.infer<typeof submitResultInputSchema>;

/** 결과 제출 상태. `pending` 밖의 값은 모두 사용자 결정이며 다시 바뀌지 않는다. */
export const resultSubmissionStatuses = [
  "pending",
  "changes_requested",
  "completed",
] as const;
export const resultSubmissionStatusSchema = z.enum(resultSubmissionStatuses);
export type ResultSubmissionStatus = z.infer<
  typeof resultSubmissionStatusSchema
>;

/** 결과 검토의 사용자 결정. 수정 요청은 연구 진행으로 돌리고, 최종 완료는 연구를 닫는다. */
export const resultDecisions = ["request_changes", "complete"] as const;
export const resultDecisionSchema = z.enum(resultDecisions);
export type ResultDecision = z.infer<typeof resultDecisionSchema>;

/** 결과 검토 제어 명령. 수정 요청은 Lead를 깨울 의견이 필요하다. */
export const decideResultInputSchema = z
  .strictObject({
    decision: resultDecisionSchema,
    note: z.string().trim().max(decisionNoteMaxLength).optional(),
  })
  .refine((input) => input.decision === "complete" || !!input.note, {
    message: "수정 요청에는 의견이 필요하다",
    path: ["note"],
  });
export type DecideResultInput = z.infer<typeof decideResultInputSchema>;

const time = z.iso.datetime({ offset: true });

export const resultSubmissionSummarySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  status: resultSubmissionStatusSchema,
  submittedByAgentId: z.uuid(),
  submittedByRunId: z.uuid(),
  /** 수정 요청 뒤 다시 제출한 결과면 직전 제출. 직전 제출의 내용과 결정은 그대로 남는다. */
  previousSubmissionId: z.uuid().nullable(),
  createdAt: time,
  decidedAt: time.nullable(),
});
export type ResultSubmissionSummary = z.infer<
  typeof resultSubmissionSummarySchema
>;
export const resultSubmissionSummaryListSchema = z.array(
  resultSubmissionSummarySchema
);

/**
 * 결과 제출 상세. 목표·완료 기준은 제출 때 서버가 읽어 고정한 검토 기준이고,
 * 근거 산출물은 제출한 순서의 같은 조직 산출물이다(본문은 산출물 단건 조회로 읽는다).
 */
export const resultSubmissionSchema = resultSubmissionSummarySchema.extend({
  summary: z.string(),
  goal: z.string(),
  completionCriteria: z.string(),
  artifacts: z.array(artifactSummarySchema),
  decisionNote: z.string().nullable(),
});
export type ResultSubmission = z.infer<typeof resultSubmissionSchema>;
