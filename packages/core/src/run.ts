import type {
  Agent,
  ConversationMessage,
  NewEvent,
  RunResult,
  RunStatus,
  SendOwnerMessageInput,
  SessionState,
  Usage,
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
    status: Exclude<RunStatus, "running">;
    summary: string | null;
    error: string | null;
    usage: Usage | null;
    sessionAfter: SessionState | null;
    finishedAt: string;
  };
  event: NewEvent;
};

/** 실행기가 돌려준 종료 결과로 실행 시도를 끝낸다. 종료는 한 번만 확정된다(저장 쪽이 강제). */
export function planRunFinish(
  run: { id: string; organizationId: string; agentId: string },
  result: RunResult,
  { now }: Pick<RecordSource, "now">
): RunFinishPlan {
  return {
    update: {
      status: result.stopReason,
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
        stopReason: result.stopReason,
        summary: result.summary,
        error: result.error,
      },
    },
  };
}

/** 실행 시도별 토큰은 그 실행 시도가 실행 중일 때만 조직 도구를 연다. 종료 뒤에는 읽기도 거부한다. */
export const acceptsToolCalls = (status: RunStatus) => status === "running";
