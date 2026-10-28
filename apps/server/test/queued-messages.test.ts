import {
  agentDetailSchema,
  maxQueuedMessages,
  conversationMessageListSchema,
  conversationMessageSchema,
  organizationDetailSchema,
  runSummaryListSchema,
  type WakeReason,
} from "@babojubot/contracts";
import { leadReplyScript, type Script } from "@babojubot/runtime";
import { createGate, type Gate } from "@babojubot/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { goal, idle, scriptedAgents, serverHelpers } from "./scenarios.ts";
import { startTestServer, type TestServer } from "./support.ts";

// 줄 세운 메시지: `중단하고 보내기`가 먼저 가고 줄 세운 메시지는 그 뒤 실행 시도가 받는다, 거두기·지금 보내기 API.

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const { get, eventsOf } = serverHelpers(() => t!);

const post = (orgId: string, path: string, body: unknown = {}) =>
  t!.request("POST", `/api/organizations/${orgId}${path}`, body);
const send = async (
  orgId: string,
  body: string,
  delivery: "next_run" | "interrupt" = "next_run"
) => {
  const res = await post(orgId, "/messages", { body, delivery });
  expect(res.status).toBe(201);
  return conversationMessageSchema.parse(res.body);
};
const withdraw = (orgId: string, messageId: string) =>
  post(orgId, `/messages/${messageId}/withdraw`);
const sendNow = (orgId: string, messageId: string) =>
  post(orgId, `/messages/${messageId}/send-now`);
const edit = (orgId: string, messageId: string, body: string) =>
  post(orgId, `/messages/${messageId}/edit`, { body });
const conversation = async (orgId: string) =>
  conversationMessageListSchema.parse(
    await get(`/api/organizations/${orgId}/messages`)
  );
const runsOf = async (orgId: string) =>
  runSummaryListSchema.parse(await get(`/api/organizations/${orgId}/runs`));
const bodies = (reasons: WakeReason[]) =>
  reasons.flatMap((r) => (r.kind === "owner_message" ? [r.body] : []));

/** gate에서 멈췄다가 열리면 받은 깨우기에 답장하는 Lead 시나리오. 취소되면 gate가 reject해 그대로 끝난다. */
const holding = (gate: Gate): Script => ({
  ...leadReplyScript,
  steps: [{ do: "hold", until: gate.wait }, ...leadReplyScript.steps],
});

async function createOrganization(name: string) {
  const res = await t!.request("POST", "/api/organizations", { name, ...goal });
  expect(res.status).toBe(201);
  await t!.drain();
  const org = organizationDetailSchema.parse(res.body);
  return { ...org, lead: org.agents.find((a) => a.role === "lead")! };
}

/**
 * 실행 중에 멈춰 있는 Lead가 있는 조직. `received`는 Lead의 실행 시도가 받은 사용자 메시지를 실행 시도 순서대로 돌려준다.
 * 끝까지 간 실행 시도만 기록되므로 취소된 실행 시도는 빠진다.
 */
async function heldLead(name: string) {
  const agents = scriptedAgents({ created: idle });
  t = await startTestServer({ runtime: agents.runtime });
  const org = await createOrganization(name);
  const gate = createGate();
  agents.queue(org.lead.id, holding(gate));
  await send(org.id, "긴 일을 시작해 주세요");
  await gate.reached;
  const [running] = await runsOf(org.id);
  const received = () =>
    agents.of(org.lead.id).map((r) => bodies(r.request.wakeReasons));
  return { org, gate, running: running!, received, agents };
}

describe("interrupt order", () => {
  it("runs the interrupt message alone first and delivers the earlier queued messages in the following run", async () => {
    const { org, running, received } = await heldLead("중단 순서 조직");
    const first = await send(org.id, "줄 선 하나");
    const second = await send(org.id, "줄 선 둘");
    const interrupt = await send(org.id, "방향을 바꿔 주세요", "interrupt");

    await t!.drain();
    const [following, interruptRun, cancelled] = await runsOf(org.id);
    expect(cancelled).toMatchObject({
      id: running.id,
      status: "cancelled",
      cancelReason: "owner_interrupt",
    });
    // 취소된 실행 시도는 끝까지 가지 않아 기록에 없다.
    expect(received()).toEqual([
      ["방향을 바꿔 주세요"],
      ["줄 선 하나", "줄 선 둘"],
    ]);
    expect(interruptRun).toMatchObject({ status: "completed", wakeCount: 1 });
    expect(following).toMatchObject({ status: "completed", wakeCount: 2 });
    const delivered = Object.fromEntries(
      (await conversation(org.id)).map((m) => [m.id, m.deliveredToRunId])
    );
    expect(delivered[interrupt.id]).toBe(interruptRun!.id);
    expect(delivered[first.id]).toBe(following!.id);
    expect(delivered[second.id]).toBe(following!.id);
  });

  it("delivers an interrupt message sent while paused before the messages that queued before it on resume", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("일시정지 중 순서 조직");
    expect((await post(org.id, "/pause")).status).toBe(200);
    await send(org.id, "멈춘 동안 하나");
    await send(org.id, "멈춘 동안 둘", "interrupt");
    expect((await post(org.id, "/resume")).status).toBe(200);
    await t.drain();
    expect(
      agents.of(org.lead.id).map((r) => bodies(r.request.wakeReasons))
    ).toEqual([["멈춘 동안 둘"], ["멈춘 동안 하나"]]);
  });
});

