import { z } from "zod";
import { agentAppearanceSchema } from "./agent-profile.ts";
import { approvalDecisionSchema, approvalKindSchema } from "./approval.ts";
import { messageAuthorSchema } from "./message.ts";
import { harnessNameSchema } from "./harness.ts";
import { inboxItemKindSchema } from "./inbox.ts";
import { approvalPolicySchema, lifecycleStageSchema } from "./organization.ts";
import { resultDecisionSchema } from "./result.ts";
import { orgToolNameSchema, toolRefusalReasonSchema } from "./tools.ts";
import { researchMapOperationSchema } from "./research-map.ts";
import { memoryScopeSchema } from "./memory.ts";
import {
  publicActivitySchema,
  runEndReasonSchema,
  runSummarySchema,
  usageSchema,
  wakeReasonSchema,
} from "./run.ts";

/** Event log에 영속한 상태 변화. 모든 Event는 조직 하나에 속한다. */
const eventBase = {
  id: z.number().int().positive(),
  organizationId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
};

export const organizationCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal("organization.created"),
  /**
   * 사용자가 조직을 만들며 적은 연구 목표·완료 기준(비웠으면 `null`)과 그 목표로 깨운 Lead(`wokenAgentId`).
   * 목표를 생성 때 받기 전의 Event에는 `goal`·`completionCriteria`·`wokenAgentId`가 없다.
   */
  payload: z.object({
    name: z.string(),
    stage: lifecycleStageSchema,
    leadAgentId: z.uuid(),
    goal: z.string().optional(),
    completionCriteria: z.string().nullable().optional(),
    wokenAgentId: z.uuid().optional(),
  }),
});

/** Lead 대화의 메시지 저장. 메시지가 속한 대화(`conversationId`)를 담고, 에이전트 메시지는 보낸 실행 시도(`runId`)를 가리킨다. */
export const messageCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal("message.created"),
  payload: z.object({
    messageId: z.uuid(),
    agentId: z.uuid(),
    conversationId: z.uuid(),
    author: messageAuthorSchema,
    runId: z.uuid().nullable(),
  }),
});

/**
 * 사용자가 줄 세운 메시지를 거두었다(`취소`·`고치기`). 아직 실행 시도가 받지 않은 사용자 메시지만 거둘 수 있다.
 * 메시지는 지우지 않고 남지만 대화와 Lead의 맥락에서 빠지며, 그 깨우기는 더는 실행 시도를 시작하지 않는다.
 */
export const messageWithdrawnEventSchema = z.object({
  ...eventBase,
  type: z.literal("message.withdrawn"),
  payload: z.object({
    by: z.literal("owner"),
    messageId: z.uuid(),
    agentId: z.uuid(),
    conversationId: z.uuid(),
  }),
});

/**
 * 사용자가 줄 세운 메시지를 `지금 보내기`로 바꾸었다. 그 메시지의 전달 방식은 `중단하고 보내기`가 되고,
 * 진행 중 실행 시도를 끊는 제어 명령은 따로 `agent.interrupted`(같은 `messageId`)로 남는다.
 */
export const messageSentNowEventSchema = z.object({
  ...eventBase,
  type: z.literal("message.sent_now"),
  payload: z.object({
    by: z.literal("owner"),
    messageId: z.uuid(),
    agentId: z.uuid(),
    conversationId: z.uuid(),
  }),
});

/** 실행 시도 시작. 묶은 깨우기 ID를 순서대로 담는다. */
export const runStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal("run.started"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    wakeIds: z.array(z.uuid()).min(1),
  }),
});

/** 실행 시도의 공개 활동 하나. */
export const runActivityEventSchema = z.object({
  ...eventBase,
  type: z.literal("run.activity"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    activity: publicActivitySchema,
  }),
});

/**
 * 실행 시도 종료. 종료 뒤에는 그 실행 시도의 토큰으로 조직 도구를 쓸 수 없다.
 * `server_restart`면 그 실행 시도의 깨우기(`requeuedWakeIds`)가 다시 대기해 다음 실행 시도가 받는다.
 */
