import type {
  Agent,
  ConversationMessage,
  LifecycleStage,
  NewEvent,
  RunCancelReason,
  RunResult,
  RunEndReason,
  RunStatus,
  SendOwnerMessageInput,
  SessionState,
  Usage,
  WakeKind,
  WakeReason,
} from "@babojubot/contracts";
import type { RecordSource } from "./organization.ts";

/** 에이전트에게 새 실행 시도가 필요해진 사건. 실행 시도에 묶이기 전까지 대기하며 사유가 된 기록을 가리킨다. */
export type Wake = {
  id: string;
  organizationId: string;
  agentId: string;
  createdAt: string;
} & (
  | { kind: "owner_message"; messageId: string }
  | { kind: "approval_decision"; approvalId: string }
  | { kind: "task_assigned"; taskId: string }
  | { kind: "task_completed"; taskId: string }
  | { kind: "task_comment"; commentId: string }
  | { kind: "agent_to_agent_message"; agentToAgentMessageId: string }
  | { kind: "research_map_edit"; mapEditId: string }
  | { kind: "instruction_edit"; instructionRevisionId: string }
  | { kind: "result_changes_requested"; resultSubmissionId: string }
  | { kind: "heartbeat" }
);
/** 대기 중인 깨우기와 실행 시도에 넘길 그 사유. */
export type PendingWake = {
  id: string;
  organizationId: string;
  agentId: string;
  createdAt: string;
  reason: WakeReason;
};

/** 사용자 메시지 기록. 메시지·깨우기·Event는 함께 저장되어야 한다. */
export type OwnerMessagePlan = {
  message: ConversationMessage;
  wake: Wake;
  event: NewEvent;
};

/** 사용자 메시지는 그 조직의 Lead에게 가고 Lead를 깨운다. 실행 중이면 다음 실행 시도로 미룬다. */
export function planOwnerMessage(
  organization: { organizationId: string; agents: Agent[] },
  input: Required<SendOwnerMessageInput>,
  { newId, now }: RecordSource
): OwnerMessagePlan {
  const lead = findLead(organization.agents);
  if (!lead) throw new Error("organization has no Research Lead");
  const createdAt = now().toISOString();
  const message: ConversationMessage = {
    id: newId(),
    organizationId: organization.organizationId,
    agentId: lead.id,
    author: "owner",
    body: input.body,
    delivery: input.delivery,
    sentByRunId: null,
    deliveredToRunId: null,
    createdAt,
  };
  return {
    message,
    wake: {
      id: newId(),
      organizationId: message.organizationId,
      agentId: lead.id,
      kind: "owner_message",
      messageId: message.id,
      createdAt,
    },
    event: messageCreatedEvent(message),
  };
}

/** 에이전트가 조직 도구로 보낸 Lead 대화 답장. 사용자에게 가므로 아무도 깨우지 않는다. */
export function planAgentMessage(
  run: { id: string; organizationId: string; agentId: string },
  body: string,
  { newId, now }: RecordSource
): { message: ConversationMessage; event: NewEvent } {
  const message: ConversationMessage = {
    id: newId(),
    organizationId: run.organizationId,
    agentId: run.agentId,
    author: "agent",
    body,
    delivery: null,
    sentByRunId: run.id,
    deliveredToRunId: null,
    createdAt: now().toISOString(),
  };
  return { message, event: messageCreatedEvent(message) };
}

/** 조직의 전용 Research Lead. */
export const findLead = <T extends Pick<Agent, "role">>(agents: T[]) =>
  agents.find((a) => a.role === "lead");

const messageCreatedEvent = (message: ConversationMessage): NewEvent => ({
  organizationId: message.organizationId,
  type: "message.created",
  payload: {
    messageId: message.id,
    agentId: message.agentId,
    author: message.author,
    runId: message.sentByRunId,
  },
});

export type NewRun = {
  id: string;
  organizationId: string;
  agentId: string;
  instructionsBundleVersion: string | null;
  sessionBefore: SessionState | null;
  startedAt: string;
};

export type RunStartPlan = {
  run: NewRun;
  wakeReasons: WakeReason[];
  event: NewEvent;
};

/**
 * 새 실행 시도를 시작하지 않는 조직 단계. 깨우기는 남겨 두며 어떤 깨우기 사유도 예외가 없다.
 * 일시정지는 재개 때 남은 깨우기를 실행 시도 하나로 묶어 전달한다. 에이전트 일시정지도 그 에이전트의 admission을 같은 방식으로 막는다.
 */
export const runBlockingStages = [
  "paused",
  "stopped",
  "completed",
] as const satisfies readonly LifecycleStage[];

/** 이 단계의 조직에서 실행 시도를 시작할 수 있는가(admission). */
export const admitsRuns = (stage: LifecycleStage) =>
  !(runBlockingStages as readonly LifecycleStage[]).includes(stage);

/**
 * 대기 중인 깨우기를 모두 실행 시도 하나로 묶는다. 묶음은 이 시점에 고정되며,
 * 이후 도착한 깨우기는 다음 실행 시도가 받는다. 지침 bundle 버전이 같을 때만 이전 세션을 이어 간다.
 */
