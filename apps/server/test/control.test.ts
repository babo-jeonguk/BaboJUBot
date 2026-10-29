import {
  agentDetailSchema,
  conversationMessageSchema,
  organizationDetailSchema,
  organizationSchema,
  orgTools,
  runSummaryListSchema,
  type AgentCommand,
  type Event,
  type OrganizationCommand,
  type RunResult,
  type RuntimeAdapter,
  type WakeReason,
} from "@babojubot/contracts";
import { leadReplyScript, type Script } from "@babojubot/runtime";
import { createGate, type Gate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { startServer } from "../src/index.ts";
import { insertLegacyOrganization } from "@babojubot/db/testing";
import {
  chatMessages,
  calls,
  goal,
  idle,
  quietCreation,
  scriptedAgents,
  serverHelpers,
} from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 사용자 제어 명령: 조직 일시정지·재개·중단, 에이전트 일시정지·재개·실행 중단, Lead 대화의 `중단하고 보내기`(#59).

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, say, eventsOf, researching } = serverHelpers(() => t!);

const organization = async (orgId: string) =>
  organizationDetailSchema.parse(await get(`/api/organizations/${orgId}`));
const agentDetail = async (orgId: string, agentId: string) =>
  agentDetailSchema.parse(
    await get(`/api/organizations/${orgId}/agents/${agentId}`)
  );
/**
 * 조직(또는 에이전트 하나)의 실행 시도, 최근 것부터. 생성으로 깨어난 Lead의 첫 실행 시도(조직에서 가장 오래된 실행 시도)는 뺀다.
 */
const runsOf = async (orgId: string, agentId?: string) => {
  const all = runSummaryListSchema.parse(
    await get(`/api/organizations/${orgId}/runs`)
  );
  const list = agentId
    ? runSummaryListSchema.parse(
        await get(`/api/organizations/${orgId}/runs?agentId=${agentId}`)
      )
    : all;
  return list.filter((r) => r.id !== all.at(-1)?.id);
};
const control = (
  orgId: string,
  command: OrganizationCommand | AgentCommand,
  agentId?: string
) =>
  t!.request(
    "POST",
    `/api/organizations/${orgId}${agentId ? `/agents/${agentId}` : ""}/${command}`,
    {}
  );
const interrupt = async (orgId: string, body: string) => {
  const res = await t!.request("POST", `/api/organizations/${orgId}/messages`, {
    body,
    delivery: "interrupt",
  });
  expect(res.status).toBe(201);
  return conversationMessageSchema.parse(res.body);
};
const controlEvents = async (orgId: string) =>
  (await eventsOf(orgId)).filter(
    (e) => e.type.startsWith("organization.") || e.type.startsWith("agent.")
  );
const bodies = (reasons: WakeReason[]) =>
  reasons.flatMap((r) => (r.kind === "owner_message" ? [r.body] : []));

/** gate에서 멈췄다가 열리면 받은 깨우기에 답장하는 Lead 시나리오. 취소되면 gate가 reject해 그대로 끝난다. */
const holding = (gate: Gate): Script => ({
  ...leadReplyScript,
  steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
});

/** 사용자가 목표를 적어 만든 조직. 생성으로 깨어난 Lead의 실행 시도가 끝날 때까지 기다린다. */
async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name, ...goal });
  expect(res.status).toBe(201);
  await t!.drain();
  const org = organizationDetailSchema.parse(res.body);
  return { ...org, lead: org.agents.find((a) => a.role === "lead")! };
}

