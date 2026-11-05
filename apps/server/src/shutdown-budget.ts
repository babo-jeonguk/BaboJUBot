import { emergencyStopMs } from "@babojubot/db";

/**
 * 종료 시한을 서버 정리 몫과 내장 Postgres 비상 정지 몫으로 나눈다. 시한은 프로세스가 끝나는 시각까지다.
 * 비상 정지는 내장 DB일 때만 필요하며 최대 `emergencyStopMs`, 시한의 절반을 넘지 않는다. 0이면 비상 정지를 보내지 않고
 * 다음 시작이 남은 Postgres를 정리한다.
 */
export function shutdownBudget(deadlineMs: number, embedded: boolean) {
  const emergencyMs = embedded
    ? Math.min(emergencyStopMs, Math.floor(deadlineMs / 2))
    : 0;
  return { cleanupMs: deadlineMs - emergencyMs, emergencyMs };
}
