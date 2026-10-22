import { z } from "zod";

// Heartbeat: 사건이 없어도 정해진 간격마다 에이전트를 깨우는 주기적 깨우기(GLOSSARY). 에이전트별로 켜고 끈다.

/** 간격(분). 에이전트가 생길 때 하네스 Role의 기본값을 받고, 사용자가 에이전트마다 조정한다. */
export const heartbeatIntervalMaxMinutes = 7 * 24 * 60;
export const heartbeatIntervalSchema = z
  .number()
  .int()
  .min(1)
  .max(heartbeatIntervalMaxMinutes);
/** Role이 기본 간격을 정하지 않았을 때의 간격. */
export const defaultHeartbeatMinutes = 60;

/**
 * 에이전트의 heartbeat 설정과 서버가 정한 다음 heartbeat. 새 에이전트는 꺼져 있다.
 * `nextAt`이 지나면 서버가 heartbeat 깨우기를 하나 만들고 그때부터 간격만큼 뒤로 미룬다. 서버가 멈췄던 동안 지난 heartbeat는 하나로 합친다.
 * 조직이 실행 시도를 받지 않는 동안(일시정지·최종 완료·중단)이나 에이전트 일시정지 중에는 깨우지 않으며, 재개 뒤 지나 있으면 한 번 깨운다.
 */
export const agentHeartbeatSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: heartbeatIntervalSchema,
  /** 에이전트가 생길 때 Role에서 받은 기본 간격. */
  roleDefaultMinutes: heartbeatIntervalSchema,
  /** 다음 heartbeat 예정 시각. 꺼져 있으면 없다. 실행 시도 시작 시각을 보장하지 않는다. */
  nextAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;

/** 사용자의 heartbeat 설정 변경. 켜거나 간격을 바꾸면 다음 heartbeat는 그때부터 간격만큼 뒤다. */
export const updateHeartbeatInputSchema = z.strictObject({
  enabled: z.boolean(),
  intervalMinutes: heartbeatIntervalSchema,
});
export type UpdateHeartbeatInput = z.infer<typeof updateHeartbeatInputSchema>;
