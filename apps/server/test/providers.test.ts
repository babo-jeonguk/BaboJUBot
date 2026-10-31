import {
  agentDetailSchema,
  organizationDetailSchema,
  providerSettingsSchema,
  runSummaryListSchema,
  type RunRequest,
  type RuntimeAdapter,
} from "@babojubot/contracts";
import { createFakeProviders } from "@babojubot/runtime";
import { createGate, type Gate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  calls,
  goal,
  idle,
  scriptedAgents,
  serverHelpers,
} from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, say, eventsOf, researching } = serverHelpers(() => t!);

/**
 * 같은 가짜 adapter를 쓰는 이름 붙은 연결 둘(`fake`, `fake-2`). 어느 연결이 어떤 요청을 받았는지 남기고,
 * `hold`로 쌓은 문이 있으면 그 연결의 다음 실행 시도를 문이 열릴 때까지 붙잡는다.
 */
function twoConnections(inner: RuntimeAdapter) {
  const received: { provider: string; request: RunRequest }[] = [];
  const holds = new Map<string, Gate[]>();
  const providers = createFakeProviders(2, {
    adapter: (provider) => ({
      ...inner,
      async execute(request, control) {
        received.push({ provider, request });
        const gate = holds.get(provider)?.shift();
        if (gate) await gate.wait(control.signal);
        return inner.execute(request, control);
      },
    }),
  });
  return {
    providers,
    received,
    /** 이 에이전트의 실행 시도를 받은 연결과 모델, 이전 세션 유무. */
    runsOf: (agentId: string) =>
      received
        .filter((r) => r.request.identity.agentId === agentId)
        .map((r) => ({
          provider: r.provider,
          model: r.request.model,
          resumed: r.request.previousSession !== null,
        })),
    hold(provider: string) {
      const gate = createGate();
      holds.set(provider, [...(holds.get(provider) ?? []), gate]);
      return gate;
    },
  };
}

const settings = async () =>
  providerSettingsSchema.parse(await get("/api/providers"));
const agentOf = async (orgId: string, agentId: string) =>
  agentDetailSchema.parse(
    await get(`/api/organizations/${orgId}/agents/${agentId}`)
  );
const runsOf = async (orgId: string) =>
  runSummaryListSchema.parse(await get(`/api/organizations/${orgId}/runs`));
const createOrganization = async (
  name: string,
  lead?: { provider: string; model: string | null }
) => {
  const res = await t!.request("POST", "/api/organizations", {
    name,
    ...goal,
    ...(lead && { lead }),
  });
  expect(res.status).toBe(201);
  return organizationDetailSchema.parse(res.body);
};
const leadOf = (org: { agents: { role: string; id: string }[] }) =>
  org.agents.find((a) => a.role === "lead")!;

// 기다리는 DB 요청을 확인해 요청 순서를 고정한다. 시간 지연으로 경합을 추측하지 않는다.
async function waitForSettingsWriters(count: number) {
  await expect
    .poll(async () => {
      const { rows } = await t!.db.execute<{ waiting: number }>(`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like '%provider_%' and pid <> pg_backend_pid()
    `);
      return rows[0]!.waiting;
    })
    .toBe(count);
}

