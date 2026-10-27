import {
  conversationMessageListSchema,
  organizationDetailSchema,
  runDetailSchema,
  runSummaryListSchema,
  type RunRequest,
  type RuntimeAdapter,
  type WakeReason,
} from "@babojubot/contracts";
import {
  createScriptedRuntime,
  leadReplyScript,
  type Script,
} from "@babojubot/runtime";
import { createGate, type Gate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
const bodyOf = (reason: WakeReason) =>
  reason.kind === "owner_message" ? reason.body : undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  vi.restoreAllMocks();
});

/** 가짜 실행기를 감싸 받은 요청과 같은 에이전트의 동시 실행 수를 기록한다. */
function observed(inner: RuntimeAdapter) {
  const requests: RunRequest[] = [];
  const running = new Map<string, number>();
  let maxPerAgent = 0;
  const runtime: RuntimeAdapter = {
    async execute(request, control) {
      requests.push(request);
      const agent = request.identity.agentId;
      running.set(agent, (running.get(agent) ?? 0) + 1);
      maxPerAgent = Math.max(maxPerAgent, running.get(agent)!);
      try {
        return await inner.execute(request, control);
      } finally {
        running.set(agent, running.get(agent)! - 1);
      }
    },
  };
  return { runtime, requests, maxPerAgent: () => maxPerAgent };
}

/** 첫 실행 시도만 gate에서 멈추고 그 뒤에는 기본 답장 시나리오를 쓰는 가짜 실행기. */
function holdFirstRun(gate: Gate) {
  let calls = 0;
  return createScriptedRuntime({
    select: () =>
      calls++ === 0
        ? {
            ...leadReplyScript,
            steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
          }
        : leadReplyScript,
  });
}

async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name });
  expect(res.status).toBe(201);
  const org = organizationDetailSchema.parse(res.body);
  return { ...org, lead: org.agents.find((a) => a.role === "lead")! };
}

const say = async (orgId: string, body: string) => {
  const res = await t!.request("POST", `/api/organizations/${orgId}/messages`, {
    body,
  });
  expect(res.status).toBe(201);
  return res.body;
};
const conversation = async (orgId: string) =>
  conversationMessageListSchema.parse(
    (await t!.request("GET", `/api/organizations/${orgId}/messages`)).body
  );
const runs = async (orgId: string) =>
  runSummaryListSchema.parse(
    (await t!.request("GET", `/api/organizations/${orgId}/runs`)).body
  );
const runDetail = async (orgId: string, runId: string) =>
  runDetailSchema.parse(
    (await t!.request("GET", `/api/organizations/${orgId}/runs/${runId}`)).body
  );

