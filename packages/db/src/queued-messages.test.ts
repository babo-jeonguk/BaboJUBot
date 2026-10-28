import { randomUUID } from "node:crypto";
import type {
  MessageDelivery,
  RunResult,
  WakeReason,
} from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listConversations } from "./conversations.ts";
import { insertOrganizationCreation } from "./organizations.ts";
import {
  sendQueuedMessageNow,
  withdrawQueuedMessage,
} from "./queued-messages.ts";
import {
  claimNextRun,
  finishRun,
  insertOwnerMessage,
  listConversationMessages,
  loadRunContext,
} from "./runs.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

// 줄 세운 메시지: `중단하고 보내기` 실행 시도의 깨우기 묶음, 거두기·지금 보내기와 admission의 직렬화.

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
const bodies = (reasons: WakeReason[] | undefined) =>
  (reasons ?? []).flatMap((r) => (r.kind === "owner_message" ? [r.body] : []));

async function organization() {
  const creation = planOrganizationCreation(
    { name: "조직", goal: "목표" },
    { files: [] },
    source
  );
  await insertOrganizationCreation(t.db, creation);
  const lead = creation.agents[0]!;
  const orgId = lead.organizationId;
  const conversation = creation.defaultConversation;
  const claim = () =>
    claimNextRun(t.db, lead.id, { tokenDigest: randomUUID(), source });
  const created = await claim();
  await finishRun(t.db, created!.run.id, completed, source);
  const send = async (body: string, delivery: MessageDelivery = "next_run") => {
    const plan = planOwnerMessage(
      { organizationId: orgId, agents: creation.agents },
      conversation,
      { body, delivery },
      source
    );
    const stored = await insertOwnerMessage(t.db, plan);
    expect(stored.kind).toBe("sent");
    return plan.message;
  };
  const listed = async () =>
    (await listConversationMessages(t.db, orgId, conversation.id)).map(
      (m) => m.body
    );
  return { lead, orgId, conversation, send, claim, listed };
}

describe("interrupt runs", () => {
  it("give the next run only the interrupt messages and leave queued messages for the run after it", async () => {
    const { send, claim } = await organization();
    await send("줄 선 하나");
    await send("줄 선 둘");
    await send("방향을 바꿔 주세요", "interrupt");

    const interruptRun = await claim();
    expect(bodies(interruptRun?.wakeReasons)).toEqual(["방향을 바꿔 주세요"]);
    expect(interruptRun?.event.payload).toMatchObject({
      wakeIds: [interruptRun!.wakeReasons[0]!.wakeId],
    });
    await finishRun(t.db, interruptRun!.run.id, completed, source);

    const following = await claim();
    expect(bodies(following?.wakeReasons)).toEqual(["줄 선 하나", "줄 선 둘"]);
  });

  it("send a queued message now so that it alone goes first", async () => {
    const { orgId, send, claim } = await organization();
    await send("줄 선 하나");
    const now = await send("지금 보낼 말");

    const sent = await sendQueuedMessageNow(t.db, orgId, now.id);
    expect(sent).toMatchObject({
      kind: "changed",
      message: { id: now.id, delivery: "interrupt" },
      cancellation: null,
    });
    expect(
      sent.kind === "changed" ? sent.events.map((e) => e.type) : []
    ).toEqual(["message.sent_now", "agent.interrupted"]);

    const first = await claim();
    expect(bodies(first?.wakeReasons)).toEqual(["지금 보낼 말"]);
    await finishRun(t.db, first!.run.id, completed, source);
    expect(bodies((await claim())?.wakeReasons)).toEqual(["줄 선 하나"]);
  });
});