describe("concurrent global settings writes", () => {
  it.each([false, true])(
    "signals only actual replacements when the waiting PUT repeats the first choice: %s",
    async (repeatChoice) => {
      t = await startTestServer({ providers: createFakeProviders(2) });
      const watcher = await t.subscribe({ kind: "all" });
      const initial = await settings();
      const original = {
        leadDefault: initial.leadDefault,
        workerDefault: initial.workerDefault,
      };
      const locked = createGate();
      const blocker = t.db.transaction(async (tx) => {
        await tx.execute(
          `select 1 from provider_defaults where role = 'worker' for update`
        );
        await locked.wait(new AbortController().signal);
      });
      await locked.reached;
      const replacement = {
        ...original,
        leadDefault: { provider: "fake-2", model: null },
      };
      const final = repeatChoice ? replacement : original;
      const changing = t.request("PUT", "/api/providers/defaults", replacement);
      let restoring: ReturnType<TestServer["request"]> | undefined;
      try {
        // 첫 PUT이 lead를 잡고 worker를 기다리면, 두 번째 PUT은 lead를 기다린다.
        await waitForSettingsWriters(1);
        restoring = t.request("PUT", "/api/providers/defaults", final);
        await waitForSettingsWriters(2);
      } finally {
        locked.open();
        await blocker;
        await changing;
        await restoring;
      }
      expect((await changing).status).toBe(200);
      expect((await restoring!).status).toBe(200);
      expect(await settings()).toMatchObject(final);
      await expect
        .poll(() => watcher.settingsSignals())
        .toBe(repeatChoice ? 1 : 2);
      expect(watcher.events).toEqual([]);
    }
  );

  it("does not signal unchanged defaults or materializing an implicit default limit", async () => {
    t = await startTestServer();
    const watcher = await t.subscribe({ kind: "all" });
    const initial = await settings();
    const defaults = await t.request("PUT", "/api/providers/defaults", {
      leadDefault: initial.leadDefault,
      workerDefault: initial.workerDefault,
    });
    expect(defaults.status).toBe(200);
    for (const maxConcurrentRuns of [2, 2, 1]) {
      const saved = await t.request("PUT", "/api/providers/fake/limit", {
        maxConcurrentRuns,
      });
      expect(saved.status).toBe(200);
    }
    await expect.poll(() => watcher.settingsSignals()).toBe(1);
  });

  it("signals a limit replacement even when the competing insert was initially invisible", async () => {
    t = await startTestServer();
    const watcher = await t.subscribe({ kind: "all" });
    const inserted = createGate();
    // 상한 행이 아직 없을 때 다른 transaction이 1을 만들고 commit 직전이다.
    const inserting = t.db.transaction(async (tx) => {
      await tx.execute(
        `insert into provider_limits (provider, max_concurrent_runs) values ('fake', 1)`
      );
      await inserted.wait(new AbortController().signal);
    });
    await inserted.reached;
    const saving = t.request("PUT", "/api/providers/fake/limit", {
      maxConcurrentRuns: 2,
    });
    try {
      await waitForSettingsWriters(1);
    } finally {
      inserted.open();
      await inserting;
      await saving;
    }
    expect((await saving).status).toBe(200);
    expect((await settings()).providers[0]!.maxConcurrentRuns).toBe(2);
    await expect.poll(() => watcher.settingsSignals()).toBe(1);
  });
});

