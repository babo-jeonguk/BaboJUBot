import type { MemoryEntry, MemoryScope, NewEvent } from "@babojubot/contracts";

// Memory port: 조직 기억·에이전트 기억을 쓰고 꺼내는 경계. 기억 기법과 저장 엔진은 기억 이슈에서 정하며,
// 첫 판 구현(db)은 저장과 최근순·문자열 일치 회수뿐이다. 범위와 출처는 호출자가 아니라 실행 시도 신원에서 정한다.

/** 기억 범위. 조직은 늘 있고, 에이전트 기억이면 그 주인 에이전트가 있다. {@link memoryScopeOf}로만 만든다. */
export type MemoryScopeKey = {
  organizationId: string;
  scope: MemoryScope;
  agentId: string | null;
};

/** 기억의 출처: 쓴 에이전트와 실행 시도. */
export type MemorySource = { agentId: string; runId: string };

/** 회수 조건. `text`는 글자 그대로의 부분 문자열(대소문자 무시)이며 비면 모두다. 최근에 쓴 것부터 `limit`개. */
export type MemoryQuery = { text: string; limit: number };

export type MemoryPort = {
  write(
    scope: MemoryScopeKey,
    entry: { content: string },
    source: MemorySource
  ): Promise<MemoryEntry>;
  recall(scope: MemoryScopeKey, query: MemoryQuery): Promise<MemoryEntry[]>;
};

/**
 * 실행 시도 신원에서 기억 범위를 정한다. 조직은 그 실행 시도의 조직이고, 에이전트 기억은 그 실행 시도의 에이전트 것이다.
 * 다른 조직이나 같은 조직의 다른 에이전트를 고르는 입력은 없다.
 */
export const memoryScopeOf = (
  run: { organizationId: string; agentId: string },
  scope: MemoryScope
): MemoryScopeKey => ({
  organizationId: run.organizationId,
  scope,
  agentId: scope === "agent" ? run.agentId : null,
});

/** 기억의 출처는 쓰는 실행 시도다. */
export const memorySourceOf = (run: {
  id: string;
  agentId: string;
}): MemorySource => ({ agentId: run.agentId, runId: run.id });

export const memoryWrittenEvent = (entry: MemoryEntry): NewEvent => ({
  organizationId: entry.organizationId,
  type: "memory.written",
  payload: {
    runId: entry.source.runId,
    agentId: entry.source.agentId,
    memoryId: entry.id,
    scope: entry.scope,
  },
});
