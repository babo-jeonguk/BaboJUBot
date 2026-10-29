import type { AgentDetail, RunDetail, RunSummary } from "@babojubot/contracts";
import { instructionsBundleVersion } from "@babojubot/core";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { countQueuedMessages } from "./conversations.ts";
import {
  findRunningRunId,
  selectInstructions,
  selectRunWakes,
} from "./run-reads.ts";
import {
  isUuid,
  toAgent,
  toAgentHeartbeat,
  toEvent,
  type Executor,
} from "./rows.ts";
import { agents, events, runs } from "./schema.ts";

// 실행 시도·에이전트 화면 조회: 조직의 실행 시도 목록, 진행 중 실행 시도, 실행 시도 상세, 에이전트 상세와 실행 시도 요약 모양.

/** 조직의 실행 시도. 최근 것부터. */
export async function listRuns(
  db: Executor,
  organizationId: string,
  { agentId, limit = 50 }: { agentId?: string; limit?: number } = {}
): Promise<RunSummary[]> {
  if (!isUuid(organizationId)) return [];
  if (agentId !== undefined && !isUuid(agentId)) return [];
  const rows = await db
    .select(runSummaryColumns)
    .from(runs)
    .where(
      and(
        eq(runs.organizationId, organizationId),
        agentId === undefined ? undefined : eq(runs.agentId, agentId)
      )
    )
    .orderBy(desc(runs.seq))
    .limit(limit);
  return rows.map(toRunSummary);
}

/**
 * 조직의 진행 중 실행 시도(취소 정리 중 포함). 최근 목록(`listRuns`)은 개수를 자르므로 오래 실행 중인 것이 빠질 수 있다.
 * 진행 중 실행 시도는 에이전트당 하나뿐이라 자르지 않는다.
 */
export async function listRunningRuns(
  db: Executor,
  organizationId: string
): Promise<RunSummary[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db
    .select(runSummaryColumns)
    .from(runs)
    .where(
      and(eq(runs.organizationId, organizationId), eq(runs.status, "running"))
    )
    .orderBy(desc(runs.seq));
  return rows.map(toRunSummary);
}

/** 실행 시도 상세. 다른 조직의 실행 시도와 없는 실행 시도를 구별하지 않는다. */
export async function findRunDetail(
  db: Database,
  organizationId: string,
  runId: string
): Promise<RunDetail | undefined> {
  if (!isUuid(organizationId) || !isUuid(runId)) return undefined;
  const [row] = await db
    .select({ ...runSummaryColumns, usage: runs.usage })
    .from(runs)
    .where(and(eq(runs.organizationId, organizationId), eq(runs.id, runId)));
  if (!row) return undefined;
  const { usage, ...summary } = row;
  const wakeReasons = (await selectRunWakes(db, runId)).map((w) => w.reason);
  const transcript = await db
    .select()
    .from(events)
    .where(
      and(eq(events.organizationId, organizationId), eq(events.runId, runId))
    )
    .orderBy(asc(events.id));
  return {
    ...toRunSummary(summary),
    wakeReasons,
    usage,
    transcript: transcript.map(toEvent),
  };
}

/** 에이전트 상세: 상태와 최근 실행 시도. 사용자 명령이 바꾼 뒤의 상세는 그 transaction 안에서 읽는다. */
export async function findAgentDetail(
  db: Executor,
  organizationId: string,
  agentId: string,
  { recentRuns = 10 }: { recentRuns?: number } = {}
): Promise<AgentDetail | undefined> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return undefined;
  const [agent] = await db
    .select()
    .from(agents)
    .where(
      and(eq(agents.organizationId, organizationId), eq(agents.id, agentId))
    );
  if (!agent) return undefined;
  const recent = await listRuns(db, organizationId, {
    agentId,
    limit: recentRuns,
  });
  return {
    ...toAgent(agent),
    status: (await findRunningRunId(db, agentId)) ? "running" : "idle",
    paused: agent.paused,
    instructionsBundleVersion: instructionsBundleVersion(
      await selectInstructions(db, agentId)
    ),
    heartbeat: toAgentHeartbeat(agent),
    recentRuns: recent,
    queuedMessageCount: await countQueuedMessages(db, agentId),
  };
}

export const runSummaryColumns = {
  id: runs.id,
  organizationId: runs.organizationId,
  agentId: runs.agentId,
  status: runs.status,
  cancelReason: runs.cancelReason,
  summary: runs.summary,
  error: runs.error,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  // drizzle은 select 안의 열을 테이블 없이 쓰므로 상관 subquery는 이름을 직접 밝힌다.
  wakeCount: sql<number>`(select count(*) from "run_wakes" where "run_wakes"."run_id" = "runs"."id")::int`,
};

export const toRunSummary = (row: {
  id: string;
  organizationId: string;
  agentId: string;
  status: RunSummary["status"];
  cancelReason: RunSummary["cancelReason"];
  summary: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  wakeCount: number;
}): RunSummary => ({
  ...row,
  startedAt: row.startedAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});