describe("Lead conversation", () => {
  it("recovers a failed admission without another message or a drain kick", async () => {
    t = await startTestServer();
    const org = await createOrganization("디스패치 복구");
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    const transaction = t.db.transaction.bind(t.db);
    // 메시지 저장은 성공하고 그 다음 admission transaction만 실패한다.
    vi.spyOn(t.db, "transaction")
      .mockImplementationOnce(transaction)
      .mockRejectedValueOnce(new Error("temporary admission failure"));

    await say(org.id, "한 번만 보낼 메시지");
    while ((await stream.next(10_000)).type !== "run.finished") {
      /* 완료 barrier */
    }
    expect(await conversation(org.id)).toHaveLength(2);
    expect((await runs(org.id)).map((r) => r.status)).toEqual(["completed"]);
    stream.close();
  });

  it("stops retrying admission on shutdown even while the database still fails", async () => {
    t = await startTestServer();
    const org = await createOrganization("복구 중 종료");
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const transaction = t.db.transaction.bind(t.db);
    vi.spyOn(t.db, "transaction")
      .mockImplementationOnce(transaction)
      .mockImplementation(() => {
        failed();
        return Promise.reject(new Error("database unavailable"));
      });
    await say(org.id, "재시도 중 종료할 메시지");
    await failure;
    await t.stopServer();

    const { listRuns } = await import("@babojubot/db");
    expect(await listRuns(t.db, org.id)).toEqual([]);
  });

  it("saves the original result after repeated finish failures and admits the next run", async () => {
    const gate = createGate();
    const inner = holdFirstRun(gate);
    let executions = 0;
    t = await startTestServer({
      runtime: {
        async execute(request, control) {
          executions++;
          const result = await inner.execute(request, control);
          if (executions === 1) {
            const transactions = vi.spyOn(t!.db, "transaction");
            for (let i = 0; i < 4; i++)
              transactions.mockRejectedValueOnce(
                new Error("temporary finish failure")
              );
          }
          return { ...result, summary: "원래 종료 결과" };
        },
      },
    });
    const org = await createOrganization("종료 저장 복구");
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    await say(org.id, "첫 메시지");
    await gate.reached;
    await say(org.id, "다음 메시지");
    gate.open();

    for (let remaining = 2; remaining > 0;) {
      if ((await stream.next(10_000)).type === "run.finished") remaining--;
    }
    expect((await runs(org.id)).map((r) => r.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(executions).toBe(2);
    expect(
      (await conversation(org.id)).filter((m) => m.author === "agent")
    ).toHaveLength(2);
    const [second, first] = await runs(org.id);
    expect((await runDetail(org.id, first!.id)).summary).toBe("원래 종료 결과");
    expect(
      (await runDetail(org.id, second!.id)).wakeReasons.map(bodyOf)
    ).toEqual(["다음 메시지"]);
    stream.close();
  });

  it("wakes the Lead into one run whose scripted reply shows in the conversation and the Event stream", async () => {
    const now = new Date("2026-10-18T09:00:00.000Z");
    t = await startTestServer({ now: () => now });
    const org = await createOrganization("대화 조직");
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });

    const sent = await say(org.id, "  연구 목표를 정하고 싶어요 ");
    expect(sent).toMatchObject({
      author: "owner",
      body: "연구 목표를 정하고 싶어요",
      delivery: "next_run",
      agentId: org.lead.id,
      createdAt: now.toISOString(),
    });
    await t.drain();

    const [run, ...others] = await runs(org.id);
    expect(others).toEqual([]);
    expect(run).toMatchObject({
      agentId: org.lead.id,
      status: "completed",
      wakeCount: 1,
      startedAt: now.toISOString(),
    });
    const messages = await conversation(org.id);
    expect(
      messages.map((m) => [m.author, m.deliveredToRunId, m.sentByRunId])
    ).toEqual([
      ["owner", run!.id, null],
      ["agent", null, run!.id],
    ]);
    expect(messages[1]!.body).toContain("연구 목표를 정하고 싶어요");

    const types = stream.events.map((e) => e.type);
    expect(types[0]).toBe("message.created");
    expect(types).toContain("run.started");
    expect(types.at(-1)).toBe("run.finished");
    expect(stream.events).toContainEqual(
      expect.objectContaining({
        type: "message.created",
        payload: {
          messageId: messages[1]!.id,
          agentId: org.lead.id,
          conversationId: messages[0]!.conversationId,
          author: "agent",
          runId: run!.id,
        },
      })
    );
    stream.close();
  });

  it("merges messages sent during a run into one next run, never running the agent twice at once", async () => {
    const gate = createGate();
    const watch = observed(holdFirstRun(gate));
    t = await startTestServer({ runtime: watch.runtime });
    const org = await createOrganization("병합 조직");

    await say(org.id, "첫 메시지");
    await gate.reached;
    for (const body of ["둘째", "셋째", "둘째"]) await say(org.id, body);
    expect((await runs(org.id)).map((r) => r.status)).toEqual(["running"]);
    gate.open();
    await t.drain();

    const [second, first] = await runs(org.id);
    expect([first!.status, second!.status]).toEqual(["completed", "completed"]);
    expect(
      (await runDetail(org.id, first!.id)).wakeReasons.map(bodyOf)
    ).toEqual(["첫 메시지"]);
    expect(
      (await runDetail(org.id, second!.id)).wakeReasons.map(bodyOf)
    ).toEqual(["둘째", "셋째", "둘째"]);
    expect(watch.requests.map((r) => r.wakeReasons.length)).toEqual([1, 3]);
    // 첫 실행 시도의 맥락에는 실행 중 도착한 메시지가 섞이지 않는다.
    expect(watch.requests[0]!.context.conversation.map((m) => m.body)).toEqual([
      "첫 메시지",
    ]);
    expect(watch.maxPerAgent()).toBe(1);
  });

  it("rejects input outside the message contract and unknown organizations", async () => {
    t = await startTestServer();
    const org = await createOrganization("입력 조직");
    for (const body of [
      { body: "  " },
      { body: "x", agentId: org.lead.id },
      { body: "x", delivery: "steer" },
      {},
    ])
      expect(
        (await t.request("POST", `/api/organizations/${org.id}/messages`, body))
          .status
      ).toBe(422);
    expect(
      (
        await t.request(
          "POST",
          `/api/organizations/${crypto.randomUUID()}/messages`,
          { body: "x" }
        )
      ).status
    ).toBe(404);
    expect(await conversation(org.id)).toEqual([]);
  });
});

