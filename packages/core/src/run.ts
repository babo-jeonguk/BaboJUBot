import {
  conversationTitleMaxLength,
  defaultConversationTitle,
  type Agent,
  type Conversation,
  type ConversationMessage,
  type LifecycleStage,
  type MessageDelivery,
  type NewEvent,
  type RunCancelReason,
  type RunResult,
  type RunEndReason,
  type RunStatus,
  type SendOwnerMessageInput,
  type SessionState,
  type Usage,
  type WakeKind,
  type WakeReason,
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
  | { kind: "organization_created" }
  | { kind: "heartbeat" }
);
/** 대기 중인 깨우기와 실행 시도에 넘길 그 사유. `delivery`는 사용자 메시지 깨우기면 그 메시지의 전달 방식이고 그 밖에는 없다. */
export type PendingWake = {
  id: string;
  organizationId: string;
  agentId: string;
  createdAt: string;
  reason: WakeReason;
  delivery: MessageDelivery | null;
};

/**
 * 사용자 메시지 기록. 메시지·깨우기·Event는 함께 저장되어야 한다.
 * 새 대화의 첫 메시지면 `conversation`이 그 대화이고 메시지보다 먼저 함께 저장한다.
 */
export type OwnerMessagePlan = {
  conversation: Conversation | null;
  message: ConversationMessage;
  wake: Wake;
  event: NewEvent;
};

/** 조직과 함께 생기는 기본 대화. */
export const planDefaultConversation = (
  organizationId: string,
  { id, createdAt }: { id: string; createdAt: string }
): Conversation => ({
  id,
  organizationId,
  title: defaultConversationTitle,
  isDefault: true,
  createdAt,
});

