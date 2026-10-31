import { z } from "zod";

// 프로바이더 연결·모델 선택·동시 실행 상한(#94). 서버는 이름 붙은 프로바이더 연결 여러 개를 받고,
// 에이전트마다 연결 하나와 모델(비우면 그 프로바이더의 기본 모델)을 정해 실행 시도를 그 연결에 맡긴다.

/** 프로바이더 연결 ID. 서버가 연결을 등록할 때 정하고 에이전트·실행 시도가 이 ID로 가리킨다. 같은 종류의 연결도 ID가 다르면 따로다. */
export const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits, hyphens");
/** 모델 ID. 프로바이더가 알아듣는 이름 그대로다. */
export const modelIdSchema = z.string().trim().min(1).max(200);

/** 에이전트 하나의 프로바이더·모델. `model`이 없으면 실행 시도 요청의 모델이 비어 프로바이더가 기본 모델을 쓴다. */
export const providerChoiceSchema = z.strictObject({
  provider: providerIdSchema,
  model: modelIdSchema.nullable(),
});
export type ProviderChoice = z.infer<typeof providerChoiceSchema>;

/** 같은 프로바이더·모델인가. 서버의 변경 판정과 화면의 `저장` 활성이 같은 판정을 쓴다. */
export const sameProviderChoice = (a: ProviderChoice, b: ProviderChoice) =>
  a.provider === b.provider && a.model === b.model;

