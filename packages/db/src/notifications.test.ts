import { randomUUID } from "node:crypto";
import type { NewEvent } from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimNotifications,
  listFakeChannelMessages,
  listOutbox,
  recordFakeChannelMessage,
  settleNotification,
} from "./notifications.ts";
import { insertOrganizationCreation } from "./organizations.ts";
import {
  claimNextRun,
  insertAgentMessage,
  insertOwnerMessage,
} from "./runs.ts";
import { insertEvent } from "./rows.ts";
import { events, notificationOutbox } from "./schema.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.close();
});

const source = { newId: randomUUID, now: () => new Date() };
const lease = 30_000;

/** 조직 하나와, 그 Lead가 실행 시도 안에서 대화 메시지를 보내는 함수. */
async function organization() {
  const creation = planOrganizationCreation(
    { name: "알림 조직" },
    { files: [] },
    source
  );
  await insertOrganizationCreation(t.db, creation);
  const lead = creation.agents[0]!;
  await insertOwnerMessage(
    t.db,
    planOwnerMessage(
      { organizationId: lead.organizationId, agents: creation.agents },
      { body: "시작", delivery: "next_run" },
      source
    )
  );
  const claimed = await claimNextRun(t.db, lead.id, {
    tokenDigest: randomUUID(),
    source,
  });
  const run = {
    id: claimed!.run.id,
    organizationId: lead.organizationId,
    agentId: lead.id,
    agentRole: "lead" as const,
  };
  const leadMessage = async (body: string) => {
    const written = await insertAgentMessage(t.db, run, body, {
      activity: {
        source: "control_plane",
        activity: { type: "org_tool", tool: "send_message", summary: body },
      },
      source,
    });
    if (written.kind !== "ok") throw new Error(written.kind);
    const [event] = written.events;
    return { messageId: written.value.id, event: event! };
  };
  return { organizationId: lead.organizationId, lead, creation, leadMessage };
}

const outboxOf = async (organizationId: string) =>
  (await listOutbox(t.db)).filter((e) => e.organizationId === organizationId);

/** 다른 테스트의 항목은 먼저 보낸 것으로 정리해 이 테스트의 claim만 남긴다. */
async function settleEverything() {
  for (;;) {
    const claimed = await claimNotifications(t.db, {
      now: new Date(Date.now() + 3_600_000),
      leaseMs: lease,
      limit: 100,
    });
    if (!claimed.length) return;
    for (const c of claimed)
      await settleNotification(t.db, c, { kind: "sent" }, new Date());
  }
}

describe("notification outbox", () => {
  it("stores the delivery intent with the Event in the same transaction, once per Event", async () => {
    const org = await organization();
    const { messageId, event } = await org.leadMessage("보고합니다");
    // Event를 남긴 transaction이 되돌려지면 전송 의도도 남지 않는다.
    await expect(
      t.db.transaction(async (tx) => {
        const { id: _id, createdAt: _createdAt, ...again } = event;
        await insertEvent(tx, again as NewEvent);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");

    expect(await outboxOf(org.organizationId)).toEqual([
      expect.objectContaining({
        kind: "lead_message",
        sourceId: messageId,
        eventId: event.id,
        delivery: {
          status: "pending",
          attempts: 0,
          nextAttemptAt: null,
          sentAt: null,
          lastError: null,
        },
      }),
    ]);
    await expect(
      t.db.insert(notificationOutbox).values({
        organizationId: org.organizationId,
        eventId: event.id,
        kind: "lead_message",
        sourceId: messageId,
      })
    ).rejects.toThrow();
  });

  it("does not queue owner messages", async () => {
    const org = await organization();
    const plan = planOwnerMessage(
      {
        organizationId: org.organizationId,
        agents: org.creation.agents,
      },
      { body: "안녕", delivery: "next_run" },
      source
    );
    await insertOwnerMessage(t.db, plan);
    expect(await outboxOf(org.organizationId)).toEqual([]);
  });

  it("refuses an outbox entry whose Event belongs to another organization", async () => {
    const a = await organization();
    const b = await organization();
    const { messageId } = await a.leadMessage("A의 보고");
    const [created] = await t.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.organizationId, a.organizationId),
          eq(events.type, "organization.created")
        )
      );
    await expect(
      t.db.insert(notificationOutbox).values({
        organizationId: b.organizationId,
        eventId: created!.id,
        kind: "lead_message",
        sourceId: messageId,
      })
    ).rejects.toThrow();
  });

  it("claims each due entry once, assembles the content, and settles only with the current claim", async () => {
    await settleEverything();
    const org = await organization();
    const { messageId } = await org.leadMessage("실험 결과를 보고합니다");
    const now = new Date();

    const [first, second] = await Promise.all([
      claimNotifications(t.db, { now, leaseMs: lease, limit: 10 }),
      claimNotifications(t.db, { now, leaseMs: lease, limit: 10 }),
    ]);
    const claims = [...first!, ...second!];
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.notification).toEqual({
      id: claim.id,
      organizationId: org.organizationId,
      organizationName: "알림 조직",
      kind: "lead_message",
      sourceId: messageId,
      title: "Research Lead 메시지",
      body: "실험 결과를 보고합니다",
      link: `/orgs/${org.organizationId}/chat`,
      createdAt: expect.any(String),
    });
    expect(claim.attempts).toBe(1);

    // claim이 살아 있는 동안은 다시 가져가지 않는다.
    expect(
      await claimNotifications(t.db, { now, leaseMs: lease, limit: 10 })
    ).toEqual([]);

    // 만료 뒤 다른 전송이 다시 가져가면, 처음 claim의 늦은 정산은 아무것도 바꾸지 않는다.
    const later = new Date(now.getTime() + lease + 1);
    const [retaken] = await claimNotifications(t.db, {
      now: later,
      leaseMs: lease,
      limit: 10,
    });
    expect(retaken!.id).toBe(claim.id);
    expect(retaken!.attempts).toBe(2);
    expect(await settleNotification(t.db, claim, { kind: "sent" }, later)).toBe(
      false
    );
    expect(
      await settleNotification(
        t.db,
        claim,
        { kind: "failed", error: "늦은 실패" },
        later
      )
    ).toBe(false);
    expect((await outboxOf(org.organizationId))[0]!.delivery).toMatchObject({
      status: "pending",
      attempts: 2,
      lastError: null,
    });

    expect(
      await settleNotification(t.db, retaken!, { kind: "sent" }, later)
    ).toBe(true);
    expect((await outboxOf(org.organizationId))[0]!.delivery).toMatchObject({
      status: "sent",
      sentAt: later.toISOString(),
    });
    // 보낸 항목은 다시 가져가지 않고, 같은 claim의 두 번째 정산도 무시한다.
    expect(
      await claimNotifications(t.db, {
        now: new Date(later.getTime() + 10 * lease),
        leaseMs: lease,
        limit: 10,
      })
    ).toEqual([]);
    expect(
      await settleNotification(t.db, retaken!, { kind: "sent" }, later)
    ).toBe(false);
  });

  it("waits out the retry delay after a failed delivery", async () => {
    await settleEverything();
    const org = await organization();
    await org.leadMessage("재시도할 보고");
    const now = new Date();
    const [claim] = await claimNotifications(t.db, {
      now,
      leaseMs: lease,
      limit: 10,
    });
    expect(
      await settleNotification(
        t.db,
        claim!,
        { kind: "failed", error: "채널 꺼짐" },
        now
      )
    ).toBe(true);
    expect((await outboxOf(org.organizationId))[0]!.delivery).toEqual({
      status: "pending",
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + 1_000).toISOString(),
      sentAt: null,
      lastError: "채널 꺼짐",
    });
    expect(
      await claimNotifications(t.db, {
        now: new Date(now.getTime() + 999),
        leaseMs: lease,
        limit: 10,
      })
    ).toEqual([]);
    const [again] = await claimNotifications(t.db, {
      now: new Date(now.getTime() + 1_000),
      leaseMs: lease,
      limit: 10,
    });
    expect(again!.id).toBe(claim!.id);
    expect(again!.attempts).toBe(2);
  });
});

