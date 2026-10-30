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

/** 전역 설정의 프로바이더 연결 한 줄: 이름, 모델 목록(받아 오지 못하면 고정 목록), 동시 실행 상한. */
export const providerSummarySchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  models: z.array(modelOptionSchema),
  maxConcurrentRuns: maxConcurrentRunsSchema,
});
export type ProviderSummary = z.infer<typeof providerSummarySchema>;

/**
 * 전역 프로바이더 설정. Lead·작업자 기본값은 그 역할의 에이전트를 만들 때 복사하며, 바꿔도 이미 있는 에이전트는 그대로다.
 * 연결 목록은 서버에 등록된 순서다.
 */
export const providerSettingsSchema = z.object({
  leadDefault: providerChoiceSchema,
  workerDefault: providerChoiceSchema,
  providers: z.array(providerSummarySchema),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

/**
 * Lead가 작업자를 제안할 때 읽는 프로바이더 목록: 작업자 기본값과 연결마다 이름·모델 목록. 전역 설정 화면과 같은 목록이며
 * 동시 실행 상한 같은 운영 설정은 담지 않는다.
 */
export const providerCatalogSchema = z.object({
  workerDefault: providerChoiceSchema,
  providers: z.array(
    providerSummarySchema.pick({ id: true, label: true, models: true })
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