describe("provider connections and agent choices", () => {
  it("runs the Lead and the workers each on their own connection, copying the role defaults when they are created", async () => {
    const agents = scriptedAgents();
    const connections = twoConnections(agents.runtime);
    t = await startTestServer({ providers: connections.providers });
    const watcher = await t.subscribe({ kind: "all" });

    // 처음 기본값은 가짜 프로바이더·기본 모델이고, 연결마다 고정 모델 목록과 기본 상한 2가 있다.
    expect(await settings()).toMatchObject({
      leadDefault: { provider: "fake", model: null },
      workerDefault: { provider: "fake", model: null },
      providers: [
        {
          id: "fake",
          label: "가짜 프로바이더",
          models: [
            { id: "fake-mini", label: "미니" },
            { id: "fake-max", label: "맥스" },
          ],
          maxConcurrentRuns: 2,
        },
        {
          id: "fake-2",
          label: "가짜 프로바이더 2",
          models: [
            { id: "fake-2-mini", label: "미니" },
            { id: "fake-2-max", label: "맥스" },
          ],
          maxConcurrentRuns: 2,
        },
      ],
    });
    const saved = await t.request("PUT", "/api/providers/defaults", {
      leadDefault: { provider: "fake-2", model: "fake-2-max" },
      workerDefault: { provider: "fake", model: null },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.leadDefault).toEqual({
      provider: "fake-2",
      model: "fake-2-max",
    });
    // 전역 설정은 조직 Event가 아니라 다시 불러오라는 신호로 다른 화면에 간다.
    await expect.poll(() => watcher.settingsSignals()).toBe(1);
    expect(watcher.events).toEqual([]);

    // 고르지 않은 Lead는 Lead 기본값, 승인으로 생긴 작업자는 작업자 기본값을 복사하고 각자의 연결로 실행된다.
    const org = await researching(agents, "기본값 조직");
    expect(org.lead).toMatchObject({ provider: "fake-2", model: "fake-2-max" });
    expect(org.workers).not.toHaveLength(0);
    for (const worker of org.workers)
      expect(worker).toMatchObject({ provider: "fake", model: null });
    const [w1] = org.workers;
    agents.queue(
      org.lead.id,
      calls({
        tool: "create_task",
        input: { title: "자료 조사", assigneeAgentId: w1!.id },
      })
    );
    await say(org.id, "작업을 나눠 주세요");
    await t.drain();
    expect(
      new Set(connections.runsOf(org.lead.id).map((r) => r.provider))
    ).toEqual(new Set(["fake-2"]));
    expect(connections.runsOf(org.lead.id)[0]!.model).toBe("fake-2-max");
    // 모델을 비운 에이전트의 요청은 모델이 비어 프로바이더 기본 모델을 쓴다.
    expect(connections.runsOf(w1!.id)).toEqual([
      { provider: "fake", model: null, resumed: false },
    ]);
    // 실행 시도 목록은 admission이 고정한 연결·모델을 보인다.
    const listed = await runsOf(org.id);
    expect(
      listed
        .filter((r) => r.agentId === w1!.id)
        .map((r) => [r.provider, r.model])
    ).toEqual([["fake", null]]);

    // 기본값을 바꿔도 이미 있는 에이전트는 그대로이고, 고른 Lead는 그 값으로 만들어져 깨어난다.
    await t.request("PUT", "/api/providers/defaults", {
      leadDefault: { provider: "fake", model: null },
      workerDefault: { provider: "fake-2", model: "fake-2-mini" },
    });
    expect(await agentOf(org.id, w1!.id)).toMatchObject({
      provider: "fake",
      model: null,
    });
    expect(await agentOf(org.id, org.lead.id)).toMatchObject({
      provider: "fake-2",
      model: "fake-2-max",
    });
    const chosen = await createOrganization("고른 Lead 조직", {
      provider: "fake-2",
      model: "fake-2-mini",
    });
    await t.drain();
    expect(connections.runsOf(leadOf(chosen).id)).toEqual([
      { provider: "fake-2", model: "fake-2-mini", resumed: false },
    ]);
  });

  it("refuses a connection the server does not have and a model outside that connection's list", async () => {
    t = await startTestServer({ providers: createFakeProviders(2) });
    const refusals = [
      await t.request("POST", "/api/organizations", {
        name: "없는 연결",
        ...goal,
        lead: { provider: "claude-code", model: null },
      }),
      await t.request("POST", "/api/organizations", {
        name: "다른 연결의 모델",
        ...goal,
        lead: { provider: "fake", model: "fake-2-mini" },
      }),
      await t.request("PUT", "/api/providers/defaults", {
        leadDefault: { provider: "fake", model: null },
        workerDefault: { provider: "fake-3", model: null },
      }),
    ];
    expect(refusals.map((r) => [r.status, r.body.error.code])).toEqual([
      [422, "unknown_provider"],
      [422, "unknown_model"],
      [422, "unknown_provider"],
    ]);
    expect(await get("/api/organizations")).toEqual([]);
    expect((await settings()).workerDefault).toEqual({
      provider: "fake",
      model: null,
    });
    expect(
      (
        await t.request("PUT", "/api/providers/fake-3/limit", {
          maxConcurrentRuns: 1,
        })
      ).status
    ).toBe(404);
    expect(
      (
        await t.request("PUT", "/api/providers/fake/limit", {
          maxConcurrentRuns: -1,
        })
      ).status
    ).toBe(422);
  });

  it("applies an agent's new provider from its next run, lets the running run finish, and starts a new session", async () => {
    const agents = scriptedAgents({ created: idle });
    const connections = twoConnections(agents.runtime);
    t = await startTestServer({ providers: connections.providers });
    const org = await createOrganization("변경 조직");
    const lead = leadOf(org);
    await t.drain();
    const held = connections.hold("fake");
    await say(org.id, "첫 질문");
    await held.reached;

    const changed = await t.request(
      "PUT",
      `/api/organizations/${org.id}/agents/${lead.id}/provider`,
      { provider: "fake-2", model: "fake-2-max" }
    );
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      provider: "fake-2",
      model: "fake-2-max",
      status: "running",
    });
    // 바꾼 모델이 그 연결의 목록에 없으면 받지 않는다.
    const mismatch = await t.request(
      "PUT",
      `/api/organizations/${org.id}/agents/${lead.id}/provider`,
      { provider: "fake", model: "fake-2-max" }
    );
    expect([mismatch.status, mismatch.body.error.code]).toEqual([
      422,
      "unknown_model",
    ]);
    held.open();
    await t.drain();
    await say(org.id, "두 번째 질문");
    await t.drain();

    expect(connections.runsOf(lead.id)).toEqual([
      { provider: "fake", model: null, resumed: false },
      { provider: "fake", model: null, resumed: true },
      // 프로바이더가 바뀌면 다른 연결의 세션을 이어받지 않는다.
      { provider: "fake-2", model: "fake-2-max", resumed: false },
    ]);
    const [latest, previous] = await runsOf(org.id);
    expect([previous!.provider, previous!.status]).toEqual([
      "fake",
      "completed",
    ]);
    expect([latest!.provider, latest!.model]).toEqual(["fake-2", "fake-2-max"]);
    const changes = (await eventsOf(org.id)).filter(
      (e) => e.type === "agent.provider_changed"
    );
    expect(changes.map((e) => e.payload)).toEqual([
      {
        by: "owner",
        agentId: lead.id,
        from: { provider: "fake", model: null },
        to: { provider: "fake-2", model: "fake-2-max" },
      },
    ]);
  });
});