/** 새 대화의 제목: 첫 사용자 메시지의 공백을 한 칸으로 줄이고, 길면 잘라 말줄임표를 붙인다. */
export function conversationTitle(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length > conversationTitleMaxLength
    ? `${chars
        .slice(0, conversationTitleMaxLength - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

/**
 * 사용자 메시지는 그 조직의 Lead에게 가고 Lead를 깨운다. 실행 중이면 다음 실행 시도로 미룬다(줄 세운 메시지).
 * `conversation`은 메시지를 남길 같은 조직의 대화이고, `new`면 이 메시지로 새 대화를 시작한다.
 */
export function planOwnerMessage(
  organization: {
    organizationId: string;
    agents: Pick<Agent, "id" | "role">[];
  },
  conversation: { id: string } | "new",
  input: Required<SendOwnerMessageInput>,
  { newId, now }: RecordSource
): OwnerMessagePlan {
  const lead = findLead(organization.agents);
  if (!lead) throw new Error("organization has no Research Lead");
  const createdAt = now().toISOString();
  const started: Conversation | null =
    conversation === "new"
      ? {
          id: newId(),
          organizationId: organization.organizationId,
          title: conversationTitle(input.body),
          isDefault: false,
          createdAt,
        }
      : null;
  const message: ConversationMessage = {
    id: newId(),
    organizationId: organization.organizationId,
    agentId: lead.id,
    conversationId: started?.id ?? (conversation as { id: string }).id,
    author: "owner",
    body: input.body,
    delivery: input.delivery,
    sentByRunId: null,
    deliveredToRunId: null,
    deliveredAt: null,
    createdAt,
  };
  return {
    conversation: started,
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

/**
 * 에이전트 답장이 갈 대화. 고른 대화(`requested`, 같은 조직인지는 저장 쪽이 확인)가 있으면 그 대화이고,
 * 없으면 이 실행 시도가 받은 사용자 메시지의 대화(`received`)다. 사용자 메시지 없이 깨어났으면(승인 결정·작업 완료·heartbeat 등)
 * 스스로 보내는 메시지라 기본 대화로 간다. 여러 대화의 사용자 메시지를 받았으면 어느 대화인지 골라야 한다.
 */
export function chooseReplyConversation(
  requested: string | undefined,
  received: readonly string[],
  defaultConversationId: string
): string | "conversation_required" {
  if (requested) return requested;
  const distinct = [...new Set(received)];
  if (distinct.length > 1) return "conversation_required";
  return distinct[0] ?? defaultConversationId;
}

/** 에이전트가 조직 도구로 보낸 Lead 대화 답장. 사용자에게 가므로 아무도 깨우지 않는다. */
export function planAgentMessage(
  run: { id: string; organizationId: string; agentId: string },
  conversationId: string,
  body: string,
  { newId, now }: RecordSource
): { message: ConversationMessage; event: NewEvent } {
  const message: ConversationMessage = {
    id: newId(),
    organizationId: run.organizationId,
    agentId: run.agentId,
    conversationId,
    author: "agent",
    body,
    delivery: null,
    sentByRunId: run.id,
    deliveredToRunId: null,
    deliveredAt: null,
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
    conversationId: message.conversationId,
    author: message.author,
    runId: message.sentByRunId,
  },
});

export type NewRun = {
  id: string;
  organizationId: string;
  agentId: string;
  /** admission 때 에이전트 설정에서 고정한 프로바이더 연결과 모델. */
  provider: string;
  model: string | null;
  instructionsBundleVersion: string | null;
  sessionBefore: SessionState | null;
  /** 이 실행 시도의 세션 자리: 작업 세션이면 그 작업, 에이전트 세션이면 `null`(`sessionTaskOf`). */
  sessionTaskId: string | null;
  /** admission 때의 에이전트 세션 세대. 프로바이더를 바꾸면 세대가 올라가고, 옛 세대의 실행 시도는 세션을 저장하지 않는다. */
  sessionGeneration: number;
  startedAt: string;
};

/** 저장한 세션 하나와 그것을 만든 프로바이더 연결·지침 bundle 버전. */
export type StoredSession = {
  provider: string;
  instructionsBundleVersion: string | null;
  state: SessionState;
};

/**
 * 깨우기 묶음이 이어 갈 세션 자리. 받은 깨우기가 모두 같은 작업을 가리키면(작업 배정·작업 완료·작업 댓글) 그 작업이고,
 * 작업이 없는 깨우기가 섞였거나 작업이 둘 이상이면 `null`(에이전트 세션)이다. 작업 완료 깨우기의 작업은 완료된 그 작업(부모 담당자에게는
 * 하위 작업)이며 다른 작업으로 바꾸지 않는다.
 */
export function sessionTaskOf(reasons: readonly WakeReason[]): string | null {
  const tasks = new Set(
    reasons.map((r) =>
      r.kind === "task_assigned" ||
      r.kind === "task_completed" ||
      r.kind === "task_comment"
        ? r.taskId
        : null
    )
  );
  return tasks.size === 1 ? ([...tasks][0] ?? null) : null;
}

/** 대기 깨우기로 시작할 실행 시도의 세션 자리. 저장 쪽이 그 자리의 세션을 읽어 `planRunStart`에 넘길 때 쓴다. */
export const sessionTaskOfPending = (pending: readonly PendingWake[]) =>
  sessionTaskOf(bundleWakes(pending).map((w) => w.reason));

export type RunStartPlan = {
  run: NewRun;
  /** 이 실행 시도가 받는 깨우기(`bundleWakes`). 나머지는 대기한 채 다음 실행 시도를 기다린다. */
  wakeIds: string[];
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
 * 실행 시도 하나가 받을 대기 깨우기(저장 순서). 보통은 대기 깨우기를 모두 합친다.
 * `중단하고 보내기` 메시지(지금 보내기로 바꾼 줄 세운 메시지 포함)가 기다리면 그 메시지 깨우기만 받는다.
 * 사용자가 지금 실행 시도를 끊고 먼저 넣은 말이므로 그 말만 먼저 다루게 하고, 먼저 줄 세운 메시지와
 * 다른 깨우기(승인 결정·작업 사건·heartbeat 등)는 대기한 채 그 실행 시도가 끝난 뒤의 실행 시도가 평소처럼 합쳐 받는다.
 */
export function bundleWakes(pending: readonly PendingWake[]): PendingWake[] {
  const interrupts = pending.filter((w) => w.delivery === "interrupt");
  return interrupts.length ? interrupts : [...pending];
}

/**
 * 대기 중인 깨우기를 실행 시도 하나로 묶는다(`bundleWakes`). 묶음은 이 시점에 고정되며,
 * 이후 도착한 깨우기와 묶지 않은 깨우기는 다음 실행 시도가 받는다. 에이전트의 프로바이더 연결·모델을 실행 시도에 고정한다.
 * 이어 갈 세션은 묶음의 세션 자리(`sessionTaskOf`)에 저장된 세션(`session`, 저장 쪽이 그 자리에서 읽음)이며,
 * 그 세션을 만든 프로바이더 연결과 지침 bundle 버전이 지금과 같을 때만 이어 간다(모델만 바뀌면 이어 간다).
 * 에이전트의 프로바이더를 바꾸면 저장 쪽이 그 에이전트의 세션을 모두 비우므로 A→B→A로 돌아와도 새 세션이다.
 */
export function planRunStart(
  input: {
    agent: Agent;
    pendingWakes: PendingWake[];
    instructionsBundleVersion: string | null;
    session: StoredSession | undefined;
    sessionGeneration: number;
  },
  { newId, now }: RecordSource
): RunStartPlan | undefined {
  const { agent, instructionsBundleVersion, session } = input;
  const bundle = bundleWakes(input.pendingWakes);
  if (!bundle.length) return undefined;
  const run: NewRun = {
    id: newId(),
    organizationId: agent.organizationId,
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model,
    instructionsBundleVersion,
    sessionBefore:
      session &&
      session.provider === agent.provider &&
      session.instructionsBundleVersion === instructionsBundleVersion
        ? session.state
        : null,
    sessionTaskId: sessionTaskOfPending(bundle),
    sessionGeneration: input.sessionGeneration,
    startedAt: now().toISOString(),
  };
  return {
    run,
    wakeIds: bundle.map((w) => w.id),
    wakeReasons: bundle.map((w) => w.reason),
    event: {
      organizationId: run.organizationId,
      type: "run.started",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        wakeIds: bundle.map((w) => w.id),
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
 * 프로바이더가 돌려준 종료 결과로 실행 시도를 끝낸다. 종료는 한 번만 확정된다(저장 쪽이 강제).
 * 사용자 제어가 취소를 요청한 실행 시도는 프로바이더가 무엇을 돌려주든 `cancelled`로 끝난다. 늦게 돌아온 성공이 취소를 덮지 않는다.
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

/**
 * 끝난 실행 시도의 다음 세션을 그 세션 자리에 어떻게 남기는가. 실행 시도를 시작한 뒤 에이전트의 프로바이더가 바뀌었으면(세대가 다름)
 * 아무것도 남기지 않아, 비운 세션을 늦게 끝난 실행 시도가 되살리지 않는다. 다음 세션이 없으면 그 자리를 비운다.
 */
export function planSessionWriteBack(
  run: Pick<
    NewRun,
    | "provider"
    | "instructionsBundleVersion"
    | "sessionTaskId"
    | "sessionGeneration"
  >,
  agentSessionGeneration: number,
  nextSession: SessionState | null
):
  | { kind: "stale" }
  | { kind: "clear"; taskId: string | null }
  | { kind: "save"; taskId: string | null; session: StoredSession } {
  if (run.sessionGeneration !== agentSessionGeneration)
    return { kind: "stale" };
  if (!nextSession) return { kind: "clear", taskId: run.sessionTaskId };
  return {
    kind: "save",
    taskId: run.sessionTaskId,
    session: {
      provider: run.provider,
      instructionsBundleVersion: run.instructionsBundleVersion,
      state: nextSession,
    },
  };
}

const serverRestartError =
  "서버가 멈춰 이 실행 시도를 끝내지 못했습니다. 받은 깨우기는 다음 실행 시도가 다시 받습니다.";

/**
 * 서버가 멈춰(종료·crash) 프로바이더 결과 없이 끝나는 실행 시도. 서버 시작 때 남은 실행 시도와,
 * 서버 종료 때 프로바이더가 취소로 돌아온 실행 시도에 쓴다. 저장 쪽은 한 transaction으로 종료·깨우기 복원·Event를 남긴다.
 * - 사용자 제어가 이미 취소를 요청했으면 그 취소대로 `cancelled`로 끝나고 깨우기를 되돌리지 않는다. 취소 정리를 마친 뒤 멈춘 것과 같다.
 * - 그 밖에는 `server_restart`로 끝나고 받은 깨우기를 다시 대기시킨다. 같은 실행 시도·토큰은 다시 쓰지 않으며
 *   실행 시도가 받았던 깨우기의 기록은 그 실행 시도에 남는다. 대기 중인 heartbeat가 이미 있으면 옛 heartbeat는 그것과 합친다.
 * 프로바이더가 돌려준 세션이 없으므로 이어 갈 세션은 그 실행 시도 전 세션 그대로다.
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
 * 종료 뒤와 사용자 제어가 취소를 요청한 뒤에는 프로바이더가 정리 중이어도 읽기까지 거부한다.
 */
export const acceptsToolCalls = (run: {
  status: RunStatus;
  cancelReason: RunCancelReason | null;
}) => run.status === "running" && run.cancelReason === null;