describe("withdrawing a queued message", () => {
  it("hides it from the conversation and the Lead, records it, and leaves the other queued message for the next run", async () => {
    const { org, gate, received, agents } = await heldLead("거두기 조직");
    const kept = await send(org.id, "남길 말");
    const dropped = await send(org.id, "거둘 말");
    const stream = await t!.subscribe({
      kind: "organization",
      organizationId: org.id,
    });

    const res = await withdraw(org.id, dropped.id);
    expect(res.status).toBe(200);
    expect(conversationMessageSchema.parse(res.body)).toMatchObject({
      id: dropped.id,
      body: "거둘 말",
      deliveredToRunId: null,
    });
    expect(await stream.next()).toMatchObject({
      type: "message.withdrawn",
      payload: {
        by: "owner",
        messageId: dropped.id,
        agentId: org.lead.id,
        conversationId: dropped.conversationId,
      },
    });
    stream.close();
    expect((await conversation(org.id)).map((m) => m.body)).toEqual([
      "긴 일을 시작해 주세요",
      "남길 말",
    ]);
    expect((await withdraw(org.id, dropped.id)).status).toBe(404);

    gate.open();
    await t!.drain();
    expect(received().at(-1)).toEqual(["남길 말"]);
    expect(
      agents
        .of(org.lead.id)
        .at(-1)!
        .request.context.conversation.map((m) => m.body)
    ).not.toContain("거둘 말");
    expect(
      (await conversation(org.id)).find((m) => m.id === kept.id)
        ?.deliveredToRunId
    ).not.toBeNull();
    expect(
      (await eventsOf(org.id)).filter((e) => e.type === "message.withdrawn")
    ).toHaveLength(1);
  });

  it("answers 409 message_delivered once a run took the message, and 404 across organizations", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("전달된 메시지 조직");
    const other = await createOrganization("옆 조직");
    const delivered = await send(org.id, "이미 전달될 말");
    await t.drain();

    for (const res of [
      await withdraw(org.id, delivered.id),
      await sendNow(org.id, delivered.id),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: "message_delivered" } });
    }

    const queued = await (async () => {
      expect((await post(org.id, "/pause")).status).toBe(200);
      return send(org.id, "멈춘 동안 보낸 말");
    })();
    expect((await withdraw(other.id, queued.id)).status).toBe(404);
    expect((await sendNow(other.id, queued.id)).status).toBe(404);
    expect((await withdraw(org.id, "not-a-uuid")).status).toBe(404);
    // Lead 메시지는 줄 세운 메시지가 아니다.
    const lead = (await conversation(org.id)).find((m) => m.author === "agent");
    expect((await withdraw(org.id, lead!.id)).status).toBe(404);
    expect((await withdraw(org.id, queued.id)).status).toBe(200);
  });
});

describe("paused and finished organizations", () => {
  it("lets the owner withdraw a message held by a pause but not send it now", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("일시정지 줄 조직");
    expect((await post(org.id, "/pause")).status).toBe(200);
    const one = await send(org.id, "멈춘 동안 하나");
    const two = await send(org.id, "멈춘 동안 둘");

    const refused = await sendNow(org.id, two.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: { code: "paused" } });
    expect((await withdraw(org.id, one.id)).status).toBe(200);

    // 조직이 아니라 Lead만 일시정지여도 지금 보낼 수 없다.
    expect((await post(org.id, "/resume")).status).toBe(200);
    await t.drain();
    expect((await post(org.id, `/agents/${org.lead.id}/pause`)).status).toBe(
      200
    );
    const three = await send(org.id, "Lead가 멈춘 동안");
    expect((await sendNow(org.id, three.id)).body).toEqual({
      error: { code: "paused" },
    });

    expect((await post(org.id, `/agents/${org.lead.id}/resume`)).status).toBe(
      200
    );
    await t.drain();
    expect(
      agents.of(org.lead.id).map((r) => bodies(r.request.wakeReasons))
    ).toEqual([["멈춘 동안 둘"], ["Lead가 멈춘 동안"]]);
  });

  it("in a finished organization refuses new messages, sending now and editing, but still lets the owner withdraw", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("끝난 조직");
    expect((await post(org.id, "/pause")).status).toBe(200);
    const one = await send(org.id, "멈춘 동안 하나");
    const two = await send(org.id, "멈춘 동안 둘");
    expect((await post(org.id, "/stop")).status).toBe(200);

    const closedRefusal = { error: { code: "organization_closed" } };
    const late = await post(org.id, "/messages", { body: "끝난 뒤" });
    expect(late.status).toBe(409);
    expect(late.body).toEqual(closedRefusal);
    for (const res of [
      await sendNow(org.id, one.id),
      await edit(org.id, one.id, "끝난 뒤 고침"),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body).toEqual(closedRefusal);
    }
    expect((await withdraw(org.id, two.id)).status).toBe(200);
    expect((await conversation(org.id)).map((m) => m.body)).toEqual([
      "멈춘 동안 하나",
    ]);
  });
});

