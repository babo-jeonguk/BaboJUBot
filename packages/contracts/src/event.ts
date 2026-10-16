import { z } from "zod";
import { lifecycleStageSchema } from "./organization.ts";

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

export const eventSchema = z.discriminatedUnion("type", [
  organizationCreatedEventSchema,
]);
export type Event = z.infer<typeof eventSchema>;
export type EventType = Event["type"];
/** 저장 전 Event. ID와 시각은 Event log가 정한다. */
export type NewEvent = Omit<Event, "id" | "createdAt">;

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