export function planRunStart(
  input: {
    agent: Agent;
    pendingWakes: PendingWake[];
    instructionsBundleVersion: string | null;
    previousRun:
      | {
          instructionsBundleVersion: string | null;
          nextSession: SessionState | null;
        }
      | undefined;
  },
  { newId, now }: RecordSource
): RunStartPlan | undefined {
  const { agent, pendingWakes, instructionsBundleVersion, previousRun } = input;
  if (!pendingWakes.length) return undefined;
  const run: NewRun = {
    id: newId(),
    organizationId: agent.organizationId,
    agentId: agent.id,
    instructionsBundleVersion,
    sessionBefore:
      previousRun &&
      previousRun.instructionsBundleVersion === instructionsBundleVersion
        ? previousRun.nextSession
        : null,
    startedAt: now().toISOString(),
  };
  return {
    run,
    wakeReasons: pendingWakes.map((w) => w.reason),
    event: {
      organizationId: run.organizationId,
      type: "run.started",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        wakeIds: pendingWakes.map((w) => w.id),
      },
    },
  };
}

export type RunFinishPlan = {
  update: {
    status: RunEndReason;
    summary: string | null;
    error: string | null;
    usage: Usage | null;
    sessionAfter: SessionState | null;
    finishedAt: string;
  };
  event: NewEvent;
};

/**
 * 실행기가 돌려준 종료 결과로 실행 시도를 끝낸다. 종료는 한 번만 확정된다(저장 쪽이 강제).
 * 사용자 제어가 취소를 요청한 실행 시도는 실행기가 무엇을 돌려주든 `cancelled`로 끝난다. 늦게 돌아온 성공이 취소를 덮지 않는다.
 */
export function planRunFinish(
  run: {
    id: string;
    organizationId: string;
    agentId: string;
    cancelReason: RunCancelReason | null;
  },
  result: RunResult,
  { now }: Pick<RecordSource, "now">
): RunFinishPlan {
  const status = run.cancelReason ? "cancelled" : result.stopReason;
  return {
    update: {
      status,
      summary: result.summary,
      error: result.error,
      usage: result.usage,
      sessionAfter: result.nextSession,
      finishedAt: now().toISOString(),
    },
    event: {
      organizationId: run.organizationId,
      type: "run.finished",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        stopReason: status,
        summary: result.summary,
        error: result.error,
      },
    },
  };
}

const serverRestartError =
  "서버가 멈춰 이 실행 시도를 끝내지 못했습니다. 받은 깨우기는 다음 실행 시도가 다시 받습니다.";

/**
 * 서버가 멈춰(종료·crash) 실행기 결과 없이 끝나는 실행 시도. 서버 시작 때 남은 실행 시도와,
 * 서버 종료 때 실행기가 취소로 돌아온 실행 시도에 쓴다. 저장 쪽은 한 transaction으로 종료·깨우기 복원·Event를 남긴다.
 * - 사용자 제어가 이미 취소를 요청했으면 그 취소대로 `cancelled`로 끝나고 깨우기를 되돌리지 않는다. 취소 정리를 마친 뒤 멈춘 것과 같다.
 * - 그 밖에는 `server_restart`로 끝나고 받은 깨우기를 다시 대기시킨다. 같은 실행 시도·토큰은 다시 쓰지 않으며
 *   실행 시도가 받았던 깨우기의 기록은 그 실행 시도에 남는다. 대기 중인 heartbeat가 이미 있으면 옛 heartbeat는 그것과 합친다.
 * 실행기가 돌려준 세션이 없으므로 이어 갈 세션은 그 실행 시도 전 세션 그대로다.
 */
export function planRunInterruption(
  run: {
    id: string;
    organizationId: string;
    agentId: string;
    cancelReason: RunCancelReason | null;
    sessionBefore: SessionState | null;
  },
  {
    wakes,
    pendingHeartbeat,
  }: { wakes: { id: string; kind: WakeKind }[]; pendingHeartbeat: boolean },
  source: Pick<RecordSource, "now">
): RunFinishPlan & { requeueWakeIds: string[] } {
  const plan = planRunFinish(
    run,
    {
      stopReason: "cancelled",
      error: null,
      summary: null,
      usage: null,
      nextSession: run.sessionBefore,
    },
    source
  );
  if (run.cancelReason) return { ...plan, requeueWakeIds: [] };
  // 그 사이 새 heartbeat가 대기 중이면 옛 heartbeat는 다시 대기시키지 않고 그 heartbeat에 합친다.
  const wakeIds = wakes
    .filter((w) => !(w.kind === "heartbeat" && pendingHeartbeat))
    .map((w) => w.id);
  return {
    update: {
      ...plan.update,
      status: "server_restart",
      error: serverRestartError,
    },
    event: {
      organizationId: run.organizationId,
      type: "run.finished",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        stopReason: "server_restart",
        summary: null,
        error: serverRestartError,
        requeuedWakeIds: wakeIds,
      },
    },
    requeueWakeIds: wakeIds,
  };
}

/**
 * 실행 시도별 토큰은 그 실행 시도가 실행 중이고 취소를 요청받지 않았을 때만 조직 도구를 연다.
 * 종료 뒤와 사용자 제어가 취소를 요청한 뒤에는 실행기가 정리 중이어도 읽기까지 거부한다.
 */
export const acceptsToolCalls = (run: {
  status: RunStatus;
  cancelReason: RunCancelReason | null;
}) => run.status === "running" && run.cancelReason === null;