export const runFinishedEventSchema = z.object({
  ...eventBase,
  type: z.literal("run.finished"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    stopReason: runEndReasonSchema,
    requeuedWakeIds: z.array(z.uuid()).optional(),
    summary: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

/** Lead가 연구 목표와 완료 기준을 기록했다. 목표 설정에서 기록하면 계획 수립으로 넘어간다. */
export const goalRecordedEventSchema = z.object({
  ...eventBase,
  type: z.literal("organization.goal_recorded"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    goal: z.string(),
    completionCriteria: z.string(),
    stage: lifecycleStageSchema,
  }),
});

/** 사용자의 승인 정책 변경 제어 명령. 바꾸기 전 정책과 바꾼 뒤 정책을 함께 남긴다. 값이 그대로인 명령은 남지 않는다. */
export const approvalPolicyChangedEventSchema = z.object({
  ...eventBase,
  type: z.literal("organization.approval_policy_changed"),
  payload: z.object({
    by: z.literal("owner"),
    previous: approvalPolicySchema,
    policy: approvalPolicySchema,
  }),
});

/**
 * 사용자의 조직 일시정지 제어 명령. `from`은 일시정지 전 단계로 재개하면 돌아가고,
 * `cancelledRunIds`는 취소를 요청한 진행 중 실행 시도다. 그 사이 생긴 깨우기는 남아 재개 때 전달된다.
 */
export const organizationPausedEventSchema = z.object({
  ...eventBase,
  type: z.literal("organization.paused"),
  payload: z.object({
    by: z.literal("owner"),
    from: lifecycleStageSchema,
    cancelledRunIds: z.array(z.uuid()),
  }),
});

/**
 * 조직 재개. `stage`는 돌아간 단계(일시정지 전 단계)다. 재개 명령 또는 일시정지 중 단계를 바꾸는 결정
 * (초기 연구 승인·결과 검토)이 남기며, 결정이면 이어서 그 결정의 Event가 온다. 개별 에이전트 일시정지는 풀지 않는다.
 */
export const organizationResumedEventSchema = z.object({
  ...eventBase,
  type: z.literal("organization.resumed"),
  payload: z.object({
    by: z.literal("owner"),
    stage: lifecycleStageSchema,
  }),
});

/** 사용자의 조직 중단 제어 명령. 되돌릴 수 없다. `from`은 중단 전 단계, `cancelledRunIds`는 취소를 요청한 실행 시도다. */
export const organizationStoppedEventSchema = z.object({
  ...eventBase,
  type: z.literal("organization.stopped"),
  payload: z.object({
    by: z.literal("owner"),
    from: lifecycleStageSchema,
    cancelledRunIds: z.array(z.uuid()),
  }),
});

/** 사용자의 에이전트 일시정지 제어 명령. `runId`는 취소를 요청한 그 에이전트의 진행 중 실행 시도(없으면 없음)다. */
export const agentPausedEventSchema = z.object({
  ...eventBase,
  type: z.literal("agent.paused"),
  payload: z.object({
    by: z.literal("owner"),
    agentId: z.uuid(),
    runId: z.uuid().nullable(),
  }),
});

/** 사용자의 에이전트 재개 제어 명령. 조직 일시정지는 풀지 않는다. */
export const agentResumedEventSchema = z.object({
  ...eventBase,
  type: z.literal("agent.resumed"),
  payload: z.object({ by: z.literal("owner"), agentId: z.uuid() }),
});

/**
 * 실행 시도 중단 제어 명령. `중단하고 보내기`면 함께 보낸 메시지(`messageId`)가 따로 `message.created`로 남고 다음 실행 시도가 받는다.
 * 줄 세운 메시지의 `지금 보내기`면 그 메시지가 `message.sent_now`로 남는다.
 * `runId`는 취소를 요청한 받는 에이전트의 진행 중 실행 시도이며, 실행 중이 아니었으면 없다. 이미 취소 정리 중인 실행 시도면
 * 그 정리에 합류하므로 그 실행 시도이고, 취소 사유는 처음 것을 그대로 둔다.
 * 메시지 없는 `실행 중단`(에이전트 제어 명령 `interrupt`)은 `messageId`가 없고, 취소할 실행 시도가 있을 때만 남는다.
 */
export const agentInterruptedEventSchema = z.object({
  ...eventBase,
  type: z.literal("agent.interrupted"),
  payload: z.object({
    by: z.literal("owner"),
    agentId: z.uuid(),
    runId: z.uuid().nullable(),
    messageId: z.uuid().nullable(),
  }),
});

/** 사용자의 heartbeat 설정 변경. 바꾼 뒤의 설정과 서버가 정한 다음 heartbeat다. 값이 그대로인 변경은 남지 않는다. */
export const agentHeartbeatChangedEventSchema = z.object({
  ...eventBase,
  type: z.literal("agent.heartbeat_changed"),
  payload: z.object({
    by: z.literal("owner"),
    agentId: z.uuid(),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().positive(),
    nextAt: z.iso.datetime({ offset: true }).nullable(),
  }),
});

/**
 * 사용자의 에이전트 이름·얼굴 변경. 바뀐 항목만 담고 바뀌지 않은 항목은 없다(`null`). 값이 그대로인 변경은 남지 않는다.
 * `name.from`은 바꾸기 전 이름이라, 활동 기록이 지금 이름과 함께 예전 이름을 보일 수 있다.
 */
export const agentProfileChangedEventSchema = z.object({
  ...eventBase,
  type: z.literal("agent.profile_changed"),
  payload: z.object({
    by: z.literal("owner"),
    agentId: z.uuid(),
    name: z.object({ from: z.string(), to: z.string() }).nullable(),
    appearance: agentAppearanceSchema.nullable(),
  }),
});

/**
 * heartbeat 간격이 지나 서버가 깨우기를 만들었다. `wakeId`는 만든 깨우기이며, 아직 실행 시도가 받지 않은 heartbeat 깨우기가
 * 있으면 새로 만들지 않고 없다. `nextAt`은 그다음 heartbeat 예정 시각이다.
 */
export const agentHeartbeatEventSchema = z.object({
  ...eventBase,
  type: z.literal("agent.heartbeat"),
  payload: z.object({
    agentId: z.uuid(),
    wakeId: z.uuid().nullable(),
    nextAt: z.iso.datetime({ offset: true }),
  }),
});

/** 에이전트가 조직 도구로 기억을 썼다. 내용은 Event에 담지 않는다. */
export const memoryWrittenEventSchema = z.object({
  ...eventBase,
  type: z.literal("memory.written"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    memoryId: z.uuid(),
    scope: memoryScopeSchema,
  }),
});

/** 승인 정책이 꺼져 있어 Lead의 작업자 추가가 곧바로 작업자를 만들었다. `role`은 사본을 복사한 하네스 Role이다. */
export const workerAddedEventSchema = z.object({
  ...eventBase,
  type: z.literal("worker.added"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    workerAgentId: z.uuid(),
    role: harnessNameSchema,
  }),
});