describe("organization pause and resume", () => {
  it("cancels the running run, holds wakes while paused, and delivers them in one run on resume", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("일시정지 조직");
    const other = await createOrganization("옆 조직");
    const gate = createGate();
    agents.queue(org.lead.id, holding(gate));
    await say(org.id, "첫 메시지");
    await gate.reached;
    const [running] = await runsOf(org.id);

    const paused = await control(org.id, "pause");
    expect(paused.status).toBe(200);
    expect(organizationSchema.parse(paused.body)).toMatchObject({
      stage: "paused",
      pausedFrom: "planning",
    });
    await t.drain();
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({
        id: running!.id,
        status: "cancelled",
        cancelReason: "organization_paused",
      }),
    ]);

    // 일시정지 중 깨우기는 남지만 실행 시도가 되지 않는다. 다른 조직은 그대로 진행한다.
    await say(org.id, "둘");
    await say(org.id, "셋");
    await say(other.id, "옆 조직 메시지");
    await t.drain();
    expect(await runsOf(org.id)).toHaveLength(1);
    expect((await runsOf(other.id)).map((r) => r.status)).toEqual([
      "completed",
    ]);

    const resumed = await control(org.id, "resume");
    expect(resumed.status).toBe(200);
    expect(organizationSchema.parse(resumed.body)).toMatchObject({
      stage: "planning",
      pausedFrom: null,
    });
    await t.drain();
    const [next, cancelled] = await runsOf(org.id);
    expect(cancelled!.id).toBe(running!.id);
    expect(next).toMatchObject({ status: "completed", wakeCount: 2 });
    expect(bodies(agents.of(org.lead.id).at(-1)!.request.wakeReasons)).toEqual([
      "둘",
      "셋",
    ]);
    expect(await controlEvents(org.id)).toMatchObject([
      { type: "organization.created" },
      {
        type: "organization.paused",
        payload: {
          by: "owner",
          from: "planning",
          cancelledRunIds: [running!.id],
        },
      },
      {
        type: "organization.resumed",
        payload: { by: "owner", stage: "planning" },
      },
    ]);
  });

  it("wakes the held agents after a resume even when finding them fails once", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const org = await createOrganization("재개 뒤 깨우기 복구");
    await control(org.id, "pause");
    await say(org.id, "멈춘 동안 보낸 메시지");
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    // 재개는 저장되고, 그 뒤 깨울 에이전트를 찾는 조회만 한 번 실패한다.
    vi.spyOn(t.db, "selectDistinct").mockImplementationOnce(() => {
      throw new Error("temporary lookup failure");
    });

    expect((await control(org.id, "resume")).status).toBe(200);
    // 다른 메시지나 drain 없이 실행 시도가 시작해 끝난다.
    while ((await stream.next(10_000)).type !== "run.finished") {
      /* 완료 barrier */
    }
    stream.close();
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({ status: "completed", wakeCount: 1 }),
    ]);
  });

  it("returns to the stage before the pause, and a repeated pause keeps that stage", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const pauseAndResume = async (orgId: string, stage: string) => {
      expect((await organization(orgId)).stage).toBe(stage);
      expect((await control(orgId, "pause")).body).toMatchObject({
        stage: "paused",
        pausedFrom: stage,
      });
      // 다시 일시정지해도 돌아갈 단계를 덮지 않고 아무것도 남기지 않는다.
      const before = (await eventsOf(orgId)).length;
      const again = await control(orgId, "pause");
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ stage: "paused", pausedFrom: stage });
      expect(await eventsOf(orgId)).toHaveLength(before);
      expect((await control(orgId, "resume")).body).toMatchObject({
        stage,
        pausedFrom: null,
      });
      // 일시정지가 아니면 재개는 아무것도 바꾸지 않는다.
      const unchanged = await control(orgId, "resume");
      expect(unchanged.status).toBe(200);
      expect(unchanged.body).toMatchObject({ stage, pausedFrom: null });
    };

    // 목표를 생성 때 받기 전에 만든 예전 조직.
    const legacy = await insertLegacyOrganization(t.db, "목표 설정 조직");
    await pauseAndResume(legacy.id, "goal_setting");

    // 생성으로 깨어난 Lead가 초기 연구 승인을 요청한 조직.
    const proposing = await createOrganization("승인 대기 조직");
    agents.queue(proposing.lead.id, idle);
    await pauseAndResume(proposing.id, "awaiting_approval");
    // 수정 요청을 받아 계획 수립으로 돌아간 조직(Lead는 읽기만 한다).
    const [approval] = await get(
      `/api/organizations/${proposing.id}/approvals`
    );
    await t.request(
      "POST",
      `/api/organizations/${proposing.id}/approvals/${approval.id}/decision`,
      { decision: "request_changes", note: "팀을 줄여 주세요" }
    );
    await t.drain();
    await pauseAndResume(proposing.id, "planning");

    const org = await researching(agents, "연구 진행 조직");
    await pauseAndResume(org.id, "researching");
  });
});

