import {
  settleUsage,
  type Usage,
  type UsageAmount,
  type UsageField,
} from "@babojubot/contracts";

/**
 * adapter가 계산을 마친 사용량을 외부 사용량으로 바꾼다. 숫자 규칙은 contracts가 정하며, 이상값은 그 항목만 비우고
 * 어느 항목이 왜 비었는지 운영 기록에 남긴다. 원시 응답이나 값은 남기지 않는다.
 */
export function providerUsage(
  provider: string,
  amounts: Partial<Record<UsageField, UsageAmount>>
): Usage {
  const { usage, anomalies } = settleUsage(amounts);
  for (const { field, reason } of anomalies)
    console.warn(
      `[provider] ${provider} usage ${field} left unreported: ${reason}`
    );
  return usage;
}