/** Lead가 승인 요청을 올렸다. `stage`는 요청 뒤 조직 단계다. 작업자 추가 요청은 단계를 바꾸지 않는다. */
export const approvalRequestedEventSchema = z.object({
  ...eventBase,
  type: z.literal("approval.requested"),
  payload: z.object({
    approvalId: z.uuid(),
    kind: approvalKindSchema,
    runId: z.uuid(),
    agentId: z.uuid(),
    stage: lifecycleStageSchema,
  }),
});

/**
 * 사용자의 승인 결정 제어 명령을 남긴 Event. `stage`는 결정 뒤 조직 단계(작업자 추가 결정은 바꾸지 않음), `createdAgentIds`는 승인으로 생긴 작업자,
 * `wokenAgentId`는 결정 사유로 깨운 에이전트(요청한 Lead)다.
 */
export const approvalDecidedEventSchema = z.object({
  ...eventBase,
  type: z.literal("approval.decided"),
  payload: z.object({
    approvalId: z.uuid(),
    kind: approvalKindSchema,
    by: z.literal("owner"),
    decision: approvalDecisionSchema,
    note: z.string().nullable(),
    stage: lifecycleStageSchema,
    createdAgentIds: z.array(z.uuid()),
    wokenAgentId: z.uuid(),
    /** 이 승인으로 조직의 완료 기준이 된 Lead 제안. 제안을 승인한 결정에만 있다. */
    completionCriteria: z.string().optional(),
  }),
});

/** Lead가 결과를 제출했다. `stage`는 제출 뒤 조직 단계(결과 검토 중)다. */
export const resultSubmittedEventSchema = z.object({
  ...eventBase,
  type: z.literal("result.submitted"),
  payload: z.object({
    submissionId: z.uuid(),
    runId: z.uuid(),
    agentId: z.uuid(),
    artifactIds: z.array(z.uuid()),
    stage: lifecycleStageSchema,
  }),
});

