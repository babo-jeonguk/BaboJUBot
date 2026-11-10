import { z } from "zod";

/**
 * 사용량 숫자 규칙의 단독 소유처. 토큰은 0 이상 안전 정수, 비용(USD)은 0 이상 유한수(소수 허용)이며 `null`은 보고 안 됨이다.
 * adapter는 프로바이더 원시 필드·집계 방식(턴 합산·누적 차감·캐시 분리·중복 제외)을 정하고, 숫자 검사와 이상값 처리는 여기 규칙을 쓴다.
 */
export const isTokenCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export const isCostUsd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const tokenCountSchema = z
  .number()
  .refine(isTokenCount, "0 이상 안전 정수여야 합니다.")
  .nullable();

/**
 * 실행 시도 하나의 사용량. 항목마다 보고한 값이거나 `null`(보고 안 됨)이며, 보고한 0은 0이다. 보고하지 않은 항목을 0으로 채우지 않는다.
 * 프로바이더가 세션 누적값만 주면 adapter가 이 실행 시도 몫으로 바꿔 보고한다. 캐시 읽기·쓰기는 입력과 따로 센 토큰이다.
 * 비용(USD)은 프로바이더가 알려 준 추정이다. 잘못 보고된 항목도 `null`이며, 그 구별은 계산 중({@link UsageAmount})과 진단에만 남는다.
 */
export const usageSchema = z.strictObject({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  costUsd: z.number().refine(isCostUsd, "0 이상 유한수여야 합니다.").nullable(),
});
export type Usage = z.infer<typeof usageSchema>;
export type UsageField = keyof Usage;
export const usageFields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const satisfies readonly UsageField[];

/** 아무 항목도 보고하지 않은 사용량. */
export const unreportedUsage: Usage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
};

/**
 * 이상값의 원인. `invalid_value`는 보고된 값 자체, `overflow`는 합산 결과가 범위를 넘음,
 * `negative_result`는 차감 결과가 음수(0으로 보정하지 않음), `invalid_operand`는 계산에 필요한 값이 이상값이라는 뜻이다.
 */
export type UsageAnomalyReason =
  "invalid_value" | "overflow" | "negative_result" | "invalid_operand";
export type UsageAnomaly = { readonly anomaly: UsageAnomalyReason };
/** 계산 중의 사용량 한 항목: 유효한 값, `null`(보고 안 됨), 또는 명시적 이상값. 이상값은 이후 계산에서 되살아나지 않는다. */
export type UsageAmount = number | null | UsageAnomaly;
/** 토큰(정수)과 USD(소수 허용)는 범위가 다르다. */
export type UsageUnit = "tokens" | "usd";

const anomaly = (reason: UsageAnomalyReason): UsageAnomaly => ({
  anomaly: reason,
});
export const isUsageAnomaly = (amount: UsageAmount): amount is UsageAnomaly =>
  amount !== null && typeof amount === "object";
const fits = (unit: UsageUnit, value: unknown) =>
  unit === "tokens" ? isTokenCount(value) : isCostUsd(value);

/** 프로바이더가 보고한 원시 값. 없거나 `null`이면 보고 안 됨, 그 밖에 범위 밖이면 이상값이다. 반올림하거나 0으로 바꾸지 않는다. */
export function usageAmount(unit: UsageUnit, raw: unknown): UsageAmount {
  if (raw === undefined || raw === null) return null;
  return fits(unit, raw) ? (raw as number) : anomaly("invalid_value");
}

/** 합산. 이상값이 한 번 들어가면 결과도 이상값이다. 보고 안 된 쪽은 건너뛴다(보고된 값만 더함). */
export function addUsage(
  unit: UsageUnit,
  a: UsageAmount,
  b: UsageAmount
): UsageAmount {
  if (isUsageAnomaly(a)) return a;
  if (isUsageAnomaly(b)) return b;
  if (a === null) return b;
  if (b === null) return a;
  const sum = a + b;
  return fits(unit, sum) ? sum : anomaly("overflow");
}

/**
 * 차감(`a - b`). `a`가 이상값이면 그 원인을 잇고, 빼는 값이 이상값이면 `invalid_operand`, 보고 안 됐으면 `null`, 결과가 음수이면 이상값이다.
 * 보고 안 된 baseline을 0으로 볼지는 adapter가 정해 넘긴다. 이상값에는 그 해석을 쓰지 않는다.
 */
export function subtractUsage(
  unit: UsageUnit,
  a: UsageAmount,
  b: UsageAmount
): UsageAmount {
  if (isUsageAnomaly(a)) return a;
  if (isUsageAnomaly(b)) return anomaly("invalid_operand");
  if (a === null || b === null) return null;
  const difference = a - b;
  if (difference < 0) return anomaly("negative_result");
  return fits(unit, difference) ? difference : anomaly("invalid_value");
}

export type UsageDiagnostic = {
  field: UsageField;
  reason: UsageAnomalyReason;
};

/** 계산을 마친 항목을 외부 사용량으로 바꾼다. 이상값은 그 항목만 `null`이 되고 진단으로 남는다. 빠진 항목은 보고 안 됨이다. */
export function settleUsage(
  amounts: Partial<Record<UsageField, UsageAmount>>
): {
  usage: Usage;
  anomalies: UsageDiagnostic[];
} {
  const usage: Usage = { ...unreportedUsage };
  const anomalies: UsageDiagnostic[] = [];
  for (const field of usageFields) {
    const amount = amounts[field] ?? null;
    if (isUsageAnomaly(amount))
      anomalies.push({ field, reason: amount.anomaly });
    // 계산을 거친 숫자도 한 번 더 검사해 범위 밖 값이 나가지 않게 한다.
    else if (amount !== null && !fits(unitOf(field), amount))
      anomalies.push({ field, reason: "invalid_value" });
    else usage[field] = amount;
  }
  return { usage, anomalies };
}
const unitOf = (field: UsageField): UsageUnit =>
  field === "costUsd" ? "usd" : "tokens";

/**
 * 종료 경계에서 받은 사용량 값의 숫자 항목만 격리한다. 다섯 항목의 숫자가 범위 밖이면 그 항목만 `null`로 바꾸고 진단을 돌려준다.
 * 객체가 아니거나 숫자가 아닌 값·다른 필드는 그대로 두므로 나머지 계약 위반은 schema 검사가 그대로 거부한다.
 */
export function isolateUsageNumbers(value: unknown): {
  value: unknown;
  anomalies: UsageDiagnostic[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { value, anomalies: [] };
  const record = value as Record<string, unknown>;
  const anomalies: UsageDiagnostic[] = [];
  const isolated: Record<string, unknown> = { ...record };
  for (const field of usageFields) {
    const raw = record[field];
    if (typeof raw !== "number" || fits(unitOf(field), raw)) continue;
    isolated[field] = null;
    anomalies.push({ field, reason: "invalid_value" });
  }
  return anomalies.length
    ? { value: isolated, anomalies }
    : { value, anomalies };
}