/** 고르기 목록의 모델 하나. */
export const modelOptionSchema = z.object({
  id: modelIdSchema,
  label: z.string().min(1),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

/** 동시 실행 상한 0은 무제한이다. */
export const unlimitedConcurrentRuns = 0;
/** 상한을 정하지 않은 프로바이더 연결의 동시 실행 상한. */
export const defaultMaxConcurrentRuns = 2;
/** 프로바이더 연결 하나에서 동시에 도는 실행 시도 수의 상한. 0은 무제한이며, 제품이 정한 최댓값은 없다(저장 범위만). */
export const maxConcurrentRunsSchema = z
  .number()
  .int()
  .min(0)
  .max(2 ** 31 - 1);

/**
 * 프로바이더 연결이 지원하는 일(#96). 연결마다 모든 항목을 기본값 없이 선언하고, 공통 검사(`describeRuntimeContract`)가
 * 선언과 동작이 맞는지 확인한다.
 * - `steer`: 진행 중인 실행 시도에 사용자 메시지를 끼워 넣는다(`실행 중 끼워 넣기`). 받았다는 확인(`accepted`)이나 확실히 넣지 않았다는
 *   거절(`rejected`)만 돌려줄 수 있는 연결만 선언한다. 넣었는지 모르는 실패가 있는 연결은 선언하지 않는다.
 * - `resume`: 이전 세션을 이어 간다. 이어 가지 못하면 같은 실행 시도 안에서 새 세션으로 시작하고 그 사실을 진행 활동으로 남긴다.
 * - `reinjectInstructionsOnResume`: 세션을 이어 갈 때 지침(Role·Soul·Skill)을 다시 넣는다. `resume`이 있어야 한다.
 * - `usageTokens`·`usageCost`: 실행 시도마다 토큰 수·비용을 보고한다. 하나만 보고할 수도 있다.
 * - `precompact`: 세션을 미리 압축한다(실행은 후속 #99). `resume`이 있어야 한다.
 */
export const providerCapabilitiesSchema = z.strictObject({
  steer: z.boolean(),
  resume: z.boolean(),
  reinjectInstructionsOnResume: z.boolean(),
  usageTokens: z.boolean(),
  usageCost: z.boolean(),
  precompact: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/** 준비 상태. 모델을 부르지 않는 확인의 결과이며, 준비안됨이어도 고를 수 있고 다른 연결로 대신 돌리지 않는다. */
export const providerReadinessStatuses = [
  "ready",
  "not_ready",
  "unknown",
] as const;
export const providerReadinessStatusSchema = z.enum(providerReadinessStatuses);
export type ProviderReadinessStatus = z.infer<
  typeof providerReadinessStatusSchema
>;

/**
 * 준비되지 않았거나 알 수 없는 이유. 오류 원문·비밀값 대신 이 코드만 남긴다.
 * - `program_missing`: 실행 프로그램이 없다. `version_unsupported`: 지원하지 않는 버전이다.
 * - `product_login_missing`: 제품에 로그인하지 않았다(이때만 화면이 로그인 명령을 복사하게 한다).
 * - `credentials_invalid`: 자격 증명이 거부됐다.
 * - `credentials_unverified`: 자격 증명이 있지만 모델을 부르지 않고는 맞는지 알 수 없다.
 * - `not_checked`: 아직 확인하지 않았다. `check_failed`·`check_timeout`: 확인이 실패하거나 시간 안에 끝나지 않았다.
 */
export const providerReadinessReasons = [
  "program_missing",
  "version_unsupported",
  "product_login_missing",
  "credentials_invalid",
  "credentials_unverified",
  "not_checked",
  "check_failed",
  "check_timeout",
] as const;
export const providerReadinessReasonSchema = z.enum(providerReadinessReasons);
export type ProviderReadinessReason = z.infer<
  typeof providerReadinessReasonSchema
>;

/** 준비 확인 한 번의 결과. 준비됨에는 이유가 없고, 그 밖에는 이유가 있다. */
export const providerReadinessCheckSchema = z
  .strictObject({
    status: providerReadinessStatusSchema,
    reason: providerReadinessReasonSchema.nullable(),
  })
  .refine((r) => (r.status === "ready") === (r.reason === null), {
    message: "ready has no reason; not_ready and unknown need one",
  });
export type ProviderReadinessCheck = z.infer<
  typeof providerReadinessCheckSchema
>;

/** 저장한 준비 상태: 마지막 확인 결과와 그 시각(확인 전이면 없음), 지금 확인 중인지. */
export const providerReadinessSchema = z.object({
  status: providerReadinessStatusSchema,
  reason: providerReadinessReasonSchema.nullable(),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  checking: z.boolean(),
});
export type ProviderReadiness = z.infer<typeof providerReadinessSchema>;

/**
 * 전역 설정의 프로바이더 연결 한 줄: 이름, 모델 목록(받아 오지 못하면 고정 목록), 동시 실행 상한, 지원하는 일, 준비 상태,
 * 제품 로그인 명령(연결에 없으면 없음).
 */
export const providerSummarySchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  models: z.array(modelOptionSchema),
  maxConcurrentRuns: maxConcurrentRunsSchema,
  capabilities: providerCapabilitiesSchema,
  readiness: providerReadinessSchema,
  loginCommand: z.string().nullable(),
});
export type ProviderSummary = z.infer<typeof providerSummarySchema>;

/**
 * 전역 프로바이더 설정. Lead 기본값은 사용자가 고르지 않은 Lead를 만들 때, 작업자 기본값은 Lead가 작업자의 프로바이더를
 * 비운 요청을 받을 때 쓴다. 바꿔도 이미 있는 에이전트와 이미 올라온 요청은 그대로다.
 * 연결 목록은 서버에 등록된 순서다.
 */
export const providerSettingsSchema = z.object({
  leadDefault: providerChoiceSchema,
  workerDefault: providerChoiceSchema,
  providers: z.array(providerSummarySchema),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

/**
 * Lead가 작업자를 제안할 때 읽는 프로바이더 목록: 작업자 기본값과 연결마다 이름·모델 목록·마지막 준비 상태. 전역 설정 화면과 같은 목록이며
 * 동시 실행 상한 같은 운영 설정은 담지 않는다. 준비안됨 연결도 제안할 수 있다.
 */
export const providerCatalogSchema = z.object({
  workerDefault: providerChoiceSchema,
  providers: z.array(
    providerSummarySchema.pick({ id: true, label: true, models: true }).extend({
      readiness: providerReadinessSchema.pick({ status: true, reason: true }),
    })
  ),
});
export type ProviderCatalog = z.infer<typeof providerCatalogSchema>;

/** 사용자의 Lead·작업자 기본값 변경. 둘을 함께 저장한다. */
export const updateProviderDefaultsInputSchema = z.strictObject({
  leadDefault: providerChoiceSchema,
  workerDefault: providerChoiceSchema,
});
export type UpdateProviderDefaultsInput = z.infer<
  typeof updateProviderDefaultsInputSchema
>;

/** 사용자의 동시 실행 상한 변경. 줄여도 진행 중인 실행 시도는 끊지 않고, 새 실행 시도만 상한을 따른다. */
export const updateProviderLimitInputSchema = z.strictObject({
  maxConcurrentRuns: maxConcurrentRunsSchema,
});
export type UpdateProviderLimitInput = z.infer<
  typeof updateProviderLimitInputSchema
>;
