import { randomUUID } from "node:crypto";
import type { RunResult, WakeReason } from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insertOwnerMessage,
  listConversationMessages,
} from "./conversations.ts";
import { insertOrganizationCreation } from "./organizations.ts";
import {
  appendRunActivity,
  authenticateRun,
  claimNextRun,
  finishRun,
  listAgentsWithPendingWakes,
  loadRunContext,
  recoverInterruptedRuns,
} from "./runs.ts";
import { findRunDetail, listRuns } from "./run-views.ts";
import {
  insertEvent,
  lockOrganization,
  lockRunningRun,
  requestCancellation,
} from "./rows.ts";
import { organizations, runs } from "./schema.ts";
import { toolWrite } from "./tool-calls.ts";
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
  const creation = planOrganizationCreation(
    { name: "조직", goal: "목표" },
    { files: [] },
    source
  );
  await insertOrganizationCreation(t.db, creation);
  const lead = creation.agents[0]!;
  const defaultConversation = creation.defaultConversation;
  // 생성 깨우기는 첫 실행 시도가 받는다. 아래 검사는 그 실행 시도가 끝난 뒤의 대기열에서 시작한다.
  const created = await claimNextRun(t.db, lead.id, {
    tokenDigest: randomUUID(),
    source,
  });
  expect(created?.wakeReasons.map((r) => r.kind)).toEqual([
    "organization_created",
  ]);
  await finishRun(t.db, created!.run.id, completed, source);
  const send = async (body: string) => {
    const plan = planOwnerMessage(
      { organizationId: lead.organizationId, agents: creation.agents },
      defaultConversation,
      { body, delivery: "next_run" },
      source
    );
    await insertOwnerMessage(t.db, plan);
    return plan.message;
  };
  const listConversation = () =>
    listConversationMessages(t.db, lead.organizationId, defaultConversation.id);
  const claim = (tokenDigest = randomUUID()) =>
    claimNextRun(t.db, lead.id, {
      tokenDigest,
      source,
    });
  return { lead, send, claim, listConversation };
}

describe("wake queue admission", () => {
  it("bundles every pending wake into one run and holds later wakes for the next run", async () => {
    const { send, claim, listConversation } = await organization();
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

    const conversation = await listConversation();
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
    // 생성 깨우기를 받은 첫 실행 시도는 이미 끝났다.
    expect(runs.map((r) => r.status).sort()).toEqual(["completed", "running"]);
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

describe("admission and organization stage", () => {
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
          conversationId: randomUUID(),
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
    await send("실행 중 메시지");
    await t.db
      .update(organizations)
      .set({ stage: "completed" })
      .where(eq(organizations.id, lead.organizationId));
    // 이미 시작한 실행 시도는 그대로이고, 남은 깨우기는 끝난 뒤 실행 시도가 되지 않는다.
    expect(await finishRun(t.db, run!.run.id, completed, source)).toBeDefined();
    expect(await claim()).toBeUndefined();
  });
});

describe("control commands", () => {
  it("lets a tool write wait behind a cancellation without a deadlock and then refuses it", async () => {
    const { lead, send, claim } = await organization();
    await send("x");
    const digest = randomUUID();
    const runId = (await claim(digest))!.run.id;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    // 제어 명령처럼 조직 행을 잠근 채, 도구 쓰기가 기다리기 시작한 뒤 실행 시도 행에 취소를 요청한다.
    const cancelling = t.db.transaction(async (tx) => {
      await lockOrganization(tx, lead.organizationId);
      markLocked();
      await released;
      await tx
        .update(runs)
        .set({ cancelReason: "organization_paused" })
        .where(eq(runs.id, runId));
    });
    await locked;
    let wrote = false;
    const writing = toolWrite(
      t.db,
      { id: runId, agentRole: "lead" },
      "record_goal",
      {
        activity: {
          source: "control_plane",
          activity: { type: "org_tool", tool: "record_goal", summary: "x" },
        },
      },
      async () => {
        wrote = true;
        return { kind: "ok", value: null, events: [] };
      }
    );
    await someoneWaitsForALock();
    release();

    // 실행 시도 행을 먼저 잠그는 도구 쓰기면 여기서 교착(40P01)한다.
    await cancelling;
    expect(await writing).toEqual({ kind: "run_finished" });
    expect(wrote).toBe(false);
    expect(await authenticateRun(t.db, digest)).toBeUndefined();
    // 실행기가 돌려준 결과와 상관없이 취소로 끝나고, 그 뒤에야 다음 실행 시도가 생긴다.
    await send("y");
    expect(await claim()).toBeUndefined();
    await finishRun(t.db, runId, completed, source);
    expect(
      (await listRuns(t.db, lead.organizationId)).find((r) => r.id === runId)
    ).toMatchObject({
      id: runId,
      status: "cancelled",
      cancelReason: "organization_paused",
    });
    expect(await claim()).toBeDefined();
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

  it("ends runs a stopped server left running and hands their wakes to a new run", async () => {
    const { lead, send, claim, listConversation } = await organization();
    const message = await send("x");
    const digest = randomUUID();
    const interrupted = await claim(digest);

    const events = await recoverInterruptedRuns(t.db, source);

    // 같은 DB를 쓰는 앞 테스트가 실행 중으로 남긴 실행 시도도 함께 끝난다.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run.finished",
        payload: expect.objectContaining({
          runId: interrupted!.run.id,
          stopReason: "server_restart",
          requeuedWakeIds: [interrupted!.wakeReasons[0]!.wakeId],
        }),
      })
    );
    expect(await authenticateRun(t.db, digest)).toBeUndefined();
    // 다시 불러도 이미 끝난 실행 시도는 그대로다.
    expect(await recoverInterruptedRuns(t.db, source)).toEqual([]);
    expect(await listAgentsWithPendingWakes(t.db)).toContain(lead.id);

    const next = await claim();
    expect(next?.run.id).not.toBe(interrupted!.run.id);
    expect(next?.wakeReasons.map(messageIdOf)).toEqual([message.id]);
    // 옛 실행 시도의 기록은 받았던 깨우기를 그대로 보여 준다.
    const old = await findRunDetail(
      t.db,
      lead.organizationId,
      interrupted!.run.id
    );
    expect(old).toMatchObject({ status: "server_restart", wakeCount: 1 });
    expect(old?.wakeReasons.map(messageIdOf)).toEqual([message.id]);
    expect((await listConversation()).map((m) => m.deliveredToRunId)).toEqual([
      next!.run.id,
    ]);
  });

  it("keeps an owner cancellation requested before the server stopped and does not hand its wakes over again", async () => {
    const { lead, send, claim } = await organization();
    await send("x");
    const claimed = await claim();
    await t.db.transaction(async (tx) => {
      await lockRunningRun(tx, claimed!.run.id);
      await requestCancellation(tx, {
        reason: "owner_interrupt",
        runIds: [claimed!.run.id],
      });
    });

    await recoverInterruptedRuns(t.db, source);

    expect(
      await findRunDetail(t.db, lead.organizationId, claimed!.run.id)
    ).toMatchObject({ status: "cancelled", cancelReason: "owner_interrupt" });
    expect(await claim()).toBeUndefined();
  });
});
