import { z } from "zod";

// 조직 기억·에이전트 기억의 최소 계약(Memory port 첫 판). 기억 기법과 저장 엔진은 기억 이슈에서 정한다.
// 범위의 조직·에이전트와 출처는 실행 시도별 토큰에서만 정하며 도구 입력에는 그 값을 고르는 필드가 없다.

/** 조직 기억은 같은 조직의 에이전트가 함께, 에이전트 기억은 쓴 에이전트만 꺼낸다. */
export const memoryScopes = ["organization", "agent"] as const;
export const memoryScopeSchema = z.enum(memoryScopes);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryContentMaxLength = 4_000;
export const memoryQueryMaxLength = 200;
export const memoryRecallLimitMax = 50;
export const memoryRecallLimitDefault = 20;

/** 기억 하나. `agentId`는 에이전트 기억의 주인이며 조직 기억이면 없다. `source`는 쓴 에이전트와 실행 시도다. */
export const memoryEntrySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  scope: memoryScopeSchema,
  agentId: z.uuid().nullable(),
  content: z.string(),
  source: z.object({ agentId: z.uuid(), runId: z.uuid() }),
  createdAt: z.iso.datetime({ offset: true }),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export const memoryEntryListSchema = z.array(memoryEntrySchema);

export const writeMemoryInputSchema = z.strictObject({
  scope: memoryScopeSchema,
  content: z.string().trim().min(1).max(memoryContentMaxLength),
});
export type WriteMemoryInput = z.infer<typeof writeMemoryInputSchema>;

/**
 * 기억 회수(query string). `query`는 글자 그대로의 부분 문자열이며 대소문자를 가리지 않는다(`%`·`_`도 그 글자다).
 * 비어 있으면 모두 대상이다. 결과는 최근에 쓴 것부터 `limit`개다.
 */
export const recallMemoryInputSchema = z.strictObject({
  scope: memoryScopeSchema,
  query: z.string().max(memoryQueryMaxLength).default(""),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(memoryRecallLimitMax)
    .default(memoryRecallLimitDefault),
});
export type RecallMemoryInput = z.infer<typeof recallMemoryInputSchema>;
