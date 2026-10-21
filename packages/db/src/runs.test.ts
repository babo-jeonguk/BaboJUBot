import { randomUUID } from "node:crypto";
import type { RunResult, WakeReason } from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertOrganizationCreation } from "./organizations.ts";
import {
  appendRunActivity,
  authenticateRun,
  claimNextRun,
  failInterruptedRuns,
  finishRun,
  insertOwnerMessage,
  listAgentsWithPendingWakes,
  listConversation,
  listRuns,
  loadRunContext,
} from "./runs.ts";
import { insertEvent, lockOrganization } from "./rows.ts";
import { organizations } from "./schema.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.close();
});

const source = { newId: randomUUID, now: () => new Date() };
const completed: RunResult = {
  stopReason: "completed",
  error: null,
  summary: "끝",
  usage: null,
  nextSession: null,
};

const messageIdOf = (reason: WakeReason) =>
  reason.kind === "owner_message" ? reason.messageId : undefined;

async function organization() {
  const creation = planOrganizationCreation({ name: "조직" }, [], source);
  await insertOrganizationCreation(t.db, creation);
  const lead = creation.agents[0]!;
  const send = async (body: string) => {
    const plan = planOwnerMessage(
      { organizationId: lead.organizationId, agents: creation.agents },
      { body, delivery: "next_run" },
      source
    );
    await insertOwnerMessage(t.db, plan);
    return plan.message;
  };
  const claim = (tokenDigest = randomUUID()) =>
    claimNextRun(t.db, lead.id, {
      tokenDigest,
      source,
    });
  return { lead, send, claim };
}

describe("wake queue admission", () => {
  it("bundles every pending wake into one run and holds later wakes for the next run", async () => {
    const { lead, send, claim } = await organization();
    const first = await send("하나");
    const second = await send("둘");

    const run1 = await claim();
    expect(run1?.wakeReasons.map(messageIdOf)).toEqual([first.id, second.id]);
    expect(run1?.event).toMatchObject({
      type: "run.started",
      payload: { runId: run1?.run.id },
    });

    const third = await send("셋");
    expect(await claim()).toBeUndefined();

    // 실행 중 도착한 메시지는 지금 실행 시도의 맥락에 섞이지 않는다.
    const context = await loadRunContext(t.db, run1!.run.id);
    expect(context?.wakeReasons.map(messageIdOf)).toEqual([
      first.id,
      second.id,
    ]);
    expect(context?.context.conversation.map((m) => m.body)).toEqual([
      "하나",
      "둘",
    ]);

    expect(
      await finishRun(t.db, run1!.run.id, completed, source)
    ).toMatchObject({ type: "run.finished" });
    const run2 = await claim();
    expect(run2?.wakeReasons.map(messageIdOf)).toEqual([third.id]);

    const conversation = await listConversation(
      t.db,
      lead.organizationId,
      lead.id
    );
    expect(conversation.map((m) => [m.body, m.deliveredToRunId])).toEqual([
      ["하나", run1!.run.id],
      ["둘", run1!.run.id],
      ["셋", run2!.run.id],
    ]);
  });

  it("lets only one of many concurrent claims start a run for the agent", async () => {
    const { lead, send, claim } = await organization();
    for (const body of ["a", "b", "c"]) await send(body);

    const claims = await Promise.all(Array.from({ length: 6 }, () => claim()));

    const started = claims.filter((c) => c !== undefined);
    expect(started).toHaveLength(1);
    expect(started[0]!.wakeReasons).toHaveLength(3);
    const runs = await listRuns(t.db, lead.organizationId, {
      agentId: lead.id,
    });
    expect(runs.map((r) => r.status)).toEqual(["running"]);
  });

  it("does not let one agent's run hold back another agent", async () => {
    const a = await organization();
    const b = await organization();
    await a.send("a");
    await b.send("b");

    const [runA, runB] = await Promise.all([a.claim(), b.claim()]);

    expect(runA).toBeDefined();
    expect(runB).toBeDefined();
  });
});

describe("admission and organization stage", () => {
  /** 다른 연결이 행 잠금을 기다리기 시작할 때까지. */
  const someoneWaitsForALock = async () => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await t.db.execute(
        sql`select 1 from pg_stat_activity where wait_event_type = 'Lock'`
      );
      if (rows.length) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no connection waited for a lock");
  };

  it("serializes a claim behind a stage transition that wakes the same agent, and refuses it once the organization is completed", async () => {
    const { lead, send, claim } = await organization();
    await send("완료 직전 메시지");
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    // 단계 전이처럼 조직 행을 잠근 채, 같은 에이전트를 가리키는 기록(FK로 에이전트 행 KEY SHARE)을 남기고 완료로 넘긴다.
    const transition = t.db.transaction(async (tx) => {
      await lockOrganization(tx, lead.organizationId);
      markLocked();
      await released;
      await insertEvent(tx, {
        organizationId: lead.organizationId,
        type: "message.created",
        payload: {
          messageId: randomUUID(),
          agentId: lead.id,
          author: "owner",
          runId: null,
        },
      });
      await tx
        .update(organizations)
        .set({ stage: "completed" })
        .where(eq(organizations.id, lead.organizationId));
    });
    await locked;
    const claiming = claim();
    await someoneWaitsForALock();
    release();

    // 에이전트 행을 먼저 잠그는 admission이면 여기서 교착(40P01)한다.
    await transition;
    expect(await claiming).toBeUndefined();
    expect(await claim()).toBeUndefined();
    expect(await listAgentsWithPendingWakes(t.db)).not.toContain(lead.id);
  });

  it("lets a stage transition wait for a claim that already holds the organization", async () => {
    const { lead, send, claim } = await organization();
    await send("먼저 온 메시지");
    const run = await claim();
    expect(run).toBeDefined();
    await t.db
      .update(organizations)
      .set({ stage: "completed" })
      .where(eq(organizations.id, lead.organizationId));
    // 이미 시작한 실행 시도는 그대로이고, 끝난 뒤 새 깨우기는 실행 시도가 되지 않는다.
    await send("완료 뒤 메시지");
    expect(await finishRun(t.db, run!.run.id, completed, source)).toBeDefined();
    expect(await claim()).toBeUndefined();
  });
});

describe("run termination", () => {
  it("finishes a run once and then closes its token", async () => {
    const { send, claim } = await organization();
    await send("x");
    const digest = randomUUID();
    const runId = (await claim(digest))!.run.id;

    expect(await authenticateRun(t.db, digest)).toMatchObject({ id: runId });
    await finishRun(t.db, runId, completed, source);

    expect(
      await finishRun(
        t.db,
        runId,
        { ...completed, stopReason: "failed" },
        source
      )
    ).toBeUndefined();
    expect(await authenticateRun(t.db, digest)).toBeUndefined();
    expect(
      await appendRunActivity(t.db, runId, {
        source: "runtime",
        activity: { type: "progress", text: "늦은 활동" },
      })
    ).toBeUndefined();
  });

  it("fails runs a stopped server left running so the agent can run again", async () => {
    const { send, claim } = await organization();
    await send("x");
    const claimed = await claim();

    const events = await failInterruptedRuns(t.db, source);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run.finished",
        payload: expect.objectContaining({
          runId: claimed!.run.id,
          stopReason: "failed",
        }),
      })
    );
    await send("y");
    expect(await claim()).toBeDefined();
  });
});