describe("running runs", () => {
  it("lists every running run however many runs came after it", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "오래 실행 중인 작업자");
    const worker = org.workers[0]!;
    const gate = createGate();
    onTestFinished(() => gate.open());
    agents.queue(worker.id, { steps: [{ do: "hold", until: gate.wait }] });
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "긴 작업", assigneeAgentId: worker.id },
      })
    );
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    const leadRunFinished = async () => {
      // 작업자는 멈춰 있으므로 끝나는 실행 시도는 Lead의 것뿐이다.
      while ((await stream.next(10_000)).type !== "run.finished") {
        /* 완료 barrier */
      }
    };
    await say(org.id, "긴 작업을 맡겨 주세요");
    await gate.reached;
    await leadRunFinished();
    const [held] = await runsOf(org.id, worker.id);
    // 그 뒤 Lead 실행 시도 50개로 최근 목록에서 작업자의 실행 시도를 밀어낸다.
    for (let i = 0; i < 50; i++) {
      await say(org.id, `메시지 ${i}`);
      await leadRunFinished();
    }
    stream.close();
    expect((await runsOf(org.id)).map((r) => r.id)).not.toContain(held!.id);

    expect(
      runSummaryListSchema.parse(
        await get(`/api/organizations/${org.id}/runs?status=running`)
      )
    ).toEqual([
      expect.objectContaining({
        id: held!.id,
        agentId: worker.id,
        status: "running",
      }),
    ]);
  });
});

describe("agent pause and resume", () => {
  it("blocks only that agent's runs, and an organization resume does not lift it", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await researching(agents, "에이전트 일시정지 조직");
    const [held, free] = org.workers;
    const paused = await control(org.id, "pause", held!.id);
    expect(paused.status).toBe(200);
    expect(agentDetailSchema.parse(paused.body)).toMatchObject({
      id: held!.id,
      paused: true,
    });

    agents.queue(held!.id, idle, idle);
    agents.queue(free!.id, idle);
    agents.queue(
      org.lead.id,
      calls(
        {
          tool: "create_task",
          input: { title: "멈춘 작업자 작업", assigneeAgentId: held!.id },
        },
        {
          tool: "create_task",
          input: { title: "다른 작업자 작업", assigneeAgentId: free!.id },
        }
      )
    );
    await say(org.id, "작업을 나눠 주세요");
    await t.drain();
    expect(await runsOf(org.id, held!.id)).toEqual([]);
    expect(await runsOf(org.id, free!.id)).toHaveLength(1);

    // 조직 일시정지·재개는 에이전트 일시정지를 풀지 않는다.
    await control(org.id, "pause");
    await control(org.id, "resume");
    await t.drain();
    expect(await runsOf(org.id, held!.id)).toEqual([]);
    expect((await agentDetail(org.id, held!.id)).paused).toBe(true);

    const resumed = await control(org.id, "resume", held!.id);
    expect(agentDetailSchema.parse(resumed.body).paused).toBe(false);
    await t.drain();
    expect(await runsOf(org.id, held!.id)).toHaveLength(1);
    expect(agents.of(held!.id)[0]!.request.wakeReasons).toMatchObject([
      { kind: "task_assigned", title: "멈춘 작업자 작업" },
    ]);
    expect(
      (await controlEvents(org.id)).filter((e) => e.type.startsWith("agent."))
    ).toMatchObject([
      {
        type: "agent.paused",
        payload: { by: "owner", agentId: held!.id, runId: null },
      },
      { type: "agent.resumed", payload: { by: "owner", agentId: held!.id } },
    ]);
  });

  it("cancels the agent's running run", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("실행 중 에이전트 일시정지");
    const gate = createGate();
    agents.queue(org.lead.id, holding(gate));
    await say(org.id, "긴 일");
    await gate.reached;
    const [running] = await runsOf(org.id);

    await control(org.id, "pause", org.lead.id);
    await t.drain();
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({
        status: "cancelled",
        cancelReason: "agent_paused",
      }),
    ]);
    expect((await organization(org.id)).stage).toBe("planning");
    const [event] = (await eventsOf(org.id)).filter(
      (e) => e.type === "agent.paused"
    );
    expect(event).toMatchObject({
      payload: { agentId: org.lead.id, runId: running!.id },
    });
  });

  it("does not reach an agent of another organization", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const a = await createOrganization("조직 A");
    const b = await createOrganization("조직 B");
    expect((await control(a.id, "pause", b.lead.id)).status).toBe(404);
    expect((await control(a.id, "resume", b.lead.id)).status).toBe(404);
    expect((await agentDetail(b.id, b.lead.id)).paused).toBe(false);
    expect(
      (await control("00000000-0000-4000-8000-000000000000", "pause")).status
    ).toBe(404);
  });
});