describe("editing a queued message", () => {
  it("changes the text in place while paused, keeps its delivery and position, records the previous text, and the Lead gets the new text", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("고치기 조직");
    expect((await post(org.id, "/pause")).status).toBe(200);
    await send(org.id, "하나");
    const middle = await send(org.id, "둘");
    await send(org.id, "셋");
    const stream = await t!.subscribe({
      kind: "organization",
      organizationId: org.id,
    });

    const res = await edit(org.id, middle.id, "둘 고침");
    expect(res.status).toBe(200);
    expect(conversationMessageSchema.parse(res.body)).toMatchObject({
      id: middle.id,
      body: "둘 고침",
      delivery: "next_run",
      deliveredToRunId: null,
    });
    expect(await stream.next()).toMatchObject({
      type: "message.edited",
      payload: { messageId: middle.id, previousBody: "둘", body: "둘 고침" },
    });
    stream.close();
    expect((await conversation(org.id)).map((m) => m.body)).toEqual([
      "하나",
      "둘 고침",
      "셋",
    ]);
    for (const body of [{ body: "  " }, { body: "x", extra: 1 }, {}])
      expect(
        (await post(org.id, `/messages/${middle.id}/edit`, body)).status
      ).toBe(422);

    expect((await post(org.id, "/resume")).status).toBe(200);
    await t.drain();
    expect(
      agents.of(org.lead.id).map((r) => bodies(r.request.wakeReasons))
    ).toEqual([["하나", "둘 고침", "셋"]]);
    const late = await edit(org.id, middle.id, "늦음");
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ error: { code: "message_delivered" } });
  });
});

describe("the queue cap", () => {
  it("answers 409 queue_full at the cap for any conversation and delivery, frees a slot on withdraw, and counts it on the Lead", async () => {
    const agents = scriptedAgents({ created: idle });
    t = await startTestServer({ runtime: agents.runtime });
    const org = await createOrganization("가득 찬 줄 조직");
    expect((await post(org.id, "/pause")).status).toBe(200);
    const first = await send(org.id, "줄 0");
    for (let i = 1; i < maxQueuedMessages; i++) await send(org.id, `줄 ${i}`);
    expect(
      agentDetailSchema.parse(
        await get(`/api/organizations/${org.id}/agents/${org.lead.id}`)
      ).queuedMessageCount
    ).toBe(maxQueuedMessages);

    for (const [path, body] of [
      ["/messages", { body: "하나 더" }],
      ["/messages", { body: "하나 더", delivery: "interrupt" }],
      ["/conversations", { body: "새 대화로" }],
    ] as const) {
      const refused = await post(org.id, path, body);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: { code: "queue_full" } });
    }
    expect(await conversation(org.id)).toHaveLength(maxQueuedMessages);

    expect((await withdraw(org.id, first.id)).status).toBe(200);
    await send(org.id, "자리가 났다");
    expect((await conversation(org.id)).at(-1)?.body).toBe("자리가 났다");
  });
});

describe("sending a queued message now", () => {
  it("cancels the running run, runs that message alone, and delivers the rest of the queue afterwards", async () => {
    const { org, running, received } = await heldLead("지금 보내기 조직");
    await send(org.id, "줄 선 하나");
    const now = await send(org.id, "지금 보낼 말");
    await send(org.id, "줄 선 셋");
    const stream = await t!.subscribe({
      kind: "organization",
      organizationId: org.id,
    });

    const res = await sendNow(org.id, now.id);
    expect(res.status).toBe(200);
    expect(conversationMessageSchema.parse(res.body)).toMatchObject({
      id: now.id,
      delivery: "interrupt",
    });
    expect([await stream.next(), await stream.next()]).toMatchObject([
      { type: "message.sent_now", payload: { by: "owner", messageId: now.id } },
      {
        type: "agent.interrupted",
        payload: { runId: running.id, messageId: now.id },
      },
    ]);
    stream.close();

    await t!.drain();
    expect(received()).toEqual([["지금 보낼 말"], ["줄 선 하나", "줄 선 셋"]]);
    // 대화는 Lead가 받은 순서다. 지금 보낸 메시지와 그 답장이 먼저 보낸 줄 세운 메시지보다 앞에 온다.
    expect(
      (await conversation(org.id)).map((m) =>
        m.author === "owner" ? m.body : "Lead"
      )
    ).toEqual([
      "긴 일을 시작해 주세요",
      "지금 보낼 말",
      "Lead",
      "줄 선 하나",
      "줄 선 셋",
      "Lead",
    ]);
    expect((await runsOf(org.id))[2]).toMatchObject({
      id: running.id,
      status: "cancelled",
      cancelReason: "owner_interrupt",
    });
  });
});