describe("notification content", () => {
  it("settles an entry whose content cannot be built as a failed attempt and still hands out the others", async () => {
    await settleEverything();
    const org = await organization();
    const [created] = await t.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.organizationId, org.organizationId),
          eq(events.type, "organization.created")
        )
      );
    // 원본이 없는 항목(가리키는 메시지가 없다)을 먼저, 정상 항목을 뒤에 둔다.
    const [broken] = await t.db
      .insert(notificationOutbox)
      .values({
        organizationId: org.organizationId,
        eventId: created!.id,
        kind: "lead_message",
        sourceId: randomUUID(),
      })
      .returning();
    const { messageId } = await org.leadMessage("정상 보고");
    const now = new Date();

    const claimed = await claimNotifications(t.db, {
      now,
      leaseMs: lease,
      limit: 10,
    });
    expect(claimed.map((c) => c.notification.sourceId)).toEqual([messageId]);
    const entry = (await outboxOf(org.organizationId)).find(
      (e) => e.id === broken!.id
    )!;
    // 채널에 넘기지 못했어도 전송 시도 하나로 센다(contracts `attempts`).
    expect(entry.delivery).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + 1_000).toISOString(),
      lastError: expect.stringContaining("원본"),
    });
    for (const c of claimed)
      await settleNotification(t.db, c, { kind: "sent" }, now);
    await t.db
      .update(notificationOutbox)
      .set({ sentAt: now })
      .where(eq(notificationOutbox.id, broken!.id));
  });
});

describe("fake channel record", () => {
  it("keeps one record per notification even when the same notification arrives twice", async () => {
    await settleEverything();
    const org = await organization();
    await org.leadMessage("두 번 보낼 보고");
    const [claim] = await claimNotifications(t.db, {
      now: new Date(),
      leaseMs: lease,
      limit: 10,
    });
    await recordFakeChannelMessage(t.db, claim!.notification);
    await recordFakeChannelMessage(t.db, claim!.notification);
    const records = (await listFakeChannelMessages(t.db)).filter(
      (m) => m.organizationId === org.organizationId
    );
    expect(records).toEqual([
      {
        id: expect.any(String),
        notificationId: claim!.id,
        organizationId: org.organizationId,
        organizationName: "알림 조직",
        kind: "lead_message",
        sourceId: claim!.notification.sourceId,
        title: "Research Lead 메시지",
        body: "두 번 보낼 보고",
        link: `/orgs/${org.organizationId}/chat`,
        deliveredAt: expect.any(String),
      },
    ]);
    // 정산 전이라 전송 기록이 있어도 outbox는 아직 보내지 않은 상태다.
    const [entry] = await outboxOf(org.organizationId);
    expect(entry!.delivery.status).toBe("pending");
    await t.db
      .update(notificationOutbox)
      .set({ claimToken: null, claimExpiresAt: null })
      .where(eq(notificationOutbox.id, claim!.id));
  });
});