describe("organization stop", () => {
  it("cancels running runs, starts no run afterwards even across a restart, and cannot be resumed", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("중단 조직");
    const gate = createGate();
    agents.queue(org.lead.id, holding(gate));
    await say(org.id, "첫 메시지");
    await gate.reached;
    const [running] = await runsOf(org.id);

    const stopped = await control(org.id, "stop");
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stage: "stopped", pausedFrom: null });
    await t.drain();
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({
        status: "cancelled",
        cancelReason: "organization_stopped",
      }),
    ]);

    // 끝난 조직은 줄 세우기·중단하고 보내기 모두 받지 않는다.
    for (const delivery of ["next_run", "interrupt"] as const) {
      const refused = await t.request(
        "POST",
        `/api/organizations/${org.id}/messages`,
        { body: "중단 뒤 메시지", delivery }
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: { code: "organization_closed" } });
    }
    await t.drain();
    expect(await runsOf(org.id)).toHaveLength(1);

    for (const command of ["pause", "resume"] as const) {
      const res = await control(org.id, command);
      expect(res.status, command).toBe(409);
      expect(res.body).toEqual({ error: { code: "organization_closed" } });
    }
    expect((await control(org.id, "pause", org.lead.id)).status).toBe(409);
    expect((await control(org.id, "interrupt", org.lead.id)).body).toEqual({
      error: { code: "organization_closed" },
    });
    // 이미 중단한 조직의 중단은 아무것도 바꾸지 않는다.
    expect((await control(org.id, "stop")).status).toBe(200);
    expect(
      (await eventsOf(org.id)).filter((e) => e.type === "organization.stopped")
    ).toMatchObject([
      {
        payload: {
          by: "owner",
          from: "planning",
          cancelledRunIds: [running!.id],
        },
      },
    ]);
    expect((await organization(org.id)).stage).toBe("stopped");

    await t.stopServer();
    const restarted = await startServer({
      db: t.db,
      port: 0,
      runtime: agents.runtime,
    });
    try {
      await restarted.drain();
    } finally {
      await restarted.close();
    }
    const { listRuns } = await import("@babojubot/db");
    // 생성 깨우기를 받은 실행 시도와 중단으로 취소된 실행 시도뿐이다.
    expect(await listRuns(t.db, org.id)).toHaveLength(2);
  });

  it("can stop a paused organization", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const org = await createOrganization("일시정지 뒤 중단");
    await control(org.id, "pause");
    expect((await control(org.id, "stop")).body).toMatchObject({
      stage: "stopped",
      pausedFrom: null,
    });
    expect(
      (await eventsOf(org.id)).find((e) => e.type === "organization.stopped")
    ).toMatchObject({ payload: { from: "paused" } });
  });
});