describe("organization tools", () => {
  /** 실행 시도 하나를 gate에서 멈춰 두고 그 토큰을 돌려준다. */
  async function heldRun(orgId: string, tokens: string[], gate: Gate) {
    await say(orgId, "토큰을 보여 줘");
    await gate.reached;
    return tokens.at(-1)!;
  }
  /** 받은 토큰을 모으고, 지정한 gate가 있으면 다음 실행 시도 하나를 거기서 멈춘다. */
  function tokenCapture(
    gate: Gate,
    stopReason: "completed" | "failed" | "cancelled" = "completed"
  ) {
    const tokens: string[] = [];
    let inner = holdFirstRun(gate);
    const runtime: RuntimeAdapter = {
      async execute(request, control) {
        tokens.push(request.access.token);
        return { ...(await inner.execute(request, control)), stopReason };
      },
    };
    return {
      tokens,
      runtime,
      hold: (next: Gate) => (inner = holdFirstRun(next)),
    };
  }

  it.each(["completed", "failed", "cancelled"] as const)(
    "refuses every tool, reads included, once the token's run is %s",
    async (stopReason) => {
      const gate = createGate();
      const capture = tokenCapture(gate, stopReason);
      t = await startTestServer({ runtime: capture.runtime });
      const org = await createOrganization("토큰 조직");
      const token = await heldRun(org.id, capture.tokens, gate);
      const ownMessage = (await conversation(org.id))[0]!;
      expect((await t.tool(token, "GET", "/run-context")).status).toBe(200);
      gate.open();
      await t.drain();

      const before = await conversation(org.id);
      const stream = await t.subscribe({
        kind: "organization",
        organizationId: org.id,
      });
      for (const [method, path, body] of [
        ["GET", "/run-context"],
        ["GET", `/messages/${ownMessage.id}`],
        ["POST", "/messages", { body: "늦은 답장" }],
      ] as const) {
        const res = await t.tool(token, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.body).toEqual({ error: { code: "invalid_token" } });
      }
      for (const bad of [undefined, "", "not-a-token"])
        expect((await t.tool(bad, "GET", "/run-context")).status).toBe(401);
      expect(await conversation(org.id)).toEqual(before);
      await stream.expectNoEvents();
      stream.close();
    }
  );

  it("treats another organization's records as nonexistent and takes no organization selector", async () => {
    const gate = createGate();
    const capture = tokenCapture(gate);
    t = await startTestServer({ runtime: capture.runtime });
    // B의 실행 시도를 먼저 끝내 두고(첫 실행 시도만 멈춘다) A의 실행 시도를 멈춰 둔다.
    const b = await createOrganization("조직 B");
    await say(b.id, "B의 비밀 메시지");
    gate.open();
    await t.drain();
    const bMessage = (await conversation(b.id))[0]!;
    const [bRun] = await runs(b.id);
    const holdA = createGate();
    capture.hold(holdA);
    const a = await createOrganization("조직 A");
    const tokenA = await heldRun(a.id, capture.tokens, holdA);
    const streamB = await t.subscribe({
      kind: "organization",
      organizationId: b.id,
    });

    const foreign = await t.tool(tokenA, "GET", `/messages/${bMessage.id}`);
    const missing = await t.tool(
      tokenA,
      "GET",
      `/messages/${crypto.randomUUID()}`
    );
    expect(foreign).toEqual({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect(missing).toEqual(foreign);
    expect((await t.tool(tokenA, "GET", "/messages/nope")).status).toBe(404);
    const ownA = (await conversation(a.id))[0]!;
    expect(
      (await t.tool(tokenA, "GET", `/messages/${ownA.id}`)).body
    ).toMatchObject({ id: ownA.id });

    const context = await t.tool(tokenA, "GET", "/run-context");
    expect(context.body.identity.organizationId).toBe(a.id);
    expect(JSON.stringify(context.body)).not.toContain("B의 비밀 메시지");

    expect(
      (
        await t.tool(tokenA, "POST", "/messages", {
          body: "x",
          organizationId: b.id,
        })
      ).status
    ).toBe(422);
    expect(
      (
        await t.tool(tokenA, "POST", "/messages", {
          body: "x",
          agentId: b.lead.id,
        })
      ).status
    ).toBe(422);
    expect(await conversation(b.id)).toHaveLength(2);
    expect(
      (await t.request("GET", `/api/organizations/${a.id}/runs/${bRun!.id}`))
        .status
    ).toBe(404);
    await streamB.expectNoEvents();
    streamB.close();
    holdA.open();
  });
});

describe("run activity", () => {
  it("keeps only the runtime's allowed public activity plus the control plane's tool summaries, and never the token", async () => {
    const tokens: string[] = [];
    const script: Script = {
      steps: [
        { do: "emit", activity: { type: "thinking", text: "내부 추론" } },
        {
          do: "emit",
          activity: {
            type: "progress",
            text: "공개 진행",
            reasoning: "숨긴 추론",
          },
        },
        { do: "emit", activity: { type: "stdout", text: "raw output" } },
        {
          do: "emit",
          activity: { type: "progress", text: "계획을 세우는 중" },
        },
        { do: "read_context" },
        { do: "send_message", body: () => "답장" },
      ],
    };
    const inner = createScriptedRuntime({ select: () => script });
    t = await startTestServer({
      runtime: {
        execute(request, control) {
          tokens.push(request.access.token);
          return inner.execute(request, control);
        },
      },
    });
    const org = await createOrganization("활동 조직");
    await say(org.id, "시작");
    await t.drain();

    const [run] = await runs(org.id);
    const detail = await runDetail(org.id, run!.id);
    expect(detail.status).toBe("completed");
    const activities = detail.transcript.flatMap((e) =>
      e.type === "run.activity" ? [e.payload.activity] : []
    );
    expect(activities).toEqual([
      {
        source: "runtime",
        activity: { type: "progress", text: "계획을 세우는 중" },
      },
      {
        source: "control_plane",
        activity: {
          type: "org_tool",
          tool: "get_run_context",
          summary: expect.any(String),
        },
      },
      {
        source: "control_plane",
        activity: {
          type: "org_tool",
          tool: "send_message",
          summary: expect.any(String),
        },
      },
    ]);
    expect(detail.transcript.map((e) => e.type)).toEqual([
      "run.started",
      "run.activity",
      "run.activity",
      "message.created",
      "run.activity",
      "run.finished",
    ]);
    const everything = JSON.stringify([
      detail,
      (await t.request("GET", `/api/organizations/${org.id}/events`)).body,
      await conversation(org.id),
    ]);
    expect(everything).not.toContain(tokens[0]!);
    expect(everything).not.toContain("내부 추론");
    expect(everything).not.toContain("숨긴 추론");
    expect(everything).not.toContain("raw output");
  });

  it("records a runtime failure as the run's stop reason and frees the agent for the next run", async () => {
    let calls = 0;
    t = await startTestServer({
      runtime: {
        async execute(request, control) {
          if (calls++ === 0) throw new Error("adapter crashed");
          return createScriptedRuntime().execute(request, control);
        },
      },
    });
    const org = await createOrganization("실패 조직");
    await say(org.id, "하나");
    await t.drain();
    await say(org.id, "둘");
    await t.drain();

    const [second, first] = await runs(org.id);
    expect(first).toMatchObject({
      status: "failed",
      error: expect.any(String),
    });
    expect(second).toMatchObject({ status: "completed" });
  });

  it("filters the organization activity by agent and shows the Lead's status and recent runs", async () => {
    const gate = createGate();
    t = await startTestServer({ runtime: holdFirstRun(gate) });
    const org = await createOrganization("에이전트 조직");
    await say(org.id, "일해 줘");
    await gate.reached;

    const agentPath = `/api/organizations/${org.id}/agents/${org.lead.id}`;
    expect((await t.request("GET", agentPath)).body).toMatchObject({
      id: org.lead.id,
      role: "lead",
      status: "running",
      recentRuns: [{ status: "running" }],
    });
    gate.open();
    await t.drain();
    const agent = (await t.request("GET", agentPath)).body;
    expect(agent).toMatchObject({
      status: "idle",
      recentRuns: [{ status: "completed" }],
    });

    const leadEvents = (
      await t.request(
        "GET",
        `/api/organizations/${org.id}/events?agentId=${org.lead.id}`
      )
    ).body;
    expect(leadEvents.map((e: { type: string }) => e.type)).not.toContain(
      "organization.created"
    );
    expect(leadEvents.length).toBeGreaterThan(3);
    expect(
      (
        await t.request(
          "GET",
          `/api/organizations/${org.id}/agents/${crypto.randomUUID()}`
        )
      ).status
    ).toBe(404);
  });

  it("cancels a running run on shutdown, waits for the runtime to settle, and keeps its wakes for the next start", async () => {
    const gate = createGate();
    t = await startTestServer({ runtime: holdFirstRun(gate) });
    const org = await createOrganization("종료 조직");
    await say(org.id, "멈춰도 돼");
    await gate.reached;

    await t.stopServer();

    const {
      findDefaultConversation,
      listAgentsWithPendingWakes,
      listRuns,
      listConversationMessages,
    } = await import("@babojubot/db");
    const chat = await findDefaultConversation(t.db, org.id);
    expect((await listRuns(t.db, org.id)).map((r) => r.status)).toEqual([
      "server_restart",
    ]);
    expect(await listAgentsWithPendingWakes(t.db)).toEqual([org.lead.id]);
    expect(
      (await listConversationMessages(t.db, org.id, chat!.id)).map(
        (m) => m.author
      )
    ).toEqual(["owner"]);
  });
});
