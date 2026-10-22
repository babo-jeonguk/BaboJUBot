import type { MemoryEntry, WriteMemoryInput } from "@babojubot/contracts";
import {
  memoryScopeOf,
  memorySourceOf,
  memoryWrittenEvent,
  type MemoryPort,
  type MemoryScopeKey,
  type RecordSource,
} from "@babojubot/core";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { insertEvent, type Executor } from "./rows.ts";
import type { ActiveRun } from "./runs.ts";
import { memories } from "./schema.ts";
import { toolWrite, type ToolCall, type ToolWrite } from "./tool-calls.ts";

/**
 * Memory port의 첫 판 구현: 저장과 최근순·문자열 일치 회수. 범위의 조직·에이전트로만 거르고(같음 비교),
 * 검색어는 그 뒤에 글자 그대로의 부분 문자열로만 본다. LIKE 패턴을 쓰지 않으므로 `%`·`_`·`\`도 그 글자다.
 * 같은 시각에 쓴 기억도 저장 순서(seq)로 최근순을 정한다. 범위·출처가 같은 조직인지는 복합 FK가 마지막으로 강제한다.
 */
export function dbMemory(
  db: Executor,
  { newId, now }: RecordSource
): MemoryPort {
  return {
    async write(scope, entry, source) {
      const [row] = await db
        .insert(memories)
        .values({
          id: newId(),
          organizationId: scope.organizationId,
          scope: scope.scope,
          agentId: scope.agentId,
          content: entry.content,
          sourceAgentId: source.agentId,
          sourceRunId: source.runId,
          createdAt: now(),
        })
        .returning();
      return toMemoryEntry(row!);
    },
    async recall(scope, { text, limit }) {
      const rows = await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.organizationId, scope.organizationId),
            inScope(scope),
            text === ""
              ? undefined
              : sql`strpos(lower(${memories.content}), lower(${text})) > 0`
          )
        )
        .orderBy(desc(memories.seq))
        .limit(limit);
      return rows.map(toMemoryEntry);
    },
  };
}

const inScope = (scope: MemoryScopeKey) =>
  scope.agentId === null
    ? and(eq(memories.scope, "organization"), isNull(memories.agentId))
    : and(eq(memories.scope, "agent"), eq(memories.agentId, scope.agentId));

/** 조직 도구 기억 쓰기. 범위와 출처는 실행 시도 신원(토큰)에서 정한다. 종료·취소된 실행 시도의 토큰으로는 남지 않는다(`toolWrite`). */
export async function writeMemory(
  db: Database,
  run: ActiveRun,
  input: WriteMemoryInput,
  options: ToolCall & { source: RecordSource }
): Promise<ToolWrite<MemoryEntry, never>> {
  return toolWrite(db, run, "write_memory", options, async (tx, locked) => {
    const entry = await dbMemory(tx, options.source).write(
      memoryScopeOf(locked, input.scope),
      { content: input.content },
      memorySourceOf(locked)
    );
    return {
      kind: "ok",
      value: entry,
      events: [await insertEvent(tx, memoryWrittenEvent(entry))],
    };
  });
}

const toMemoryEntry = (row: typeof memories.$inferSelect): MemoryEntry => ({
  id: row.id,
  organizationId: row.organizationId,
  scope: row.scope,
  agentId: row.agentId,
  content: row.content,
  source: { agentId: row.sourceAgentId, runId: row.sourceRunId },
  createdAt: row.createdAt.toISOString(),
});