/**
 * 사용자의 결과 검토 제어 명령을 남긴 Event. `stage`는 결정 뒤 조직 단계이고,
 * 수정 요청이면 의견과 함께 깨운 Lead가 `wokenAgentId`다. 최종 완료는 아무도 깨우지 않는다.
 */
export const resultDecidedEventSchema = z.object({
  ...eventBase,
  type: z.literal("result.decided"),
  payload: z.object({
    submissionId: z.uuid(),
    by: z.literal("owner"),
    decision: resultDecisionSchema,
    note: z.string().nullable(),
    stage: lifecycleStageSchema,
    wokenAgentId: z.uuid().nullable(),
  }),
});

/** 조직 도구 호출을 Role 또는 생애주기 단계 규칙으로 거부했다. 거부한 호출은 아무것도 바꾸지 않는다. */
export const toolRefusedEventSchema = z.object({
  ...eventBase,
  type: z.literal("tool.refused"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    tool: orgToolNameSchema,
    stage: lifecycleStageSchema,
    reason: toolRefusalReasonSchema,
  }),
});

/** 작업 생성. 담당자가 생성한 에이전트 자신이 아니면 담당자를 깨운다(`wokenAgentId`). */
export const taskCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal("task.created"),
  payload: z.object({
    taskId: z.uuid(),
    runId: z.uuid(),
    agentId: z.uuid(),
    assigneeAgentId: z.uuid(),
    parentTaskId: z.uuid().nullable(),
    wokenAgentId: z.uuid().nullable(),
  }),
});

/** 담당자가 작업에 착수했다. */
export const taskStartedEventSchema = z.object({
  ...eventBase,
  type: z.literal("task.started"),
  payload: z.object({ taskId: z.uuid(), runId: z.uuid(), agentId: z.uuid() }),
});

/**
 * 작업 완료와 자기 보고. 부모 작업이 있으면 그 담당자를, 없으면 작업을 만든 에이전트를 깨운다.
 * 깨울 에이전트가 완료한 에이전트 자신이면 깨우지 않는다(`wokenAgentId`가 없다).
 */
export const taskCompletedEventSchema = z.object({
  ...eventBase,
  type: z.literal("task.completed"),
  payload: z.object({
    taskId: z.uuid(),
    runId: z.uuid(),
    agentId: z.uuid(),
    wokenAgentId: z.uuid().nullable(),
  }),
});

/** 작업 댓글. 사용자 댓글은 담당자를 깨우고, 에이전트 댓글은 쓴 실행 시도를 가리키며 아무도 깨우지 않는다. */
export const taskCommentedEventSchema = z.object({
  ...eventBase,
  type: z.literal("task.commented"),
  payload: z.object({
    taskId: z.uuid(),
    commentId: z.uuid(),
    author: messageAuthorSchema,
    agentId: z.uuid().nullable(),
    runId: z.uuid().nullable(),
    wokenAgentId: z.uuid().nullable(),
  }),
});

/** 산출물 기록. */
export const artifactRecordedEventSchema = z.object({
  ...eventBase,
  type: z.literal("artifact.recorded"),
  payload: z.object({
    artifactId: z.uuid(),
    taskId: z.uuid(),
    runId: z.uuid(),
    agentId: z.uuid(),
  }),
});

/** 같은 조직 에이전트 사이의 메시지. 받는 에이전트를 깨운다. */
export const agentToAgentMessageCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal("agent_to_agent_message.created"),
  payload: z.object({
    messageId: z.uuid(),
    runId: z.uuid(),
    agentId: z.uuid(),
    recipientAgentId: z.uuid(),
  }),
});

/**
 * 연구 지도 편집 하나. 사용자 편집은 `author: owner`이며 Lead를 깨운다(`wokenAgentId`).
 * 에이전트 편집은 편집한 에이전트·실행 시도를 가리키고 아무도 깨우지 않는다.
 */