describe("concurrent run cap per connection", () => {
  it("holds wakes beyond the cap until a slot frees, across organizations, without touching other connections", async () => {
    const agents = scriptedAgents({ created: idle });
    const connections = twoConnections(agents.runtime);
    t = await startTestServer({ providers: connections.providers });
    const capped = await t.request("PUT", "/api/providers/fake/limit", {
      maxConcurrentRuns: 1,
    });
    expect(capped.body.providers[0].maxConcurrentRuns).toBe(1);

    const held = connections.hold("fake");
    const first = await createOrganization("먼저 조직");
    await held.reached;
    const second = await createOrganization("기다리는 조직");
    const elsewhere = await createOrganization("다른 연결 조직", {
      provider: "fake-2",
      model: null,
    });
    await expect
      .poll(() => connections.runsOf(leadOf(elsewhere).id).length)
      .toBe(1);
    // 상한을 넘는 깨우기는 실행 시도 없이 기다린다.
    expect(await runsOf(second.id)).toEqual([]);
    expect(connections.runsOf(leadOf(second).id)).toEqual([]);

    held.open();
    await t.drain();
    expect((await runsOf(first.id)).map((r) => r.status)).toEqual([
      "completed",
    ]);
    expect((await runsOf(second.id)).map((r) => r.status)).toEqual([
      "completed",
    ]);
  });

  it("keeps running runs when the cap drops, and starts waiting wakes as soon as the cap rises", async () => {
    const agents = scriptedAgents({ created: idle });
    const connections = twoConnections(agents.runtime);
    t = await startTestServer({ providers: connections.providers });
    const [a, b, c] = [
      connections.hold("fake"),
      connections.hold("fake"),
      connections.hold("fake"),
    ];
    const orgA = await createOrganization("A 조직");
    const orgB = await createOrganization("B 조직");
    await Promise.all([a.reached, b.reached]);

    await t.request("PUT", "/api/providers/fake/limit", {
      maxConcurrentRuns: 1,
    });
    const orgC = await createOrganization("C 조직");
    const running = async () =>
      [
        ...(await runsOf(orgA.id)),
        ...(await runsOf(orgB.id)),
        ...(await runsOf(orgC.id)),
      ].filter((r) => r.status === "running").length;
    // 줄여도 진행 중인 실행 시도는 끊지 않고, 새 깨우기는 기다린다.
    expect(await running()).toBe(2);
    expect(await runsOf(orgC.id)).toEqual([]);

    // 0은 무제한이다. 올리면 기다리던 깨우기가 곧바로 시작한다.
    await t.request("PUT", "/api/providers/fake/limit", {
      maxConcurrentRuns: 0,
    });
    await c.reached;
    expect(await running()).toBe(3);
    a.open();
    b.open();
    c.open();
    await t.drain();
    expect(await running()).toBe(0);
  });
});
