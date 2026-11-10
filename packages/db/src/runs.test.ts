import { randomUUID } from "node:crypto";
import type { RunResult, Usage, WakeReason } from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insertOwnerMessage,
  listConversationMessages,
} from "./conversations.ts";
import { insertOrganizationCreation } from "./organizations.ts";
import { updateAgentProvider, updateProviderLimit } from "./providers.ts";
import {
  appendRunActivity,
  authenticateRun,
  claimNextRun,
  finishRun,
  interruptRun,
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
import {
  createTestDatabase,
  failRunEnd,
  type TestDatabase,
} from "./testing.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  // 이 파일의 검사들은 한 DB에 진행 중인 실행 시도를 남긴다. 가짜 연결의 동시 실행 상한을 풀어 서로 막지 않게 한다.
  await updateProviderLimit(t.db, "fake", 0);
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

async function organization(
  choice: { provider: string; model: string | null } = {
    provider: "fake",
    model: null,
  }
) {
  const creation = planOrganizationCreation(
    { name: "조직", goal: "목표", lead: choice },
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

describe("provider connection admission", () => {
  // 연결 ID를 테스트마다 따로 써서 같은 DB의 다른 테스트 실행 시도가 세어지지 않게 한다.
  const connection = () => `p-${randomUUID().slice(0, 8)}`;
  const waiting = async (provider: string) => {
    const org = await organization({ provider, model: null });
    await org.send("일");
    return org;
  };

  it("starts no more runs on a connection than its cap across organizations, while other connections run independently", async () => {
    const shared = connection();
    const other = connection();
    await updateProviderLimit(t.db, shared, 1);
    await updateProviderLimit(t.db, other, 1);
    const orgs = [
      await waiting(shared),
      await waiting(shared),
      await waiting(shared),
    ];
    const elsewhere = await waiting(other);

    const claims = await Promise.all(orgs.map((o) => o.claim()));
    const started = claims.filter((c) => c !== undefined);
    expect(started).toHaveLength(1);
    expect(started[0]!.run).toMatchObject({ provider: shared, model: null });
    // 다른 연결은 그 연결의 상한만 따른다.
    expect(await elsewhere.claim()).toBeDefined();

    // 상한을 넘는 깨우기는 그대로 기다리며, 가장 오래 기다린 에이전트부터 다시 촉진할 수 있다.
    const waiters = orgs
      .filter((_, i) => claims[i] === undefined)
      .map((o) => o.lead.id);
    expect(
      await listAgentsWithPendingWakes(t.db, { provider: shared })
    ).toEqual(waiters);

    await finishRun(t.db, started[0]!.run.id, completed, source);
    const next = await Promise.all(
      orgs.filter((_, i) => claims[i] === undefined).map((o) => o.claim())
    );
    expect(next.filter((c) => c !== undefined)).toHaveLength(1);
  });

  it("keeps runs going when the cap drops, admits again only below the new cap, and treats 0 as unlimited", async () => {
    const provider = connection();
    const [a, b, c] = [
      await waiting(provider),
      await waiting(provider),
      await waiting(provider),
    ];
    const runA = await a.claim();
    const runB = await b.claim();
    expect(runA && runB).toBeDefined();
    expect(await c.claim()).toBeUndefined();

    await updateProviderLimit(t.db, provider, 1);
    // 줄여도 진행 중인 실행 시도는 끊지 않는다.
    const [stillRunning] = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        sql`${runs.provider} = ${provider} and ${runs.status} = 'running'`
      );
    expect(stillRunning!.n).toBe(2);
    await finishRun(t.db, runA!.run.id, completed, source);
    expect(await c.claim()).toBeUndefined();
    await finishRun(t.db, runB!.run.id, completed, source);
    const runC = await c.claim();
    expect(runC).toBeDefined();

    await updateProviderLimit(t.db, provider, 0);
    await a.send("둘");
    await b.send("둘");
    expect(await a.claim()).toBeDefined();
    expect(await b.claim()).toBeDefined();
  });

  it("pins the agent's provider and model on each run and starts a new session after a provider change", async () => {
    const provider = connection();
    const { lead, send, claim } = await organization({
      provider,
      model: "m1",
    });
    await send("하나");
    const first = await claim();
    expect(first?.run).toMatchObject({ provider, model: "m1" });
    await finishRun(
      t.db,
      first!.run.id,
      { ...completed, nextSession: { turn: 1 } },
      source
    );

    // 실행 중에 바꿔도 그 실행 시도는 고정한 값으로 끝나고, 다음 실행 시도가 새 값이다.
    await send("둘");
    const second = await claim();
    expect(second?.run.sessionBefore).toEqual({ turn: 1 });
    const other = connection();
    expect(
      (
        await updateAgentProvider(t.db, lead.organizationId, lead.id, {
          provider: other,
          model: null,
        })
      ).kind
    ).toBe("ok");
    const [pinned] = await listRuns(t.db, lead.organizationId, {
      agentId: lead.id,
      limit: 1,
    });
    expect(pinned).toMatchObject({ provider, model: "m1" });
    await finishRun(
      t.db,
      second!.run.id,
      { ...completed, nextSession: { turn: 2 } },
      source
    );
    await send("셋");
    const third = await claim();
    expect(third?.run).toMatchObject({
      provider: other,
      model: null,
      sessionBefore: null,
    });
  });
});

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
    ).toMatchObject({ after: { events: [{ type: "run.finished" }] } });
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
    // 프로바이더가 돌려준 결과와 상관없이 취소로 끝나고, 그 뒤에야 다음 실행 시도가 생긴다.
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
    const first = await finishRun(
      t.db,
      runId,
      { ...completed, usage: usage(10) },
      source
    );
    expect(first).toMatchObject({
      kind: "ok",
      value: "ended",
      after: {
        events: [
          {
            type: "run.finished",
            payload: expect.objectContaining({
              runId,
              stopReason: "completed",
            }),
          },
        ],
        providersFreed: ["fake"],
      },
    });

    // 같은 종료를 다시 저장해도(commit 응답을 잃은 재시도) 상태·사용량·Event는 그대로이고 자리를 기다리는 에이전트는 다시 촉진한다.
    const eventsBefore = await runEventCount(runId);
    expect(
      await finishRun(
        t.db,
        runId,
        { ...completed, stopReason: "failed", usage: usage(99) },
        source
      )
    ).toEqual({
      kind: "ok",
      value: "already_ended",
      after: { events: [], providersFreed: ["fake"] },
    });
    expect(await runEventCount(runId)).toBe(eventsBefore);
    const [row] = await t.db
      .select({ status: runs.status, usage: runs.usage })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(row).toEqual({ status: "completed", usage: usage(10) });
    expect(await authenticateRun(t.db, digest)).toBeUndefined();
    expect(
      await appendRunActivity(t.db, runId, {
        source: "runtime",
        activity: { type: "progress", text: "늦은 활동" },
      })
    ).toBeUndefined();
  });

  it("frees no provider slot for a run that does not exist", async () => {
    const result = { ...completed };
    expect(await finishRun(t.db, randomUUID(), result, source)).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(await interruptRun(t.db, randomUUID(), source)).toEqual({
      kind: "refused",
      reason: "not_found",
    });
  });

  it("frees the provider the run was admitted on after the agent switched providers", async () => {
    const { lead, send, claim } = await organization();
    await send("x");
    const runId = (await claim())!.run.id;
    expect(
      (
        await updateAgentProvider(t.db, lead.organizationId, lead.id, {
          provider: "fake-2",
          model: null,
        })
      ).kind
    ).toBe("ok");

    expect(await finishRun(t.db, runId, completed, source)).toMatchObject({
      after: { providersFreed: ["fake"] },
    });
  });

  it("leaves the run, its usage, its session, and its Events untouched when the end cannot be saved, and saves the same end on retry", async () => {
    const { send, claim } = await organization();
    await send("x");
    const runId = (await claim())!.run.id;
    const ending: RunResult = {
      ...completed,
      usage: usage(7),
      nextSession: { at: "after" },
    };
    const eventsBefore = await runEventCount(runId);

    await failingRunFinishedEvents(runId, async () => {
      await expect(finishRun(t.db, runId, ending, source)).rejects.toThrow();
    });
    const [kept] = await t.db
      .select({
        status: runs.status,
        usage: runs.usage,
        sessionAfter: runs.sessionAfter,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(kept).toEqual({
      status: "running",
      usage: null,
      sessionAfter: null,
    });
    expect(await runEventCount(runId)).toBe(eventsBefore);

    expect(await finishRun(t.db, runId, ending, source)).toMatchObject({
      value: "ended",
    });
    const [saved] = await t.db
      .select({ status: runs.status, usage: runs.usage })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(saved).toEqual({ status: "completed", usage: usage(7) });
    expect(await runEventCount(runId)).toBe(eventsBefore + 1);
  });

  it("ends runs a stopped server left running and hands their wakes to a new run", async () => {
    const { lead, send, claim, listConversation } = await organization();
    const message = await send("x");
    const digest = randomUUID();
    const interrupted = await claim(digest);

    const after = await recoverInterruptedRuns(t.db, source);

    // 같은 DB를 쓰는 앞 테스트가 실행 중으로 남긴 실행 시도도 함께 끝난다.
    expect(after.events).toContainEqual(
      expect.objectContaining({
        type: "run.finished",
        payload: expect.objectContaining({
          runId: interrupted!.run.id,
          stopReason: "server_restart",
          requeuedWakeIds: [interrupted!.wakeReasons[0]!.wakeId],
        }),
      })
    );
    expect(after.woken).toContain(lead.id);
    expect(after.providersFreed).toContain("fake");
    expect(await authenticateRun(t.db, digest)).toBeUndefined();
    // 다시 불러도 이미 끝난 실행 시도는 그대로다.
    expect(await recoverInterruptedRuns(t.db, source)).toEqual({
      events: [],
      woken: [],
      providersFreed: [],
    });
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

  it("keeps the runs it already ended when a later recovery fails, and ends only the rest on the next start", async () => {
    // 앞 테스트가 남긴 실행 시도를 먼저 정리한다.
    await recoverInterruptedRuns(t.db, source);
    const first = await organization();
    const second = await organization();
    await first.send("x");
    await second.send("y");
    const early = (await first.claim())!.run.id;
    const late = (await second.claim())!.run.id;

    await failingRunFinishedEvents(late, async () => {
      await expect(recoverInterruptedRuns(t.db, source)).rejects.toThrow();
    });
    const status = async (runId: string) =>
      (
        await t.db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, runId))
      )[0]!.status;
    expect(await status(early)).toBe("server_restart");
    expect(await status(late)).toBe("running");
    const earlyEvents = await runEventCount(early);

    const after = await recoverInterruptedRuns(t.db, source);
    expect(after.events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ runId: late, stopReason: "server_restart" }),
    ]);
    expect(after.woken).toEqual([second.lead.id]);
    expect(await status(late)).toBe("server_restart");
    expect(await runEventCount(early)).toBe(earlyEvents);
  });
});

/** 실행 시도의 Event 수. */
async function runEventCount(runId: string) {
  const { rows } = await t.db.execute<{ count: number }>(
    sql`select count(*)::int as count from events where payload->>'runId' = ${runId}`
  );
  return rows[0]!.count;
}

/** 그 실행 시도의 종료 Event 기록이 실패하는 동안 `during`을 한다. */
async function failingRunFinishedEvents(
  runId: string,
  during: () => Promise<void>
) {
  const restore = await failRunEnd(t.db, runId);
  try {
    await during();
  } finally {
    await restore();
  }
}

const usage = (inputTokens: number): Usage => ({
  inputTokens,
  outputTokens: 1,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
});
