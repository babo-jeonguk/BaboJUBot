import {
  conversationMessageListSchema,
  conversationMessageSchema,
  organizationDetailSchema,
  providerCatalogSchema,
  providerSettingsSchema,
  runDetailSchema,
  runSummaryListSchema,
  type ProviderReadinessCheck,
  type RuntimeAdapter,
  type WakeReason,
} from "@babojubot/contracts";
import {
  createFakeProvider,
  defaultFakeUsage,
  leadReplyScript,
  type FakeProviderSettings,
  type Script,
} from "@babojubot/runtime";
import { createGate, type Gate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { chatMessages, goal, idle, scriptedAgents } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 넓힌 프로바이더 계약(#96): 실행 중 끼워 넣기와 거절 뒤 줄 세우기, 준비 확인의 갱신 시점, 실행 시도 상세의 사용량.

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const get = async (path: string) => {
  const res = await t!.request("GET", path);
  expect(res.status, path).toBe(200);
  return res.body;
};
const settings = async () =>
  providerSettingsSchema.parse(await get("/api/providers"));
const readinessOf = async (provider: string) =>
  (await settings()).providers.find((p) => p.id === provider)!.readiness;
const runsOf = async (orgId: string) =>
  runSummaryListSchema.parse(await get(`/api/organizations/${orgId}/runs`));
const bodies = (reasons: WakeReason[]) =>
  reasons.flatMap((r) => (r.kind === "owner_message" ? [r.body] : []));

/** gate에서 멈췄다가 열리면 받은 깨우기에 답장하는 Lead 시나리오. */
const holding = (gate: Gate): Script => ({
  ...leadReplyScript,
  steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
});

/**
 * 가짜 연결 둘(`fake`, `fake-2`)이 같은 시나리오 묶음을 연결별 설정으로 쓰는 서버. `wrap`으로 연결의 adapter를 감쌀 수 있다.
 * 실행 시도마다 받은 토큰을 에이전트별로 남긴다.
 */
async function serverWith({
  fake = {},
  fake2 = {},
  wrap = (adapter) => adapter,
}: {
  fake?: FakeProviderSettings;
  fake2?: FakeProviderSettings;
  wrap?: (adapter: RuntimeAdapter, id: string) => RuntimeAdapter;
} = {}) {
  const agents = scriptedAgents({ created: idle });
  const tokens = new Map<string, string>();
  const connection = (id: string, settings: FakeProviderSettings) => {
    const inner = wrap(agents.runtimeWith(settings), id);
    return createFakeProvider({
      id,
      label: id,
      adapter: {
        ...inner,
        execute(request, control) {
          tokens.set(request.identity.agentId, request.access.token);
          return inner.execute(request, control);
        },
      },
    });
  };
  t = await startTestServer({
    providers: [connection("fake", fake), connection("fake-2", fake2)],
  });
  return { agents, tokens };
}

async function createOrganization(name: string, provider = "fake") {
  const res = await t!.request("POST", "/api/organizations", {
    name,
    ...goal,
    lead: { provider, model: null },
  });
  expect(res.status).toBe(201);
  await t!.drain();
  const org = organizationDetailSchema.parse(res.body);
  const [conversation] = await get(
    `/api/organizations/${org.id}/conversations`
  );
  return {
    ...org,
    lead: org.agents.find((a) => a.role === "lead")!,
    conversationId: conversation.id as string,
  };
}

const send = async (
  orgId: string,
  body: string,
  delivery: "next_run" | "steer" = "next_run"
) => {
  const res = await t!.request("POST", `/api/organizations/${orgId}/messages`, {
    body,
    delivery,
  });
  expect(res.status).toBe(201);
  return conversationMessageSchema.parse(res.body);
};

/** 실행 중에 멈춘 Lead. `received`는 끝까지 간 Lead 실행 시도가 받은 사용자 메시지다. */
async function heldLead(
  provider: "fake" | "fake-2",
  options: Parameters<typeof serverWith>[0] = {}
) {
  const { agents, tokens } = await serverWith(options);
  const org = await createOrganization("끼워 넣기 조직", provider);
  const gate = createGate();
  agents.queue(org.lead.id, holding(gate));
  await send(org.id, "긴 일을 시작해 주세요");
  await gate.reached;
  const [running] = await runsOf(org.id);
  const queue = async () =>
    conversationMessageListSchema.parse(
      await get(
        `/api/organizations/${org.id}/conversations/${org.conversationId}/queued-messages`
      )
    );
  const received = () =>
    agents.of(org.lead.id).map((r) => bodies(r.request.wakeReasons));
  return { org, gate, running: running!, queue, received, tokens };
}

describe("steering into the running run", () => {
  it("hands the message to the run the Lead is working on, in the transcript and not in the queue", async () => {
    const { org, gate, running, queue, received } = await heldLead("fake");
    const steered = await send(org.id, "이 방향으로 가 주세요", "steer");
    expect(steered).toMatchObject({
      delivery: "steer",
      deliveredToRunId: running.id,
    });
    expect(await queue()).toEqual([]);
    expect(
      (await chatMessages(t!, org.id)).map((m) => [m.body, m.deliveredToRunId])
    ).toContainEqual(["이 방향으로 가 주세요", running.id]);
    const detail = runDetailSchema.parse(
      await get(`/api/organizations/${org.id}/runs/${running.id}`)
    );
    expect(detail.transcript.map((e) => e.type)).toContain("message.steered");
    expect(detail.wakeReasons.map((r) => r.kind)).toEqual([
      "owner_message",
      "owner_message",
    ]);

    gate.open();
    await t!.drain();
    // 받은 메시지는 다음 실행 시도에 다시 가지 않는다.
    expect(await runsOf(org.id)).toHaveLength(2);
    expect(received()).toEqual([["긴 일을 시작해 주세요"]]);
    // 받은 실행 시도가 끼워 넣은 말을 반영해 그 대화에 답했다.
    expect(
      (await chatMessages(t!, org.id))
        .filter((m) => m.author === "agent" && m.sentByRunId === running.id)
        .map((m) => m.body)
    ).toContainEqual(expect.stringContaining("이 방향으로 가 주세요"));
  });

  it("queues a message the provider refuses, and the next run takes it", async () => {
    const { org, gate, queue, received } = await heldLead("fake", {
      fake: { steerOutcome: "rejected" },
    });
    const steered = await send(org.id, "끼워 넣기 거절", "steer");
    expect(steered).toMatchObject({
      delivery: "next_run",
      deliveredToRunId: null,
    });
    expect((await queue()).map((m) => m.body)).toEqual(["끼워 넣기 거절"]);

    gate.open();
    await t!.drain();
    expect(received().at(-1)).toEqual(["끼워 넣기 거절"]);
  });

  it("queues directly on a provider that cannot steer, which says so in its capabilities", async () => {
    const { org, gate, queue } = await heldLead("fake-2", {
      fake2: { capabilities: { steer: false } },
    });
    expect(
      (await settings()).providers.map((p) => [p.id, p.capabilities.steer])
    ).toEqual([
      ["fake", true],
      ["fake-2", false],
    ]);
    expect(await send(org.id, "넣을 수 없음", "steer")).toMatchObject({
      delivery: "next_run",
      deliveredToRunId: null,
    });
    expect((await queue()).map((m) => m.body)).toEqual(["넣을 수 없음"]);
    gate.open();
    await t!.drain();
  });
});

describe("provider readiness", () => {
  it("checks every connection at startup and shows status, reason and login command, also in the Lead's catalog", async () => {
    const { org, gate, tokens } = await heldLead("fake", {
      fake2: {
        readiness: { status: "not_ready", reason: "product_login_missing" },
      },
    });
    const [fake, fake2] = (await settings()).providers;
    expect(fake).toMatchObject({
      readiness: { status: "ready", reason: null, checking: false },
      loginCommand: "babojubot-fake login",
    });
    expect(fake!.readiness.checkedAt).not.toBeNull();
    expect(fake2!.readiness).toMatchObject({
      status: "not_ready",
      reason: "product_login_missing",
    });
    const catalog = await t!.tool(tokens.get(org.lead.id), "GET", "/providers");
    expect(catalog.status).toBe(200);
    expect(
      providerCatalogSchema
        .parse(catalog.body)
        .providers.map((p) => [p.id, p.readiness])
    ).toEqual([
      ["fake", { status: "ready", reason: null }],
      ["fake-2", { status: "not_ready", reason: "product_login_missing" }],
    ]);
    gate.open();
  });

  it("rechecks one connection on request and all when the settings screen opens, signalling other screens", async () => {
    const fake2: FakeProviderSettings = {
      readiness: { status: "not_ready", reason: "program_missing" },
    };
    await serverWith({ fake2 });
    const watcher = await t!.subscribe({ kind: "all" });

    fake2.readiness = { status: "ready", reason: null };
    const rechecked = await t!.request(
      "POST",
      "/api/providers/fake-2/readiness"
    );
    expect(rechecked.status).toBe(200);
    expect(
      providerSettingsSchema.parse(rechecked.body).providers[1]!.readiness
    ).toMatchObject({ status: "ready", reason: null, checking: false });
    // 확인을 시작할 때와 끝낼 때 다시 불러오라는 신호가 간다.
    await expect.poll(() => watcher.settingsSignals()).toBe(2);
    expect(
      (await t!.request("POST", "/api/providers/nope/readiness")).status
    ).toBe(404);

    fake2.readiness = { status: "unknown", reason: "credentials_unverified" };
    expect((await t!.request("POST", "/api/providers/readiness")).status).toBe(
      202
    );
    await expect
      .poll(async () => (await readinessOf("fake-2")).reason)
      .toBe("credentials_unverified");
    expect(watcher.events).toEqual([]);
  });

  it("saves only the latest check and stops showing it as checking once that check ends, even if an older one is still going", async () => {
    const older = createGate();
    // 검사가 시작한 확인 순서대로의 결과. 서버 시작의 확인은 세지 않는다.
    const results: ProviderReadinessCheck[] = [
      { status: "not_ready", reason: "program_missing" },
      { status: "not_ready", reason: "credentials_invalid" },
    ];
    // 검사가 시작할 때까지의 확인 수. 그 전(서버 시작의 확인)은 -1이다.
    let started = -1;
    let checks = 0;
    await serverWith({
      wrap: (adapter, id) =>
        id === "fake-2"
          ? {
              ...adapter,
              async checkReadiness(signal): Promise<ProviderReadinessCheck> {
                checks++;
                if (started < 0) return { status: "ready", reason: null };
                const n = checks - started;
                if (n === 1) await older.wait(signal);
                return results[n - 1]!;
              },
            }
          : adapter,
    });
    started = checks;
    const first = t!.request("POST", "/api/providers/fake-2/readiness");
    await older.reached;
    const second = await t!.request("POST", "/api/providers/fake-2/readiness");
    expect(
      providerSettingsSchema.parse(second.body).providers[1]!.readiness
    ).toMatchObject({ reason: "credentials_invalid", checking: false });

    older.open();
    expect((await first).status).toBe(200);
    // 먼저 시작해 늦게 끝난 확인은 새 결과를 덮지 않는다.
    expect(await readinessOf("fake-2")).toMatchObject({
      reason: "credentials_invalid",
      checking: false,
    });
  });

  it("does not hold runs for a slow check and never moves an agent off a provider that is not ready", async () => {
    const slow = createGate();
    let checks = 0;
    await serverWith({
      wrap: (adapter, id) =>
        id === "fake-2"
          ? {
              ...adapter,
              async checkReadiness(signal): Promise<ProviderReadinessCheck> {
                if (++checks > 1) await slow.wait(signal);
                return { status: "not_ready", reason: "credentials_invalid" };
              },
            }
          : adapter,
    });
    const org = await createOrganization("느린 확인 조직", "fake-2");
    const rechecking = t!.request("POST", "/api/providers/fake-2/readiness");
    await slow.reached;
    expect(await readinessOf("fake-2")).toMatchObject({
      status: "not_ready",
      checking: true,
    });

    await send(org.id, "확인을 기다리지 마세요");
    await t!.drain();
    expect((await runsOf(org.id)).map((r) => [r.provider, r.status])).toEqual([
      ["fake-2", "completed"],
      ["fake-2", "completed"],
    ]);
    slow.open();
    expect((await rechecking).status).toBe(200);
    expect((await readinessOf("fake-2")).checking).toBe(false);
  });

  it("rechecks a connection after a run fails for a missing product login", async () => {
    let checks = 0;
    await serverWith({
      wrap: (adapter, id) =>
        id === "fake"
          ? {
              ...adapter,
              async checkReadiness() {
                checks++;
                return checks > 1
                  ? { status: "not_ready", reason: "product_login_missing" }
                  : { status: "ready", reason: null };
              },
              async execute(request, control) {
                if (!bodies(request.wakeReasons).includes("로그인 실패"))
                  return adapter.execute(request, control);
                return {
                  stopReason: "failed",
                  error: "제품 로그인이 필요합니다.",
                  errorCode: "login_required",
                  summary: null,
                  usage: null,
                  nextSession: null,
                };
              },
            }
          : adapter,
    });
    const org = await createOrganization("로그인 조직");
    expect(checks).toBe(1);
    await send(org.id, "로그인 실패");
    await t!.drain();
    await expect
      .poll(async () => (await readinessOf("fake")).reason)
      .toBe("product_login_missing");
    expect(checks).toBe(2);
  });
});

describe("usage in the run detail", () => {
  it("keeps each token count and the cost apart, with unreported figures left unreported", async () => {
    await serverWith({
      fake2: { capabilities: { usageCost: false } },
    });
    const usageOf = async (provider: string) => {
      const org = await createOrganization(`사용량 ${provider}`, provider);
      const [run] = await runsOf(org.id);
      return runDetailSchema.parse(
        await get(`/api/organizations/${org.id}/runs/${run!.id}`)
      ).usage;
    };
    expect(await usageOf("fake")).toEqual(defaultFakeUsage);
    expect(await usageOf("fake-2")).toEqual({
      ...defaultFakeUsage,
      costUsd: null,
    });
  });
});