describe("interrupt and send", () => {
  it("cancels the running run, records the control command and the message, and hands the message to the next run", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("중단하고 보내기 조직");
    const gate = createGate();
    agents.queue(org.lead.id, holding(gate));
    await say(org.id, "긴 일을 시작해 주세요");
    await gate.reached;
    const [running] = await runsOf(org.id);
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });

    const message = await interrupt(org.id, "방향을 바꿔 주세요");
    expect(message).toMatchObject({
      author: "owner",
      delivery: "interrupt",
      deliveredToRunId: null,
    });
    // 제어 명령과 메시지 두 Event가 함께 저장된 뒤 알려진다.
    const first = [await stream.next(), await stream.next()];
    expect(first).toMatchObject([
      {
        type: "message.created",
        payload: { messageId: message.id, author: "owner" },
      },
      {
        type: "agent.interrupted",
        payload: {
          by: "owner",
          agentId: org.lead.id,
          runId: running!.id,
          messageId: message.id,
        },
      },
    ]);
    stream.close();

    await t.drain();
    const [next, cancelled] = await runsOf(org.id);
    expect(cancelled).toMatchObject({
      id: running!.id,
      status: "cancelled",
      cancelReason: "owner_interrupt",
    });
    expect(next).toMatchObject({ status: "completed", cancelReason: null });
    expect(bodies(agents.of(org.lead.id).at(-1)!.request.wakeReasons)).toEqual([
      "방향을 바꿔 주세요",
    ]);
    const conversation = await chatMessages(t, org.id);
    expect(
      conversation.find((m: { id: string }) => m.id === message.id)
    ).toMatchObject({ deliveredToRunId: next!.id });
    // 조직과 에이전트는 계속 쓸 수 있다.
    expect((await organization(org.id)).stage).toBe("planning");
    expect((await agentDetail(org.id, org.lead.id)).paused).toBe(false);
  });

  it("records the control command without a run when the Lead is idle", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const org = await createOrganization("쉬는 Lead");
    const message = await interrupt(org.id, "바로 반영해 주세요");
    await t.drain();
    expect(
      (await eventsOf(org.id)).find((e) => e.type === "agent.interrupted")
    ).toMatchObject({ payload: { runId: null, messageId: message.id } });
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({ status: "completed", wakeCount: 1 }),
    ]);
  });

  it("joins a run still cleaning up after an earlier cancel instead of recording it as idle", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    // 단언이 실패해도 실행기를 놓아 서버를 닫을 수 있게 한다.
    onTestFinished(() => release());
    let reachedHold!: () => void;
    const holdReached = new Promise<void>((r) => (reachedHold = r));
    const received: WakeReason[][] = [];
    // 첫 실행 시도는 취소를 받고도 정리를 늦게 끝내는 실행기.
    const slow: RuntimeAdapter = {
      async execute(request): Promise<RunResult> {
        received.push(request.wakeReasons);
        if (received.length === 1) {
          reachedHold();
          await released;
        }
        return {
          stopReason: "completed",
          error: null,
          summary: null,
          usage: null,
          nextSession: null,
        };
      },
    };
    t = await startTestServer({ runtime: quietCreation(slow) });
    const org = await createOrganization("정리 중 중단하고 보내기");
    await say(org.id, "긴 일을 시작해 주세요");
    await holdReached;
    const [running] = await runsOf(org.id);

    const first = await interrupt(org.id, "방향을 바꿔 주세요");
    const second = await interrupt(org.id, "이것도 반영해 주세요");
    // 정리 중인 실행 시도도 실행 중이며, 처음 취소 사유를 그대로 둔다.
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({
        id: running!.id,
        status: "running",
        cancelReason: "owner_interrupt",
      }),
    ]);
    expect(
      (await eventsOf(org.id)).filter((e) => e.type === "agent.interrupted")
    ).toMatchObject([
      { payload: { runId: running!.id, messageId: first.id } },
      { payload: { runId: running!.id, messageId: second.id } },
    ]);

    release();
    await t.drain();
    const [next, cancelled] = await runsOf(org.id);
    expect(cancelled).toMatchObject({
      id: running!.id,
      status: "cancelled",
      cancelReason: "owner_interrupt",
    });
    expect(next).toMatchObject({ status: "completed", wakeCount: 2 });
    expect(bodies(received.at(-1)!)).toEqual([
      "방향을 바꿔 주세요",
      "이것도 반영해 주세요",
    ]);
  });
});

