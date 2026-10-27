import {
  agentDetailSchema,
  conversationMessageListSchema,
  organizationDetailSchema,
  runSummaryListSchema,
} from "@babojubot/contracts";
import { leadReplyScript } from "@babojubot/runtime";
import { createGate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/index.ts";
import {
  goal,
  idle,
  quietCreation,
  reasons,
  scriptedAgents,
} from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const minutes = (n: number) => n * 60_000;

/** 테스트가 옮기는 서버 시계. */
function clock(start = "2026-10-22T00:00:00.000Z") {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
    iso: (offsetMs = 0) => new Date(at + offsetMs).toISOString(),
  };
}

/** 사용자가 목표를 적어 만든 조직. 생성으로 깨어난 Lead의 실행 시도가 끝날 때까지 기다린다. */
async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name, ...goal });
  expect(res.status).toBe(201);
  await t!.drain();
  const org = organizationDetailSchema.parse(res.body);
  return { ...org, lead: org.agents.find((a) => a.role === "lead")! };
}
const agentPath = (orgId: string, agentId: string) =>
  `/api/organizations/${orgId}/agents/${agentId}`;
const agent = async (orgId: string, agentId: string) =>
  agentDetailSchema.parse(
    (await t!.request("GET", agentPath(orgId, agentId))).body
  );
const setHeartbeat = (
  orgId: string,
  agentId: string,
  input: { enabled: boolean; intervalMinutes: number }
) => t!.request("PUT", `${agentPath(orgId, agentId)}/heartbeat`, input);
/** 조직의 실행 시도(최근 것부터). 생성 깨우기를 받은 첫 실행 시도는 뺀다. */
const runs = async (orgId: string) =>
  runSummaryListSchema
    .parse((await t!.request("GET", `/api/organizations/${orgId}/runs`)).body)
    .slice(0, -1);
const say = async (orgId: string, body: string) => {
  const res = await t!.request("POST", `/api/organizations/${orgId}/messages`, {
    body,
  });
  expect(res.status).toBe(201);
};

