import {
  approvalSchema,
  organizationDetailSchema,
  orgTools,
  providerCatalogSchema,
  type Approval,
} from "@babojubot/contracts";
import { createFakeProviders, type Script } from "@babojubot/runtime";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  idle,
  initialRequest,
  scriptedAgents,
  serverHelpers,
} from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// Lead의 프로바이더·모델 제안과 사용자가 승인하며 바꾼 값(#95). 가짜 연결 둘(`fake`, `fake-2`)로 검증한다.

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, create, say, eventsOf, researching } = serverHelpers(() => t!);

const organization = async (orgId: string) =>
  organizationDetailSchema.parse(await get(`/api/organizations/${orgId}`));
const workersOf = async (orgId: string) =>
  (await organization(orgId)).agents.filter((a) => a.role === "worker");
const pendingOf = async (orgId: string) => {
  const list: { id: string; status: string }[] = await get(
    `/api/organizations/${orgId}/approvals`
  );
  return list.filter((a) => a.status === "pending");
};
const approval = async (orgId: string, approvalId: string) =>
  approvalSchema.parse(
    await get(`/api/organizations/${orgId}/approvals/${approvalId}`)
  );
const decide = (orgId: string, approvalId: string, body: unknown) =>
  t!.request(
    "POST",
    `/api/organizations/${orgId}/approvals/${approvalId}/decision`,
    body
  );
const choiceOf = ({
  provider,
  model,
}: {
  provider: string;
  model: string | null;
}) => ({
  provider,
  model,
});
const teamOf = (a: Approval) => {
  if (a.kind !== "initial_research") throw new Error(a.kind);
  return a.proposal.team;
};

/**
 * 생성으로 깨어난 Lead가 이 시나리오로 초기 연구 승인을 요청하는 서버. 연결 둘이 같은 가짜 adapter를 쓰고,
 * `fake-2`는 받아 오는 모델 목록을 써서 테스트가 목록에서 모델을 뺄 수 있다.
 */
async function leadProposes(created: Script) {
  const agents = scriptedAgents({ created });
  let fake2Models = [
    { id: "fake-2-mini", label: "미니" },
    { id: "fake-2-max", label: "맥스" },
  ];
  const [fake, fake2] = createFakeProviders(2, {
    adapter: () => agents.runtime,
  });
  t = await startTestServer({
    providers: [fake!, { ...fake2!, listModels: async () => fake2Models }],
  });
  return Object.assign(agents, {
    /** `fake-2`의 모델 목록에서 이 모델을 뺀다. */
    dropFake2Model(id: string) {
      fake2Models = fake2Models.filter((m) => m.id !== id);
    },
  });
}
const proposing = (team: object[]): Script => ({
  steps: [
    { do: "call", tool: "list_providers" },
    {
      do: "call",
      tool: "request_initial_approval",
      input: () => ({ ...initialRequest, team }),
      allowRefusal: true,
    },
  ],
});