export const researchMapEditedEventSchema = z.object({
  ...eventBase,
  type: z.literal("research_map.edited"),
  payload: z.object({
    editId: z.uuid(),
    operation: researchMapOperationSchema,
    author: messageAuthorSchema,
    agentId: z.uuid().nullable(),
    runId: z.uuid().nullable(),
    nodeId: z.uuid().nullable(),
    linkId: z.uuid().nullable(),
    taskId: z.uuid().nullable(),
    wokenAgentId: z.uuid().nullable(),
  }),
});

/**
 * 사용자가 에이전트(`agentId`) 하나의 Role·Soul·Skill 사본을 저장해 revision이 생겼다. 내용은 Event에 담지 않는다.
 * 같은 내용의 저장도 revision을 남긴다. `wokenAgentId`는 편집 사유로 깨운 Lead다.
 */
export const instructionCopyEditedEventSchema = z.object({
  ...eventBase,
  type: z.literal("instruction_copy.edited"),
  payload: z.object({
    by: z.literal("owner"),
    agentId: z.uuid(),
    copyId: z.uuid(),
    path: z.string(),
    revisionId: z.uuid(),
    revision: z.number().int().positive(),
    wokenAgentId: z.uuid(),
  }),
});

/**
 * 사용자의 알림 정리 명령(읽음·보관). 정리 뒤 상태를 남기며, 값이 그대로인 명령은 남지 않는다.
 * 원본(`kind`·`sourceId`)의 결정·단계·깨우기는 바뀌지 않는다.
 */
export const inboxItemUpdatedEventSchema = z.object({
  ...eventBase,
  type: z.literal("inbox_item.updated"),
  payload: z.object({
    by: z.literal("owner"),
    kind: inboxItemKindSchema,
    sourceId: z.uuid(),
    read: z.boolean(),
    archived: z.boolean(),
  }),
});

export const eventSchema = z.discriminatedUnion("type", [
  organizationCreatedEventSchema,
  approvalPolicyChangedEventSchema,
  organizationPausedEventSchema,
  organizationResumedEventSchema,
  organizationStoppedEventSchema,
  agentPausedEventSchema,
  agentResumedEventSchema,
  agentInterruptedEventSchema,
  agentHeartbeatChangedEventSchema,
  agentProfileChangedEventSchema,
  agentHeartbeatEventSchema,
  memoryWrittenEventSchema,
  goalRecordedEventSchema,
  workerAddedEventSchema,
  approvalRequestedEventSchema,
  approvalDecidedEventSchema,
  resultSubmittedEventSchema,
  resultDecidedEventSchema,
  toolRefusedEventSchema,
  messageCreatedEventSchema,
  messageWithdrawnEventSchema,
  messageSentNowEventSchema,
  taskCreatedEventSchema,
  taskStartedEventSchema,
  taskCompletedEventSchema,
  taskCommentedEventSchema,
  artifactRecordedEventSchema,
  agentToAgentMessageCreatedEventSchema,
  researchMapEditedEventSchema,
  instructionCopyEditedEventSchema,
  inboxItemUpdatedEventSchema,
  runStartedEventSchema,
  runActivityEventSchema,
  runFinishedEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;
export type EventType = Event["type"];
/** 저장 전 Event. ID와 시각은 Event log가 정한다. */
export type NewEvent = Event extends unknown
  ? Omit<Event, "id" | "createdAt">
  : never;

export const eventListSchema = z.array(eventSchema);

/**
 * Event stream 구독 범위. `all`은 사용자 화면(홈·사이드바)용 전체 조직 구독이고,
 * 조직 구독은 그 조직의 Event만 받는다. 범위는 Event의 organizationId를 바꾸지 않는다.
 */
export type StreamScope =
  { kind: "all" } | { kind: "organization"; organizationId: string };

export const eventStreamPath = "/api/events";

/** 서버 → 화면 frame. `ready`는 구독이 성립한 뒤 한 번 온다. */
export const streamFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("event"), event: eventSchema }),
]);
export type StreamFrame = z.infer<typeof streamFrameSchema>;

/** 실행 시도 상세: 묶은 깨우기 사유, 공개 활동 transcript(그 실행 시도의 Event), 종료 결과. */
export const runDetailSchema = runSummarySchema.extend({
  wakeReasons: z.array(wakeReasonSchema),
  usage: usageSchema.nullable(),
  transcript: eventListSchema,
});
export type RunDetail = z.infer<typeof runDetailSchema>;
