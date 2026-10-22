import {
  isClosedStage,
  type LifecycleStage,
  type NewEvent,
  type UpdateHeartbeatInput,
} from "@babojubot/contracts";
import type { RecordSource } from "./organization.ts";
import { admitsRuns, type Wake } from "./run.ts";

// Heartbeat: 에이전트별로 켜는 주기적 깨우기. 서버의 scheduler가 주입한 시계로 지난 heartbeat를 찾아
// 다른 깨우기와 같은 대기열에 깨우기를 남기고, 실행 시도는 일반 admission이 만든다.

/** 저장한 heartbeat 설정과 다음 예정 시각. 꺼져 있으면 예정 시각이 없다. */
export type HeartbeatState = {
  enabled: boolean;
  intervalMinutes: number;
  nextAt: string | null;
};

const minutesAfter = (now: Date, minutes: number) =>
  new Date(now.getTime() + minutes * 60_000).toISOString();

type HeartbeatAgent = {
  id: string;
  organizationId: string;
  heartbeat: HeartbeatState;
};

/**
 * 사용자의 heartbeat 설정 변경. 값이 그대로면 `unchanged`, 최종 완료·중단 조직이면 `organization_closed`다.
 * 일시정지 중에도 바꿀 수 있고, 재개 뒤 예정이 지나 있으면 한 번 깨운다.
 * 켜거나 간격을 바꾸면 다음 heartbeat는 지금부터 새 간격만큼 뒤이고, 끄면 예정이 없어진다.
 * 이미 남은 heartbeat 깨우기는 다른 깨우기처럼 그대로 두며, 끈 뒤에는 새 heartbeat를 만들지 않는다.
 */
export function planHeartbeatChange(
  agent: HeartbeatAgent,
  stage: LifecycleStage,
  input: UpdateHeartbeatInput,
  now: Date
):
  | { heartbeat: HeartbeatState; event: NewEvent }
  | "unchanged"
  | "organization_closed" {
  if (isClosedStage(stage)) return "organization_closed";
  const current = agent.heartbeat;
  if (
    current.enabled === input.enabled &&
    current.intervalMinutes === input.intervalMinutes
  )
    return "unchanged";
  const heartbeat: HeartbeatState = {
    enabled: input.enabled,
    intervalMinutes: input.intervalMinutes,
    nextAt: input.enabled ? minutesAfter(now, input.intervalMinutes) : null,
  };
  return {
    heartbeat,
    event: {
      organizationId: agent.organizationId,
      type: "agent.heartbeat_changed",
      payload: { by: "owner", agentId: agent.id, ...heartbeat },
    },
  };
}

export type HeartbeatPlan = {
  /** 새 heartbeat 깨우기. 아직 실행 시도가 받지 않은 heartbeat 깨우기가 있으면 없다. */
  wake: Wake | null;
  nextAt: string;
  event: NewEvent;
};

/**
 * 지난 heartbeat 하나를 처리한다. 꺼져 있거나 아직 때가 아니면 `undefined`다.
 * 조직이 실행 시도를 받지 않는 단계(core `admitsRuns`)이거나 에이전트가 일시정지면 깨우지 않고 예정도 그대로 두어, 재개 뒤 한 번 깨운다.
 * 다음 heartbeat는 지금부터 간격만큼 뒤다. 그래서 서버가 멈췄던 동안 지난 여러 heartbeat는 한 번으로 합쳐진다.
 * 대기 중인 heartbeat 깨우기가 있으면 새로 만들지 않는다. 실행 중이어도 깨우기는 다음 실행 시도로 가고 다른 깨우기와 하나로 묶인다.
 */
export function planHeartbeat(
  agent: HeartbeatAgent & { paused: boolean },
  {
    stage,
    pendingHeartbeat,
  }: { stage: LifecycleStage; pendingHeartbeat: boolean },
  { newId, now }: RecordSource
): HeartbeatPlan | undefined {
  const { enabled, intervalMinutes, nextAt } = agent.heartbeat;
  const at = now();
  if (!enabled || nextAt === null || new Date(nextAt) > at) return undefined;
  if (!admitsRuns(stage) || agent.paused) return undefined;
  const wake: Wake | null = pendingHeartbeat
    ? null
    : {
        id: newId(),
        organizationId: agent.organizationId,
        agentId: agent.id,
        kind: "heartbeat",
        createdAt: at.toISOString(),
      };
  const next = minutesAfter(at, intervalMinutes);
  return {
    wake,
    nextAt: next,
    event: {
      organizationId: agent.organizationId,
      type: "agent.heartbeat",
      payload: { agentId: agent.id, wakeId: wake?.id ?? null, nextAt: next },
    },
  };
}