describe("heartbeat", () => {
  it("wakes the agent with a heartbeat once the interval passes and stops when turned off", async () => {
    const time = clock();
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime, now: time.now });
    const org = await createOrganization("heartbeat 조직");

    // 새 에이전트는 꺼져 있고 간격은 하네스 Lead Role의 기본값이다.
    expect((await agent(org.id, org.lead.id)).heartbeat).toEqual({
      enabled: false,
      intervalMinutes: 60,
      roleDefaultMinutes: 60,
      nextAt: null,
    });
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    const on = await setHeartbeat(org.id, org.lead.id, {
      enabled: true,
      intervalMinutes: 30,
    });
    expect(on.status).toBe(200);
    expect(agentDetailSchema.parse(on.body).heartbeat).toEqual({
      enabled: true,
      intervalMinutes: 30,
      roleDefaultMinutes: 60,
      nextAt: time.iso(minutes(30)),
    });
    expect(await stream.next()).toMatchObject({
      type: "agent.heartbeat_changed",
      payload: {
        by: "owner",
        agentId: org.lead.id,
        enabled: true,
        intervalMinutes: 30,
      },
    });

    time.advance(minutes(30) - 1);
    await t.tickHeartbeats();
    await t.drain();
    expect(await runs(org.id)).toEqual([]);

    time.advance(1);
    await t.tickHeartbeats();
    await t.tickHeartbeats();
    await t.drain();
    const [run] = await runs(org.id);
    expect(run).toMatchObject({ status: "completed", wakeCount: 1 });
    expect(reasons(agents.of(org.lead.id))).toEqual([
      { kind: "heartbeat", wakeId: expect.any(String) },
    ]);
    // heartbeat만으로 깨어난 가짜 Lead는 사용자에게 답장하지 않는다.
    expect(
      conversationMessageListSchema.parse(
        (await t.request("GET", `/api/organizations/${org.id}/messages`)).body
      )
    ).toEqual([]);
    expect((await agent(org.id, org.lead.id)).heartbeat.nextAt).toBe(
      time.iso(minutes(30))
    );

    const off = await setHeartbeat(org.id, org.lead.id, {
      enabled: false,
      intervalMinutes: 30,
    });
    expect(agentDetailSchema.parse(off.body).heartbeat).toMatchObject({
      enabled: false,
      nextAt: null,
    });
    time.advance(minutes(120));
    await t.tickHeartbeats();
    await t.drain();
    expect(await runs(org.id)).toHaveLength(1);
    stream.close();
  });

  it("merges a heartbeat with other wakes waiting for the agent into one run", async () => {
    const time = clock();
    const gate = createGate();
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime, now: time.now });
    const org = await createOrganization("병합 조직");
    agents.queue(org.lead.id, {
      ...leadReplyScript,
      steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
    });
    await setHeartbeat(org.id, org.lead.id, {
      enabled: true,
      intervalMinutes: 30,
    });
    await say(org.id, "첫 메시지");
    await gate.reached;

    // 실행 중에 온 메시지와 지난 heartbeat는 다음 실행 시도 하나로 간다. 같은 heartbeat는 여러 번 확인해도 하나다.
    await say(org.id, "실행 중에 보낸 메시지");
    time.advance(minutes(30));
    await t.tickHeartbeats();
    time.advance(minutes(30));
    await t.tickHeartbeats();
    gate.open();
    await t.drain();

    expect((await runs(org.id)).map((r) => r.wakeCount)).toEqual([2, 1]);
    expect(
      agents
        .of(org.lead.id)
        .map((r) => r.request.wakeReasons.map((w) => w.kind))
    ).toEqual([["owner_message"], ["owner_message", "heartbeat"]]);
  });

  it("wakes once after the server was down for many intervals and keeps the schedule across a restart", async () => {
    const time = clock();
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime, now: time.now });
    const org = await createOrganization("재시작 heartbeat");
    await setHeartbeat(org.id, org.lead.id, {
      enabled: true,
      intervalMinutes: 10,
    });
    await t.stopServer();

    time.advance(minutes(55));
    const restarted = await startServer({
      db: t.db,
      port: 0,
      runtime: agents.runtime,
      now: time.now,
    });
    try {
      await restarted.tickHeartbeats();
      await restarted.tickHeartbeats();
      await restarted.drain();
    } finally {
      await restarted.close();
    }
    expect(reasons(agents.of(org.lead.id)).map((r) => r.kind)).toEqual([
      "heartbeat",
    ]);
    const { findAgentDetail } = await import("@babojubot/db");
    expect(
      (await findAgentDetail(t.db, org.id, org.lead.id))?.heartbeat.nextAt
    ).toBe(time.iso(minutes(10)));
  });

  it("holds heartbeats while the agent or the organization is paused and wakes once after resuming", async () => {
    const time = clock();
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime, now: time.now });
    const org = await createOrganization("일시정지 heartbeat");
    await setHeartbeat(org.id, org.lead.id, {
      enabled: true,
      intervalMinutes: 10,
    });
    const control = (path: string) =>
      t!.request("POST", `/api/organizations/${org.id}/${path}`, {});

    expect((await control(`agents/${org.lead.id}/pause`)).status).toBe(200);
    time.advance(minutes(30));
    await t.tickHeartbeats();
    await t.drain();
    expect(await runs(org.id)).toEqual([]);
    expect((await control(`agents/${org.lead.id}/resume`)).status).toBe(200);
    expect((await control("pause")).status).toBe(200);
    await t.tickHeartbeats();
    await t.drain();
    expect(await runs(org.id)).toEqual([]);

    expect((await control("resume")).status).toBe(200);
    await t.tickHeartbeats();
    await t.drain();
    expect(reasons(agents.of(org.lead.id)).map((r) => r.kind)).toEqual([
      "heartbeat",
    ]);
  });

  it("checks the input, the organization, and closed organizations", async () => {
    t = await startTestServer({ runtime: quietCreation() });
    const org = await createOrganization("설정 검사");
    const other = await createOrganization("다른 조직");
    for (const input of [
      { enabled: true, intervalMinutes: 0 },
      { enabled: true, intervalMinutes: 1.5 },
      { enabled: true },
      { enabled: true, intervalMinutes: 30, extra: 1 },
    ])
      expect(
        (
          await t.request(
            "PUT",
            `${agentPath(org.id, org.lead.id)}/heartbeat`,
            input
          )
        ).status
      ).toBe(422);
    expect(
      (
        await setHeartbeat(org.id, other.lead.id, {
          enabled: true,
          intervalMinutes: 30,
        })
      ).status
    ).toBe(404);

    // 값이 그대로인 변경은 아무것도 남기지 않는다.
    const stream = await t.subscribe({
      kind: "organization",
      organizationId: org.id,
    });
    expect(
      (
        await setHeartbeat(org.id, org.lead.id, {
          enabled: false,
          intervalMinutes: 60,
        })
      ).status
    ).toBe(200);
    await stream.expectNoEvents();
    stream.close();

    expect(
      (await t.request("POST", `/api/organizations/${org.id}/stop`, {})).status
    ).toBe(200);
    expect(
      (
        await setHeartbeat(org.id, org.lead.id, {
          enabled: true,
          intervalMinutes: 30,
        })
      ).body
    ).toEqual({ error: { code: "organization_closed" } });
  });
});