describe("Lead provider proposals in the initial research approval", () => {
  it("lets the Lead read the provider list, keeps its proposal as sent, and hires each worker with the Owner's choice for that worker", async () => {
    const agents = await leadProposes(
      proposing([
        {
          role: "researcher",
          count: 2,
          provider: "fake-2",
          model: "fake-2-max",
        },
      ])
    );
    const org = await create("작업자별 프로바이더 조직");
    const lead = org.agents.find((a) => a.role === "lead")!;

    const [run] = agents.createdOf(lead.id);
    const [listed, requested] = run!.state.calls;
    expect(listed).toMatchObject({ tool: "list_providers", ok: true });
    const catalog = providerCatalogSchema.parse(
      listed!.ok ? listed!.output : undefined
    );
    expect(catalog).toEqual({
      workerDefault: { provider: "fake", model: null },
      providers: [
        expect.objectContaining({ id: "fake", label: "가짜 프로바이더" }),
        expect.objectContaining({ id: "fake-2", label: "가짜 프로바이더 2" }),
      ],
    });
    // 동시 실행 상한 같은 운영 설정은 Lead에게 보이지 않는다.
    expect(catalog.providers[0]).not.toHaveProperty("maxConcurrentRuns");
    expect(requested).toMatchObject({ ok: true });

    const [pending] = await pendingOf(org.id);
    const before = await approval(org.id, pending!.id);
    expect(teamOf(before)[0]!.choice).toEqual({
      provider: "fake-2",
      model: "fake-2-max",
    });
    expect(before.decidedWorkers).toBeNull();

    // 생길 작업자 수와 다른 목록, 등록되지 않은 연결·모델, 승인 밖의 결정에 실은 값은 받지 않고 아무것도 바꾸지 않는다.
    const mine = { provider: "fake", model: "fake-mini" };
    for (const [body, code] of [
      [{ decision: "approve", choices: [mine] }, "invalid_input"],
      [
        {
          decision: "approve",
          choices: [mine, { provider: "nope", model: null }],
        },
        "unknown_provider",
      ],
      [
        {
          decision: "approve",
          choices: [mine, { provider: "fake", model: "fake-2-max" }],
        },
        "unknown_model",
      ],
      [
        { decision: "request_changes", note: "다시", choices: [mine, mine] },
        "invalid_input",
      ],
    ] as const) {
      const res = await decide(org.id, pending!.id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe(code);
    }
    expect((await approval(org.id, pending!.id)).status).toBe("pending");
    expect(await workersOf(org.id)).toEqual([]);

    agents.queue(lead.id, idle);
    const res = await decide(org.id, pending!.id, {
      decision: "approve",
      choices: [{ provider: "fake-2", model: "fake-2-max" }, mine],
    });
    expect(res.status).toBe(200);
    await t!.drain();

    const workers = await workersOf(org.id);
    expect(workers.map((w) => [w.name, w.provider, w.model])).toEqual([
      ["연구원 1", "fake-2", "fake-2-max"],
      ["연구원 2", "fake", "fake-mini"],
    ]);
    const after = await approval(org.id, pending!.id);
    // 요청은 Lead가 올린 그대로이고, 결정에 작업자마다의 값이 남는다.
    expect(teamOf(after)).toEqual(teamOf(before));
    expect(after.decidedWorkers).toEqual(
      workers.map((w) => ({ agentId: w.id, ...choiceOf(w) }))
    );
    expect(approvalSchema.parse(res.body).decidedWorkers).toEqual(
      after.decidedWorkers
    );
    // 목록에는 결정 기록이 없다.
    const [summary] = await get(`/api/organizations/${org.id}/approvals`);
    expect(summary).not.toHaveProperty("decidedWorkers");
  });

  it("checks only the workers the Owner changed, so a Lead proposal that left the model list since the request does not block changing another worker", async () => {
    const agents = await leadProposes(
      proposing([
        {
          role: "researcher",
          count: 2,
          provider: "fake-2",
          model: "fake-2-mini",
        },
      ])
    );
    const org = await create("일부 작업자 변경 조직");
    const lead = org.agents.find((a) => a.role === "lead")!;
    const [pending] = await pendingOf(org.id);
    const before = await approval(org.id, pending!.id);
    agents.dropFake2Model("fake-2-mini");

    // 바꾼 값이 목록에 없으면 여전히 거부한다.
    const unchanged = { provider: "fake-2", model: "fake-2-mini" };
    const refused = await decide(org.id, pending!.id, {
      decision: "approve",
      choices: [unchanged, { provider: "fake-2", model: "fake-2-gone" }],
    });
    expect([refused.status, refused.body.error.code]).toEqual([
      422,
      "unknown_model",
    ]);

    // 첫 작업자는 Lead 제안 그대로, 둘째만 바꾼다. 바꾸지 않은 Lead 제안은 요청 때 확인한 그대로다.
    agents.queue(lead.id, idle);
    const res = await decide(org.id, pending!.id, {
      decision: "approve",
      choices: [unchanged, { provider: "fake", model: "fake-mini" }],
    });
    expect(res.status).toBe(200);
    await t!.drain();
    const workers = await workersOf(org.id);
    expect(workers.map(choiceOf)).toEqual([
      unchanged,
      { provider: "fake", model: "fake-mini" },
    ]);
    const after = await approval(org.id, pending!.id);
    expect(teamOf(after)).toEqual(teamOf(before));
    expect(after.decidedWorkers).toEqual(
      workers.map((w) => ({ agentId: w.id, ...choiceOf(w) }))
    );
  });

  it("fixes the worker default at request time, so changing the default before the decision does not change who is hired", async () => {
    const agents = await leadProposes(
      proposing([{ role: "researcher", count: 1 }])
    );
    const org = await create("기본값 고정 조직");
    const lead = org.agents.find((a) => a.role === "lead")!;
    const [pending] = await pendingOf(org.id);
    expect(teamOf(await approval(org.id, pending!.id))[0]!.choice).toEqual({
      provider: "fake",
      model: null,
    });

    const defaults = await t!.request("PUT", "/api/providers/defaults", {
      leadDefault: { provider: "fake", model: null },
      workerDefault: { provider: "fake-2", model: "fake-2-mini" },
    });
    expect(defaults.status).toBe(200);
    agents.queue(lead.id, idle);
    expect(
      (await decide(org.id, pending!.id, { decision: "approve" })).status
    ).toBe(200);
    await t!.drain();
    expect((await workersOf(org.id)).map(choiceOf)).toEqual([
      { provider: "fake", model: null },
    ]);
    expect((await approval(org.id, pending!.id)).decidedWorkers).toEqual([
      expect.objectContaining({ provider: "fake", model: null }),
    ]);
  });

  it("refuses a proposal with a provider or model the server does not have, storing no request", async () => {
    const agents = await leadProposes(
      proposing([
        { role: "researcher", count: 1, provider: "fake", model: "fake-2-max" },
      ])
    );
    const org = await create("잘못된 제안 조직");
    const lead = org.agents.find((a) => a.role === "lead")!;
    const [, requested] = agents.createdOf(lead.id)[0]!.state.calls;
    expect(requested).toMatchObject({
      ok: false,
      status: 422,
      code: "unknown_model",
    });
    expect(await pendingOf(org.id)).toEqual([]);
    expect((await organization(org.id)).stage).toBe("planning");
  });

  it("leaves no decision record on reject", async () => {
    const agents = await leadProposes(
      proposing([{ role: "researcher", count: 1 }])
    );
    const org = await create("반려 조직");
    const lead = org.agents.find((a) => a.role === "lead")!;
    const [pending] = await pendingOf(org.id);
    agents.queue(lead.id, idle);
    expect(
      (
        await decide(org.id, pending!.id, {
          decision: "reject",
          note: "아니요",
        })
      ).status
    ).toBe(200);
    await t!.drain();
    expect((await approval(org.id, pending!.id)).decidedWorkers).toBeNull();
  });
});

/**
 * 연구 진행 중인 조직에서 Lead 실행 시도 하나를 멈춰 두고 그 토큰으로 조직 도구를 직접 부른다. 연결 둘이 같은 가짜 adapter를 쓴다.
 * 끝나면 실행 시도를 보내 준다.
 */
async function leadSession(name: string) {
  const agents = scriptedAgents();
  const tokens = new Map<string, string>();
  // `fake-2`는 받아 오는 모델 목록을 쓴다. 테스트가 목록을 바꿔 연결의 모델이 사라진 뒤를 본다.
  let fake2Models = [
    { id: "fake-2-mini", label: "미니" },
    { id: "fake-2-max", label: "맥스" },
  ];
  const [fake, fake2] = createFakeProviders(2, {
    adapter: () => ({
      ...agents.runtime,
      execute(request, control) {
        tokens.set(request.identity.agentId, request.access.token);
        return agents.runtime.execute(request, control);
      },
    }),
  });
  t = await startTestServer({
    providers: [fake!, { ...fake2!, listModels: async () => fake2Models }],
  });
  const org = await researching(agents, name);
  const gate = createGate();
  agents.queue(org.lead.id, { steps: [{ do: "hold", until: gate.wait }] });
  await say(org.id, "작업자를 더 둘지 보세요");
  await gate.reached;
  const token = tokens.get(org.lead.id)!;
  return {
    org,
    tool: (method: string, path: string, body?: unknown) =>
      t!.tool(token, method, path, body),
    addWorker: (body: unknown, key?: string) =>
      t!.request("POST", `/api/tools${orgTools.add_worker.path}`, body, {
        authorization: `Bearer ${token}`,
        ...(key ? { "idempotency-key": key } : {}),
      }),
    /** `fake-2`의 모델 목록에서 이 모델을 뺀다. */
    dropFake2Model(id: string) {
      fake2Models = fake2Models.filter((m) => m.id !== id);
    },
    async finish() {
      agents.queue(org.lead.id, idle, idle);
      gate.open();
      await t!.drain();
    },
  };
}

describe("Lead provider proposals when adding a worker", () => {
  it("adds the worker on the Lead's provider and model right away when the policy is off", async () => {
    const s = await leadSession("정책 꺼짐 프로바이더 조직");
    const res = await s.addWorker({
      role: "researcher",
      provider: "fake-2",
      model: "fake-2-mini",
    });
    expect(res.status).toBe(201);
    expect(res.body.agent).toMatchObject({
      provider: "fake-2",
      model: "fake-2-mini",
    });
    // 모델만 적거나 등록되지 않은 값은 받지 않는다.
    expect(
      (await s.addWorker({ role: "researcher", model: "fake-mini" })).status
    ).toBe(422);
    const unknown = await s.addWorker({ role: "researcher", provider: "nope" });
    expect([unknown.status, unknown.body.error.code]).toEqual([
      422,
      "unknown_provider",
    ]);
    await s.finish();
    expect((await workersOf(s.org.id)).map(choiceOf).at(-1)).toEqual({
      provider: "fake-2",
      model: "fake-2-mini",
    });
  });

  it("with the policy on, keeps the Lead's proposal on the request and hires with the Owner's choice", async () => {
    const s = await leadSession("정책 켜짐 프로바이더 조직");
    await t!.request("PUT", `/api/organizations/${s.org.id}/approval-policy`, {
      addWorker: true,
    });
    const res = await s.addWorker({ role: "researcher", provider: "fake-2" });
    expect(res.status).toBe(202);
    const approvalId = res.body.approval.id as string;
    await s.finish();
    const requested = await approval(s.org.id, approvalId);
    if (requested.kind !== "add_worker") throw new Error(requested.kind);
    expect(requested.proposal.choice).toEqual({
      provider: "fake-2",
      model: null,
    });

    expect(
      (
        await decide(s.org.id, approvalId, {
          decision: "approve",
          choices: [{ provider: "fake", model: "fake-max" }],
        })
      ).status
    ).toBe(200);
    await t!.drain();
    const added = (await workersOf(s.org.id)).at(-1)!;
    expect(choiceOf(added)).toEqual({ provider: "fake", model: "fake-max" });
    const decided = await approval(s.org.id, approvalId);
    if (decided.kind !== "add_worker") throw new Error(decided.kind);
    expect(decided.proposal.choice).toEqual({
      provider: "fake-2",
      model: null,
    });
    expect(decided.decidedWorkers).toEqual([
      { agentId: added.id, provider: "fake", model: "fake-max" },
    ]);
  });

  it("returns the stored outcome for a retried call with the same key even after the proposed model left the provider's list", async () => {
    const s = await leadSession("모델 목록 변동 재시도 조직");
    const body = {
      role: "researcher",
      provider: "fake-2",
      model: "fake-2-mini",
    };
    const first = await s.addWorker(body, "add-1");
    expect(first.status).toBe(201);
    s.dropFake2Model("fake-2-mini");
    // 같은 키·같은 입력은 이미 남긴 결과를 돌려준다. 새 키의 같은 입력은 지금 목록으로 거부한다.
    const retried = await s.addWorker(body, "add-1");
    expect([retried.status, retried.body]).toEqual([201, first.body]);
    const fresh = await s.addWorker(body, "add-2");
    expect([fresh.status, fresh.body.error?.code]).toEqual([
      422,
      "unknown_model",
    ]);
    await s.finish();
    expect(
      (await workersOf(s.org.id)).filter((w) => w.provider === "fake-2")
    ).toHaveLength(1);
  });

  it("answers a repeated approval as already decided even after the chosen model left the provider's list", async () => {
    const s = await leadSession("결정 재전송 조직");
    await t!.request("PUT", `/api/organizations/${s.org.id}/approval-policy`, {
      addWorker: true,
    });
    const res = await s.addWorker({ role: "researcher" });
    const approvalId = res.body.approval.id as string;
    await s.finish();
    const body = {
      decision: "approve",
      choices: [{ provider: "fake-2", model: "fake-2-mini" }],
    };
    expect((await decide(s.org.id, approvalId, body)).status).toBe(200);
    s.dropFake2Model("fake-2-mini");
    const again = await decide(s.org.id, approvalId, body);
    expect([again.status, again.body.error.code]).toEqual([
      409,
      "already_decided",
    ]);
    await t!.drain();
  });

  it("serves the provider list to the Lead only, without any write path", async () => {
    const s = await leadSession("목록 조회 조직");
    const list = await s.tool("GET", orgTools.list_providers.path);
    expect(list.status).toBe(200);
    expect(
      providerCatalogSchema.parse(list.body).providers.map((p) => p.id)
    ).toEqual(["fake", "fake-2"]);
    for (const method of ["PUT", "POST", "PATCH"])
      expect(
        (await s.tool(method, orgTools.list_providers.path, {})).status
      ).toBe(404);
    await s.finish();
    const events = await eventsOf(s.org.id);
    expect(
      events.some(
        (e) =>
          e.type === "run.activity" &&
          JSON.stringify(e.payload).includes("프로바이더 목록 조회: 연결 2개")
      )
    ).toBe(true);
  });
});