describe("stop the current run", () => {
  it("cancels only the running run without a message, keeps the agent unpaused, and lets later wakes start runs", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("실행 중단 조직");
    const gate = createGate();
    agents.queue(org.lead.id, holding(gate));
    await say(org.id, "긴 일을 시작해 주세요");
    await gate.reached;
    const [running] = await runsOf(org.id);
    const before = (await chatMessages(t, org.id)).length;
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });

    const res = await control(org.id, "interrupt", org.lead.id);
    expect(res.status).toBe(200);
    expect(agentDetailSchema.parse(res.body)).toMatchObject({
      id: org.lead.id,
      paused: false,
    });
    expect(await stream.next()).toMatchObject({
      type: "agent.interrupted",
      payload: {
        by: "owner",
        agentId: org.lead.id,
        runId: running!.id,
        messageId: null,
      },
    });
    stream.close();

    await t.drain();
    // 취소된 실행 시도 뒤에 새 실행 시도는 없고, 메시지도 남지 않는다.
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({
        id: running!.id,
        status: "cancelled",
        cancelReason: "owner_interrupt",
      }),
    ]);
    expect(await chatMessages(t, org.id)).toHaveLength(before);
    expect((await organization(org.id)).stage).toBe("planning");

    // 일시정지가 아니므로 다음 메시지는 평소처럼 실행 시도를 시작한다.
    await say(org.id, "이어서 해 주세요");
    await t.drain();
    const [next] = await runsOf(org.id);
    expect(next).toMatchObject({ status: "completed", cancelReason: null });
    expect(bodies(agents.of(org.lead.id).at(-1)!.request.wakeReasons)).toEqual([
      "이어서 해 주세요",
    ]);
  });

  it("changes nothing when the agent is idle or its run is already being cancelled", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let reachedHold!: () => void;
    const holdReached = new Promise<void>((r) => (reachedHold = r));
    let executed = 0;
    // 첫 실행 시도는 취소를 받고도 정리를 늦게 끝내는 실행기.
    const slow: RuntimeAdapter = {
      async execute(): Promise<RunResult> {
        if (++executed === 1) {
          reachedHold();
          await released;
        }
        return {
          stopReason: "completed",
          error: null,
          summary: null,
          usage: null,
          nextSession: null,
        };
      },
    };
    t = await startTestServer({ runtime: quietCreation(slow) });
    const org = await createOrganization("쉬는 Lead의 실행 중단");
    const idleStop = await control(org.id, "interrupt", org.lead.id);
    expect(idleStop.status).toBe(200);
    expect(
      (await eventsOf(org.id)).filter((e) => e.type === "agent.interrupted")
    ).toEqual([]);

    await say(org.id, "긴 일을 시작해 주세요");
    await holdReached;
    expect((await control(org.id, "interrupt", org.lead.id)).status).toBe(200);
    // 정리 중인 실행 시도에 다시 내린 실행 중단은 아무것도 남기지 않는다.
    expect((await control(org.id, "interrupt", org.lead.id)).status).toBe(200);
    expect(
      (await eventsOf(org.id)).filter((e) => e.type === "agent.interrupted")
    ).toHaveLength(1);
    release();
    await t.drain();
    expect((await runsOf(org.id)).map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("does not reach another organization's agent", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const a = await createOrganization("조직 A");
    const b = await createOrganization("조직 B");
    expect((await control(a.id, "interrupt", b.lead.id)).status).toBe(404);
  });
});

