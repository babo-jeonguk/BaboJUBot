import { z } from "zod";
import { approvalDecisionSchema, approvalKindSchema } from "./approval.ts";
import { messageAuthorSchema } from "./message.ts";
import { lifecycleStageSchema } from "./organization.ts";
import { orgToolNameSchema } from "./tools.ts";
import {
  publicActivitySchema,
  runStopReasonSchema,
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
  payload: z.object({
    name: z.string(),
    stage: lifecycleStageSchema,
    leadAgentId: z.uuid(),
  }),
});

/** Lead 대화의 메시지 저장. 에이전트 메시지는 보낸 실행 시도(`runId`)를 가리킨다. */
export const messageCreatedEventSchema = z.object({
  ...eventBase,
  type: z.literal("message.created"),
  payload: z.object({
    messageId: z.uuid(),
    agentId: z.uuid(),
    author: messageAuthorSchema,
    runId: z.uuid().nullable(),
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

/** 실행 시도 종료. 종료 뒤에는 그 실행 시도의 토큰으로 조직 도구를 쓸 수 없다. */
export const runFinishedEventSchema = z.object({
  ...eventBase,
  type: z.literal("run.finished"),
  payload: z.object({
    runId: z.uuid(),
    agentId: z.uuid(),
    stopReason: runStopReasonSchema,
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

/** Lead가 승인 요청을 올렸다. `stage`는 요청 뒤 조직 단계다. */
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
 * 사용자의 승인 결정 제어 명령. `stage`는 결정 뒤 조직 단계, `createdAgentIds`는 승인으로 생긴 작업자,
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
    reason: z.enum(["role", "stage"]),
  }),
});

export const eventSchema = z.discriminatedUnion("type", [
  organizationCreatedEventSchema,
  goalRecordedEventSchema,
  approvalRequestedEventSchema,
  approvalDecidedEventSchema,
  toolRefusedEventSchema,
  messageCreatedEventSchema,
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
