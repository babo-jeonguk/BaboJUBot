import {
  isClosedStage,
  messageHeldBy,
  type AgentCommand,
  type ConversationMessage,
  type LifecycleStage,
  type NewEvent,
  type OrganizationCommand,
  type RunCancelReason,
} from "@babojubot/contracts";

// 사용자 제어 명령: 조직 일시정지·재개·중단, 에이전트 일시정지·재개·실행 중단, `중단하고 보내기`의 실행 시도 중단.
// 저장 쪽은 조직 행 잠금 아래에서 지금 상태와 진행 중 실행 시도를 읽어 여기에 넘기고, 결과를 한 transaction에 저장한 뒤
// commit 뒤에 실행기에 취소를 보낸다. 같은 상태를 다시 요청하면 아무것도 바꾸지 않는다.

/** 취소를 요청할 진행 중 실행 시도와 그 사유. 이미 취소를 요청받은 실행 시도는 처음 사유를 그대로 둔다. */
export type RunCancellation = { reason: RunCancelReason; runIds: string[] };

export type ControlRefusal = "unchanged" | "organization_closed";

export type OrganizationControlPlan = {
  stage: LifecycleStage;
  pausedFrom: LifecycleStage | null;
  cancellation: RunCancellation | null;
  event: NewEvent;
};

type OrganizationState = {
  id: string;
  stage: LifecycleStage;
  pausedFrom: LifecycleStage | null;
};

/**
 * 조직 제어 명령. 일시정지는 직전 단계를 기억하고 진행 중 실행 시도를 모두 취소하며, 재개는 그 단계로 돌아간다.
 * 중단은 되돌릴 수 없는 끝이고 진행 중 실행 시도를 모두 취소한다. 최종 완료·중단 조직은 명령을 받지 않는다.
 * 에이전트 일시정지는 조직 명령과 따로이며 조직 재개가 풀지 않는다.
 */
export function planOrganizationControl(
  org: OrganizationState,
  command: OrganizationCommand,
  runningRunIds: string[]
): OrganizationControlPlan | ControlRefusal {
  if (command === "stop" && org.stage === "stopped") return "unchanged";
  if (isClosedStage(org.stage)) return "organization_closed";
  switch (command) {
    case "pause":
      if (org.stage === "paused") return "unchanged";
      return {
        stage: "paused",
        pausedFrom: org.stage,
        cancellation: { reason: "organization_paused", runIds: runningRunIds },
        event: {
          organizationId: org.id,
          type: "organization.paused",
          payload: {
            by: "owner",
            from: org.stage,
            cancelledRunIds: runningRunIds,
          },
        },
      };
    case "resume": {
      if (org.stage !== "paused") return "unchanged";
      const stage = resumeStageOf(org);
      return {
        stage,
        pausedFrom: null,
        cancellation: null,
        event: resumedEvent(org.id, stage),
      };
    }
    case "stop":
      return {
        stage: "stopped",
        pausedFrom: null,
        cancellation: { reason: "organization_stopped", runIds: runningRunIds },
        event: {
          organizationId: org.id,
          type: "organization.stopped",
          payload: {
            by: "owner",
            from: org.stage,
            cancelledRunIds: runningRunIds,
          },
        },
      };
  }
}

/**
 * 사용자 결정을 지금 받을 수 있는가. `decisionStage`는 결정이 속한 단계로, 단계를 바꾸는 결정(초기 연구 승인·결과 검토)만 있다.
 * 그 결정은 일시정지 중이면 조직을 먼저 재개하고(`resumed` Event를 결정 Event 앞에 남긴다) 최종 완료·중단 조직에서는 받지 않는다.
 * 결정을 기다리는 요청이 있는데 그 단계가 아니면 저장 상태가 어긋난 것이다(`stage_mismatch`).
 * 단계와 상관없는 결정(`null`, 작업자 추가)은 언제나 받고 일시정지를 풀지 않는다(#58).
 */
export function planDecisionStage(
  org: OrganizationState,
  decisionStage: LifecycleStage | null
):
  | { kind: "ready"; resumed: NewEvent | null }
  | { kind: "organization_closed" }
  | { kind: "stage_mismatch" } {
  if (decisionStage === null) return { kind: "ready", resumed: null };
  if (isClosedStage(org.stage)) return { kind: "organization_closed" };
  if (org.stage === "paused" && resumeStageOf(org) === decisionStage)
    return { kind: "ready", resumed: resumedEvent(org.id, decisionStage) };
  return org.stage === decisionStage
    ? { kind: "ready", resumed: null }
    : { kind: "stage_mismatch" };
}