describe("cancellation boundary", () => {
  it("closes a cancelled run's token at once and keeps its late result from becoming a success", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let reachedHold!: () => void;
    const holdReached = new Promise<void>((r) => (reachedHold = r));
    const late: { status: number }[] = [];
    // 취소를 무시하고 계속 도구를 쓰려는 실행기.
    const stubborn: RuntimeAdapter = {
      async execute(request): Promise<RunResult> {
        reachedHold();
        await released;
        for (const { method, path } of [
          orgTools.get_run_context,
          orgTools.send_message,
        ]) {
          const res = await t!.tool(
            request.access.token,
            method,
            path,
            method === "POST" ? { body: "취소 뒤 답장" } : undefined
          );
          late.push({ status: res.status });
        }
        return {
          stopReason: "completed",
          error: null,
          summary: "끝까지 했다",
          usage: null,
          nextSession: null,
        };
      },
    };
    t = await startTestServer({ runtime: quietCreation(stubborn) });
    const org = await createOrganization("늦은 결과");
    await say(org.id, "일해 주세요");
    await holdReached;

    await control(org.id, "pause");
    release();
    await t.drain();
    expect(late).toEqual([{ status: 401 }, { status: 401 }]);
    expect(await runsOf(org.id)).toEqual([
      expect.objectContaining({
        status: "cancelled",
        cancelReason: "organization_paused",
      }),
    ]);
    const conversation = await chatMessages(t, org.id);
    expect(conversation.map((m: { author: string }) => m.author)).toEqual([
      "owner",
    ]);
    const finished = (await eventsOf(org.id)).filter(
      (e): e is Extract<Event, { type: "run.finished" }> =>
        e.type === "run.finished"
    );
    // 생성 깨우기를 받은 실행 시도는 맥락만 읽고 끝났다.
    expect(finished.map((e) => e.payload.stopReason)).toEqual([
      "completed",
      "cancelled",
    ]);
  });
});

describe("decisions while paused", () => {
  it("resumes the organization when the owner decides the initial approval, and refuses it once stopped", async () => {
    const agents = scriptedAgents();
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("멈춘 채 승인");
    agents.queue(org.lead.id, leadReplyScript);
    const [approval] = await get(`/api/organizations/${org.id}/approvals`);
    await control(org.id, "pause");

    const decided = await t.request(
      "POST",
      `/api/organizations/${org.id}/approvals/${approval.id}/decision`,
      { decision: "approve" }
    );
    expect(decided.status).toBe(200);
    expect(await organization(org.id)).toMatchObject({
      stage: "researching",
      pausedFrom: null,
    });
    // 재개가 결정 바로 앞에 남는다. 그 뒤에는 깨운 Lead의 실행 시도 Event가 이어질 수 있다.
    const events = await eventsOf(org.id);
    const resumedAt = events.findIndex(
      (e) => e.type === "organization.resumed"
    );
    expect(events.slice(resumedAt, resumedAt + 2)).toMatchObject([
      { type: "organization.resumed", payload: { stage: "awaiting_approval" } },
      { type: "approval.decided", payload: { stage: "researching" } },
    ]);
    await t.drain();
    expect(agents.of(org.lead.id).at(-1)!.request.wakeReasons).toMatchObject([
      { kind: "approval_decision", decision: "approve" },
    ]);

    const stopping = await createOrganization("중단 뒤 승인");
    const [pending] = await get(`/api/organizations/${stopping.id}/approvals`);
    await control(stopping.id, "stop");
    const refused = await t.request(
      "POST",
      `/api/organizations/${stopping.id}/approvals/${pending.id}/decision`,
      { decision: "approve" }
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: { code: "organization_closed" } });
    expect(
      (await get(`/api/organizations/${stopping.id}/approvals/${pending.id}`))
        .status
    ).toBe("pending");
    // 결정할 수 없는 요청은 Inbox에 나오지 않는다(결정한 요청만 기록으로 남는다).
    const inbox = await get("/api/inbox");
    expect(
      inbox.filter(
        (item: { organizationName: string }) =>
          item.organizationName === "중단 뒤 승인"
      )
    ).toEqual([]);
  });
});