describe("the queued message list", () => {
  it("lists every queued message after the transcript window, whatever the window size, and the oldest stays actionable", async () => {
    const { orgId, conversation, send, claim } = await organization();
    for (const body of ["받은 하나", "받은 둘", "받은 셋"]) await send(body);
    const run = await claim();
    await finishRun(t.db, run!.run.id, completed, source);
    const oldest = await send("줄 0");
    for (const body of ["줄 1", "줄 2", "줄 3"]) await send(body);
    const listed = async () =>
      (
        await listConversationMessages(t.db, orgId, conversation.id, {
          limit: 2,
        })
      ).map((m) => m.body);

    // 대화 기록은 최근 2개로 잘려도 줄 세운 메시지는 대화 기록과 따로 모두 온다.
    expect(await listed()).toEqual([
      "받은 둘",
      "받은 셋",
      "줄 0",
      "줄 1",
      "줄 2",
      "줄 3",
    ]);
    expect(
      await withdrawQueuedMessage(t.db, orgId, oldest.id, source)
    ).toMatchObject({ kind: "changed" });
    expect(await listed()).toEqual([
      "받은 둘",
      "받은 셋",
      "줄 1",
      "줄 2",
      "줄 3",
    ]);
  });
});

describe("withdrawing a queued message", () => {
  it("keeps the message but hides it from the conversation and the Lead, and its wake starts no run", async () => {
    const { orgId, send, claim, listed } = await organization();
    const kept = await send("남길 말");
    const withdrawn = await send("거둘 말");

    const result = await withdrawQueuedMessage(
      t.db,
      orgId,
      withdrawn.id,
      source
    );
    expect(result).toMatchObject({
      kind: "changed",
      message: { id: withdrawn.id, body: "거둘 말", deliveredToRunId: null },
      events: [
        {
          type: "message.withdrawn",
          payload: { by: "owner", messageId: withdrawn.id },
        },
      ],
    });
    expect(await listed()).toEqual(["남길 말"]);
    // 다시 거두거나 지금 보낼 수 없다.
    expect(
      await withdrawQueuedMessage(t.db, orgId, withdrawn.id, source)
    ).toEqual({ kind: "not_found" });
    expect(await sendQueuedMessageNow(t.db, orgId, withdrawn.id)).toEqual({
      kind: "not_found",
    });

    const run = await claim();
    expect(bodies(run?.wakeReasons)).toEqual(["남길 말"]);
    const context = await loadRunContext(t.db, run!.run.id);
    expect(context?.context.conversation.map((m) => m.body)).toEqual([
      "남길 말",
    ]);
    // 실행 시도가 받은 메시지는 거두거나 지금 보낼 수 없다.
    expect(await withdrawQueuedMessage(t.db, orgId, kept.id, source)).toEqual({
      kind: "message_delivered",
    });
    expect(await sendQueuedMessageNow(t.db, orgId, kept.id)).toEqual({
      kind: "message_delivered",
    });
  });

  it("moves the conversation's last activity back when its newest message is withdrawn", async () => {
    const { orgId, send } = await organization();
    const before = (await listConversations(t.db, orgId))[0]!.lastActivityAt;
    const message = await send("거둘 말");
    await withdrawQueuedMessage(t.db, orgId, message.id, source);
    expect((await listConversations(t.db, orgId))[0]!.lastActivityAt).toBe(
      before
    );
  });

  it("refuses other organizations' messages as not found", async () => {
    const a = await organization();
    const b = await organization();
    const message = await a.send("a의 말");
    expect(
      await withdrawQueuedMessage(t.db, b.orgId, message.id, source)
    ).toEqual({ kind: "not_found" });
    expect(await sendQueuedMessageNow(t.db, b.orgId, message.id)).toEqual({
      kind: "not_found",
    });
    expect(
      await withdrawQueuedMessage(t.db, a.orgId, "not-a-uuid", source)
    ).toEqual({ kind: "not_found" });
  });

  it("is serialized with admission: either the run takes the message or the withdrawal does, never both", async () => {
    for (let i = 0; i < 8; i++) {
      const { orgId, send, claim } = await organization();
      const message = await send("경주하는 말");
      const [run, result] = await Promise.all([
        claim(),
        withdrawQueuedMessage(t.db, orgId, message.id, source),
      ]);
      if (result.kind === "changed") expect(run).toBeUndefined();
      else {
        expect(result).toEqual({ kind: "message_delivered" });
        expect(bodies(run?.wakeReasons)).toEqual(["경주하는 말"]);
      }
    }
  });
});