export type AgentControlPlan = {
  paused: boolean;
  cancellation: RunCancellation | null;
  event: NewEvent;
};

/**
 * 에이전트 제어 명령. 일시정지는 그 에이전트의 진행 중 실행 시도를 취소하고 이후 admission을 막는다. 끝난 조직은 받지 않는다.
 * 실행 중단은 메시지 없이 진행 중 실행 시도만 취소하고 일시정지하지 않는다. `runningRunId`는 아직 취소를 요청받지 않은
 * 진행 중 실행 시도이며, 없으면(실행 중이 아니거나 이미 정리 중) 아무것도 바꾸지 않는다.
 */
export function planAgentControl(
  agent: { id: string; organizationId: string; paused: boolean },
  organizationStage: LifecycleStage,
  command: AgentCommand,
  runningRunId: string | null
): AgentControlPlan | ControlRefusal {
  if (isClosedStage(organizationStage)) return "organization_closed";
  if (command === "interrupt") {
    if (!runningRunId) return "unchanged";
    return {
      paused: agent.paused,
      cancellation: { reason: "owner_interrupt", runIds: [runningRunId] },
      event: {
        organizationId: agent.organizationId,
        type: "agent.interrupted",
        payload: {
          by: "owner",
          agentId: agent.id,
          runId: runningRunId,
          messageId: null,
        },
      },
    };
  }
  if (agent.paused === (command === "pause")) return "unchanged";
  if (command === "resume")
    return {
      paused: false,
      cancellation: null,
      event: {
        organizationId: agent.organizationId,
        type: "agent.resumed",
        payload: { by: "owner", agentId: agent.id },
      },
    };
  return {
    paused: true,
    cancellation: runningRunId
      ? { reason: "agent_paused", runIds: [runningRunId] }
      : null,
    event: {
      organizationId: agent.organizationId,
      type: "agent.paused",
      payload: { by: "owner", agentId: agent.id, runId: runningRunId },
    },
  };
}

export type InterruptPlan = {
  cancellation: RunCancellation | null;
  event: NewEvent;
};

/**
 * `중단하고 보내기`의 실행 시도 중단 제어 명령. 메시지는 깨우기로 남아 다음 실행 시도가 받고, 조직·에이전트는 일시정지하지 않는다.
 * 중단하는 것은 메시지가 그 뒤를 기다릴 실행 시도다. 받는 에이전트의 진행 중 실행 시도(`runningRunId`, 이미 취소 정리 중이면 그
 * 정리에 합류해 처음 취소 사유를 그대로 둔다)에 취소를 요청한다. 조직이나 Lead가 일시정지 중이면(contracts `messageHeldBy`) 메시지는
 * 재개를 기다리므로 일시정지가 취소한 실행 시도가 아직 정리 중이어도 중단할 것이 없다. 중단할 것이 없으면 제어 기록만 남는다.
 * 끝난 조직은 받지 않는다.
 */
export function planInterrupt(
  message: Pick<ConversationMessage, "id" | "organizationId" | "agentId">,
  state: {
    stage: LifecycleStage;
    leadPaused: boolean;
    runningRunId: string | null;
  }
): InterruptPlan | "organization_closed" {
  if (isClosedStage(state.stage)) return "organization_closed";
  const runningRunId = messageHeldBy(state) ? null : state.runningRunId;
  return {
    cancellation: runningRunId
      ? { reason: "owner_interrupt", runIds: [runningRunId] }
      : null,
    event: {
      organizationId: message.organizationId,
      type: "agent.interrupted",
      payload: {
        by: "owner",
        agentId: message.agentId,
        runId: runningRunId,
        messageId: message.id,
      },
    },
  };
}

const resumeStageOf = (org: OrganizationState) => {
  if (!org.pausedFrom)
    throw new Error(`paused organization ${org.id} has no stage to resume`);
  return org.pausedFrom;
};

const resumedEvent = (
  organizationId: string,
  stage: LifecycleStage
): NewEvent => ({
  organizationId,
  type: "organization.resumed",
  payload: { by: "owner", stage },
});
