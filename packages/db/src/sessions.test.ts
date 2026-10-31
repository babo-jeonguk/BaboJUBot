import { randomUUID } from "node:crypto";
import type { RunResult, SessionState } from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertOwnerMessage } from "./conversations.ts";
import { insertOrganizationCreation } from "./organizations.ts";
import { updateAgentProvider, updateProviderLimit } from "./providers.ts";
import { claimNextRun, finishRun, recoverInterruptedRuns } from "./runs.ts";
import { taskComments, tasks, wakes } from "./schema.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  for (const provider of ["fake", "fake-2"])
    await updateProviderLimit(t.db, provider, 0);
});
afterAll(async () => {
  await t?.close();
});

const source = { newId: randomUUID, now: () => new Date() };
const ended = (nextSession: SessionState | null): RunResult => ({
  stopReason: "completed",
  error: null,
  summary: null,
  usage: null,
  nextSession,
});

/** Lead 하나인 조직. 생성 깨우기의 실행 시도를 세션 없이 끝낸 뒤에서 시작한다. */
async function organization() {
  const creation = planOrganizationCreation(
    { name: "조직", goal: "목표", lead: { provider: "fake", model: null } },
    { files: [] },
    source
  );
  await insertOrganizationCreation(t.db, creation);
  const lead = creation.agents[0]!;
  const organizationId = lead.organizationId;
  const claim = () =>
    claimNextRun(t.db, lead.id, { tokenDigest: randomUUID(), source });
  const created = (await claim())!;
  await finishRun(t.db, created.run.id, ended(null), source);
  const send = (body: string) =>
    insertOwnerMessage(
      t.db,
      planOwnerMessage(
        { organizationId, agents: creation.agents },
        creation.defaultConversation,
        { body, delivery: "next_run" },
        source
      )
    );
  /** Lead에게 맡긴 작업 하나. */
  const task = async () => {
    const id = randomUUID();
    await t.db.insert(tasks).values({
      id,
      organizationId,
      title: "작업",
      description: "",
      status: "open",
      assigneeAgentId: lead.id,
      createdByAgentId: lead.id,
      createdByRunId: created.run.id,
      createdAt: new Date(),
    });
    return id;
  };
  /** 그 작업에 사용자 댓글 하나와 그 댓글 깨우기(작업 깨우기)를 남긴다. */
  const assign = async (taskId: string) => {
    const commentId = randomUUID();
    await t.db.insert(taskComments).values({
      id: commentId,
      organizationId,
      taskId,
      author: "owner",
      body: "댓글",
      createdAt: new Date(),
    });
    await t.db.insert(wakes).values({
      id: randomUUID(),
      organizationId,
      agentId: lead.id,
      kind: "task_comment",
      commentId,
      createdAt: new Date(),
    });
  };
  /** 깨우기를 받아 실행 시도를 시작하고, 이어 받은 세션과 세션 자리를 본 뒤 `next`로 끝낸다. */
  const turn = async (next: SessionState | null) => {
    const claimed = (await claim())!;
    await finishRun(t.db, claimed.run.id, ended(next), source);
    return claimed.run;
  };
  const changeProvider = (provider: string, model: string | null) =>
    updateAgentProvider(t.db, organizationId, lead.id, { provider, model });
  return { lead, claim, send, task, assign, turn, changeProvider };
}

describe("sessions per agent and task", () => {
  it("keeps one session per task and one for the agent, and picks the task's only when every wake is for that task", async () => {
    const org = await organization();
    const a = await org.task();
    const b = await org.task();

    await org.assign(a);
    expect(await org.turn({ at: "A" })).toMatchObject({
      sessionTaskId: a,
      sessionBefore: null,
    });
    await org.send("안녕");
    expect(await org.turn({ at: "agent" })).toMatchObject({
      sessionTaskId: null,
      sessionBefore: null,
    });
    await org.assign(a);
    expect(await org.turn({ at: "A2" })).toMatchObject({
      sessionTaskId: a,
      sessionBefore: { at: "A" },
    });
    // 다른 작업이나 작업 없는 깨우기가 섞이면 에이전트 세션이다.
    await org.assign(a);
    await org.assign(b);
    expect(await org.turn({ at: "agent2" })).toMatchObject({
      sessionTaskId: null,
      sessionBefore: { at: "agent" },
    });
    await org.assign(b);
    await org.send("이것도");
    expect(await org.turn(null)).toMatchObject({
      sessionTaskId: null,
      sessionBefore: { at: "agent2" },
    });
    // 세션을 비운 자리는 새 세션이고, 다른 자리는 그대로다.
    await org.send("다시");
    expect((await org.turn(null)).sessionBefore).toBeNull();
    await org.assign(a);
    expect((await org.turn(null)).sessionBefore).toEqual({ at: "A2" });
  });

  it("clears every session of the agent on a provider change, keeps them on a model change, and a late finish from before the change brings none back", async () => {
    const org = await organization();
    const a = await org.task();
    await org.assign(a);
    await org.turn({ at: "A" });
    await org.send("하나");
    await org.turn({ at: "agent" });

    expect((await org.changeProvider("fake", "fake-max")).kind).toBe("ok");
    await org.send("모델만 바꿈");
    expect((await org.turn({ at: "agent-2" })).sessionBefore).toEqual({
      at: "agent",
    });

    // 실행 중에 A→B→A로 바꾼다. 옛 실행 시도가 늦게 끝나도 세션을 되살리지 않는다.
    await org.send("길게");
    const late = (await org.claim())!;
    expect(late.run.sessionBefore).toEqual({ at: "agent-2" });
    await org.changeProvider("fake-2", null);
    await org.changeProvider("fake", null);
    await finishRun(t.db, late.run.id, ended({ at: "stale" }), source);

    await org.send("새로");
    expect(await org.turn({ at: "fresh" })).toMatchObject({
      provider: "fake",
      sessionBefore: null,
    });
    await org.assign(a);
    expect((await org.turn(null)).sessionBefore).toBeNull();
  });

  it("keeps the session a run started with when the server stops it", async () => {
    const org = await organization();
    await org.send("하나");
    await org.turn({ at: "before" });
    await org.send("멈출 실행");
    await org.claim();
    await recoverInterruptedRuns(t.db, source);
    expect((await org.turn(null)).sessionBefore).toEqual({ at: "before" });
  });
});
