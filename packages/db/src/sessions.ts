import type { SessionState } from "@babojubot/contracts";
import {
  planSessionWriteBack,
  type NewRun,
  type StoredSession,
} from "@babojubot/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "./rows.ts";
import { agentSessions, agents } from "./schema.ts";

// 프로바이더 세션: (에이전트, 작업)마다 하나, 작업이 없으면 에이전트 세션(#96). admission(runs.ts `claimNextRun`)이 세션 자리를
// 읽고, 종료 저장(`finishRun`·`interruptRun`)이 다음 세션을 같은 자리에 남기며, 프로바이더 변경(providers.ts)이 모두 비운다.
// DB 안에서만 쓰며 패키지 밖으로 내보내지 않는다(index.ts에 없음).

/** 세션 자리 하나: 에이전트와 작업(에이전트 세션이면 `null`). */
const slot = (agentId: string, taskId: string | null) =>
  and(
    eq(agentSessions.agentId, agentId),
    taskId === null
      ? isNull(agentSessions.taskId)
      : eq(agentSessions.taskId, taskId)
  );

/** 세션 자리 하나의 저장한 세션. 없으면 `undefined`. */
export async function readSession(
  tx: Executor,
  agentId: string,
  taskId: string | null
): Promise<StoredSession | undefined> {
  const [row] = await tx
    .select({
      provider: agentSessions.provider,
      instructionsBundleVersion: agentSessions.instructionsBundleVersion,
      state: agentSessions.state,
    })
    .from(agentSessions)
    .where(slot(agentId, taskId));
  return row;
}

/**
 * 끝난 실행 시도의 다음 세션을 그 세션 자리에 남긴다(core `planSessionWriteBack`). 호출한 쪽은 에이전트 행을 잠근 뒤 부른다.
 * 그래야 프로바이더 변경(같은 행 잠금 아래에서 세션을 지우고 세대를 올림)과 직렬화되어 지운 세션이 되살아나지 않는다.
 */
export async function writeBackSession(
  tx: Executor,
  run: Pick<
    NewRun,
    | "id"
    | "organizationId"
    | "agentId"
    | "provider"
    | "instructionsBundleVersion"
    | "sessionTaskId"
    | "sessionGeneration"
  >,
  agentSessionGeneration: number,
  nextSession: SessionState | null
) {
  const plan = planSessionWriteBack(run, agentSessionGeneration, nextSession);
  if (plan.kind === "stale") return;
  if (plan.kind === "clear") {
    await tx.delete(agentSessions).where(slot(run.agentId, plan.taskId));
    return;
  }
  await tx
    .insert(agentSessions)
    .values({
      organizationId: run.organizationId,
      agentId: run.agentId,
      taskId: plan.taskId,
      provider: plan.session.provider,
      instructionsBundleVersion: plan.session.instructionsBundleVersion,
      state: plan.session.state,
      runId: run.id,
    })
    .onConflictDoUpdate({
      target: [agentSessions.agentId, agentSessions.taskId],
      set: {
        provider: sql`excluded.provider`,
        instructionsBundleVersion: sql`excluded.instructions_bundle_version`,
        state: sql`excluded.state`,
        runId: sql`excluded.run_id`,
      },
    });
}

/** 에이전트의 세션을 모두 비우고 세대를 올린다. 에이전트 행을 잠근 프로바이더 변경 안에서 부른다. */
export async function resetAgentSessions(tx: Executor, agentId: string) {
  await tx.delete(agentSessions).where(eq(agentSessions.agentId, agentId));
  await tx
    .update(agents)
    .set({ sessionGeneration: sql`${agents.sessionGeneration} + 1` })
    .where(eq(agents.id, agentId));
}
