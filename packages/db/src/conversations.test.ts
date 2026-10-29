import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findConversation,
  listConversations,
  markConversationRead,
} from "./conversations.ts";
import { insertOrganizationCreation } from "./organizations.ts";
import { sendQueuedMessageNow } from "./queued-messages.ts";
import {
  claimNextRun,
  finishRun,
  insertAgentMessage,
  insertOwnerMessage,
  interruptRun,
  listConversationMessages,
  listConversationPage,
  listQueuedMessages,
  loadRunContext,
} from "./runs.ts";
import { conversations, organizations, wakes } from "./schema.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

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
  summary: null,
  usage: null,
  nextSession: null,
};

async function organization() {
  const creation = planOrganizationCreation(
    { name: "대화 조직", goal: "목표" },
    { files: [] },
    source
  );
  await insertOrganizationCreation(t.db, creation);
  const lead = creation.agents[0]!;
  // 생성 깨우기는 첫 실행 시도가 받는다. 아래 검사는 그 실행 시도가 끝난 뒤의 대기열에서 시작한다.
  const created = await claimNextRun(t.db, lead.id, {
    tokenDigest: randomUUID(),
    source,
  });
  await finishRun(t.db, created!.run.id, completed, source);
  const organizationId = lead.organizationId;
  const defaultConversation = creation.defaultConversation;
  /** 사용자 메시지. `new`면 새 대화를 시작한다. */
  const send = async (
    conversation: { id: string } | "new",
    body: string,
    delivery: "next_run" | "interrupt" = "next_run"
  ) => {
    const plan = planOwnerMessage(
      { organizationId, agents: creation.agents },
      conversation,
      { body, delivery },
      source
    );
    return { plan, stored: await insertOwnerMessage(t.db, plan) };
  };
  /** Lead의 다음 실행 시도를 시작하고 그 실행 시도로 답장하는 함수를 돌려준다. */
  const claim = async () => {
    const claimed = await claimNextRun(t.db, lead.id, {
      tokenDigest: randomUUID(),
      source,
    });
    const run = {
      id: claimed!.run.id,
      organizationId,
      agentId: lead.id,
      agentRole: "lead" as const,
    };
    const reply = (body: string, conversationId?: string) =>
      insertAgentMessage(
        t.db,
        run,
        { body, ...(conversationId ? { conversationId } : {}) },
        {
          activity: {
            source: "control_plane",
            activity: { type: "org_tool", tool: "send_message", summary: body },
          },
          source,
        }
      );
    const finish = () => finishRun(t.db, run.id, completed, source);
    return { run, claimed: claimed!, reply, finish };
  };
  return {
    creation,
    lead,
    organizationId,
    defaultConversation,
    send,
    claim,
  };
}

describe("Lead conversations", () => {
  it("stores a new conversation only together with its first owner message", async () => {
    const org = await organization();
    const { plan, stored } = await org.send("new", "데이터셋 후보를 찾아 줘");
    expect(stored.kind).toBe("ok");
    expect(
      await findConversation(t.db, org.organizationId, plan.conversation!.id)
    ).toEqual(plan.conversation);
    expect(
      (
        await listConversationMessages(
          t.db,
          org.organizationId,
          plan.conversation!.id
        )
      ).map((m) => m.body)
    ).toEqual(["데이터셋 후보를 찾아 줘"]);

    // 끝난 조직은 사용자 메시지를 받지 않으므로 새 대화도 남지 않는다.
    await t.db
      .update(organizations)
      .set({ stage: "stopped" })
      .where(eq(organizations.id, org.organizationId));
    const refused = await org.send("new", "멈춰", "interrupt");
    expect(refused.stored).toEqual({
      kind: "refused",
      reason: "organization_closed",
    });
    expect(
      await findConversation(
        t.db,
        org.organizationId,
        refused.plan.conversation!.id
      )
    ).toBeUndefined();
    // 줄 세우기도 같다.
    expect((await org.send("new", "나중에 읽어 줘")).stored).toEqual({
      kind: "refused",
      reason: "organization_closed",
    });
  });

  it("routes the Lead's reply to the conversation the owner messages came from, and other replies to the default conversation", async () => {
    const org = await organization();
    const other = await organization();
    const started = (await org.send("new", "새 주제")).plan.conversation!;

    // 사용자 메시지 하나로 깨어난 실행 시도: 고르지 않아도 그 대화로 간다.
    const first = await org.claim();
    expect(first.claimed.wakeReasons).toEqual([
      expect.objectContaining({
        kind: "owner_message",
        conversationId: started.id,
      }),
    ]);
    const context = await loadRunContext(t.db, first.run.id);
    expect(context?.context.conversations.map((c) => c.id)).toEqual([
      org.defaultConversation.id,
      started.id,
    ]);
    const reply = await first.reply("새 주제에 답합니다");
    expect(reply).toMatchObject({
      kind: "ok",
      value: { conversationId: started.id },
      after: {
        events: [
          expect.objectContaining({
            type: "message.created",
            payload: expect.objectContaining({ conversationId: started.id }),
          }),
          expect.anything(),
        ],
      },
    });
    // 다른 조직의 대화로는 보낼 수 없다.
    expect(
      await first.reply("새어 나가면 안 됨", other.defaultConversation.id)
    ).toEqual({ kind: "invalid", problem: "not_found" });
    await first.finish();

    // 두 대화의 메시지를 받은 실행 시도는 대화를 골라야 하고, 고른 대화마다 답장할 수 있다.
    await org.send(org.defaultConversation, "기본 대화에서");
    await org.send(started, "새 주제에서");
    const second = await org.claim();
    expect(await second.reply("어디로?")).toEqual({
      kind: "invalid",
      problem: "conversation_required",
    });
    expect(
      await second.reply("기본 대화 답", org.defaultConversation.id)
    ).toMatchObject({
      kind: "ok",
      value: { conversationId: org.defaultConversation.id },
    });
    expect(await second.reply("새 주제 답", started.id)).toMatchObject({
      kind: "ok",
      value: { conversationId: started.id },
    });
    await second.finish();

    // 사용자 메시지 없이 깨어난 실행 시도(heartbeat 등)의 메시지는 기본 대화로 간다.
    await t.db.insert(wakes).values({
      id: randomUUID(),
      organizationId: org.organizationId,
      agentId: org.lead.id,
      kind: "heartbeat",
      createdAt: new Date(),
    });
    const third = await org.claim();
    expect(await third.reply("스스로 알립니다")).toMatchObject({
      kind: "ok",
      value: { conversationId: org.defaultConversation.id },
    });
    await third.finish();

    const bodies = async (conversationId: string) =>
      (
        await listConversationMessages(t.db, org.organizationId, conversationId)
      ).map((m) => `${m.author}:${m.body}`);
    expect(await bodies(org.defaultConversation.id)).toEqual([
      "owner:기본 대화에서",
      "agent:기본 대화 답",
      "agent:스스로 알립니다",
    ]);
    expect(await bodies(started.id)).toEqual([
      "owner:새 주제",
      "agent:새 주제에 답합니다",
      "owner:새 주제에서",
      "agent:새 주제 답",
    ]);
    // 다른 조직의 대화 ID로는 아무것도 보이지 않는다.
    expect(
      await listConversationMessages(t.db, other.organizationId, started.id)
    ).toEqual([]);
  });

  it("lists the default conversation first, then by last activity, and marks the Lead's replies unread until the owner has seen them", async () => {
    const org = await organization();
    const older = (await org.send("new", "먼저 시작")).plan.conversation!;
    const newer = (await org.send("new", "나중 시작")).plan.conversation!;
    const run = await org.claim();
    const answered = await run.reply("먼저 시작한 대화에 답", older.id);
    await run.reply("나중 대화에도 답", newer.id);
    await run.finish();
    // 먼저 시작한 대화에 사용자가 다시 말해 그 대화가 가장 최근이 된다.
    await org.send(older, "다시 질문");

    const list = await listConversations(t.db, org.organizationId);
    expect(list.map((c) => [c.title, c.isDefault, c.unread])).toEqual([
      ["기본 대화", true, false],
      ["먼저 시작", false, true],
      ["나중 시작", false, true],
    ]);

    if (answered.kind !== "ok") throw new Error(answered.kind);
    expect(
      await markConversationRead(
        t.db,
        org.organizationId,
        older.id,
        answered.value.id
      )
    ).toBe("ok");
    // 본 위치는 앞으로만 가고, 다른 대화의 메시지나 다른 조직으로는 바꿀 수 없다.
    expect(
      await markConversationRead(
        t.db,
        org.organizationId,
        newer.id,
        answered.value.id
      )
    ).toBe("not_found");
    const other = await organization();
    expect(
      await markConversationRead(
        t.db,
        other.organizationId,
        older.id,
        answered.value.id
      )
    ).toBe("not_found");
    expect(
      (await listConversations(t.db, org.organizationId)).map((c) => c.unread)
    ).toEqual([false, false, true]);
  });
});

/**
 * `tag` 직전까지만 적용한 DB를 같은 cluster에 따로 만들어 `fn`에 넘긴다. `fn`은 옛 모양의 행을 넣고 `migrateAll`로 끝까지 올린다.
 */
async function withDatabaseBefore(
  tag: string,
  fn: (pool: pg.Pool, migrateAll: () => Promise<void>) => Promise<void>
) {
  const migrations = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../migrations"
  );
  const before = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-mig-"));
  await fsp.cp(migrations, before, { recursive: true });
  const journalPath = path.join(before, "meta/_journal.json");
  const journal = JSON.parse(await fsp.readFile(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const index = journal.entries.findIndex((e) => e.tag === tag);
  journal.entries = journal.entries.slice(0, index);
  await fsp.writeFile(journalPath, JSON.stringify(journal));

  const name = `backfill_${randomUUID().replaceAll("-", "")}`;
  await t.db.execute(sql.raw(`create database ${name}`));
  const url = new URL(t.url);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: before });
    await fn(pool, () => migrate(db, { migrationsFolder: migrations }));
  } finally {
    await pool.end();
    await t.db.execute(sql.raw(`drop database ${name}`));
    await fsp.rm(before, { recursive: true, force: true });
  }
}

describe("migration 0014_lead_conversations", () => {
  it("gives every existing organization a default conversation holding its earlier messages", async () => {
    await withDatabaseBefore(
      "0014_lead_conversations",
      async (pool, migrateAll) => {
        const orgA = randomUUID();
        const orgB = randomUUID();
        const leadA = randomUUID();
        const leadB = randomUUID();
        const messageA = randomUUID();
        await pool.query(
          `insert into organizations (id, name, stage, created_at) values
          ($1, 'A', 'goal_setting', now()), ($2, 'B', 'goal_setting', now())`,
          [orgA, orgB]
        );
        await pool.query(
          `insert into agents (id, organization_id, role, name, created_at) values
          ($1, $2, 'lead', 'Research Lead', now()), ($3, $4, 'lead', 'Research Lead', now())`,
          [leadA, orgA, leadB, orgB]
        );
        await pool.query(
          `insert into messages (id, organization_id, agent_id, author, body, delivery, created_at)
          values ($1, $2, $3, 'owner', '예전 메시지', 'next_run', now())`,
          [messageA, orgA, leadA]
        );
        await pool.query(
          `insert into events (organization_id, type, payload) values
          ($1, 'message.created', $2)`,
          [
            orgA,
            JSON.stringify({
              messageId: messageA,
              agentId: leadA,
              author: "owner",
              runId: null,
            }),
          ]
        );

        await migrateAll();

        const { rows: created } = await pool.query<{
          id: string;
          organization_id: string;
          title: string;
          is_default: boolean;
          read_message_seq: string | null;
        }>(
          `select id, organization_id, title, is_default, read_message_seq from conversations order by title, organization_id`
        );
        expect(created).toHaveLength(2);
        expect(
          created.every((c) => c.is_default && c.title === "기본 대화")
        ).toBe(true);
        const defaultA = created.find((c) => c.organization_id === orgA)!;
        const defaultB = created.find((c) => c.organization_id === orgB)!;
        // 예전 메시지는 이미 본 것으로 두고, 메시지가 없던 조직은 본 위치가 없다.
        expect(defaultA.read_message_seq).not.toBeNull();
        expect(defaultB.read_message_seq).toBeNull();
        const { rows: moved } = await pool.query(
          `select conversation_id from messages where id = $1`,
          [messageA]
        );
        expect(moved).toEqual([{ conversation_id: defaultA.id }]);
        const { rows: events } = await pool.query(
          `select payload from events where organization_id = $1 and type = 'message.created'`,
          [orgA]
        );
        expect(events[0].payload).toMatchObject({
          messageId: messageA,
          conversationId: defaultA.id,
        });
        // 옮긴 뒤에는 대화 없는 메시지를 남길 수 없다.
        await expect(
          pool.query(
            `insert into messages (id, organization_id, agent_id, author, body, delivery, created_at)
            values ($1, $2, $3, 'owner', 'x', 'next_run', now())`,
            [randomUUID(), orgB, leadB]
          )
        ).rejects.toThrow();
      }
    );
  });
});

// 대화는 Lead가 받은 순서다. 먼저 보냈어도 나중에 받은 사용자 메시지는 그사이 받은 메시지와 Lead 답장 뒤에 온다.
describe("delivery order", () => {
  /** 실행 중인 Lead에게 `H`를 주고 `L0`로 답한 상태에서 A·B·C를 줄 세운다. */
  async function queuedWhileRunning() {
    const org = await organization();
    const transcript = async () =>
      (
        await listConversationMessages(
          t.db,
          org.organizationId,
          org.defaultConversation.id
        )
      ).map((m) => m.body);
    const { stored } = await org.send(org.defaultConversation, "H");
    const run0 = await org.claim();
    await run0.reply("L0");
    const ids: Record<string, string> = {};
    for (const body of ["A", "B", "C"]) {
      const { plan } = await org.send(org.defaultConversation, body);
      ids[body] = plan.message.id;
    }
    expect(stored.kind).toBe("ok");
    return { org, run0, ids, transcript };
  }

  it("shows a message sent now where the Lead received it, before the earlier queued messages, and the Lead context agrees", async () => {
    const { org, run0, ids, transcript } = await queuedWhileRunning();
    // 받기 전에는 보낸 순서로 맨 뒤에 있다(줄 세운 메시지).
    expect(await transcript()).toEqual(["H", "L0", "A", "B", "C"]);

    const sent = await sendQueuedMessageNow(t.db, org.organizationId, ids.B!);
    expect(sent.kind).toBe("ok");
    expect(await transcript()).toEqual(["H", "L0", "A", "B", "C"]);
    await run0.finish();
    const run1 = await org.claim();
    expect(await transcript()).toEqual(["H", "L0", "B", "A", "C"]);
    await run1.reply("L1");
    await run1.finish();
    const run2 = await org.claim();
    await run2.reply("L2");
    expect(await transcript()).toEqual(["H", "L0", "B", "L1", "A", "C", "L2"]);
    expect(
      (await loadRunContext(t.db, run2.run.id))!.context.conversation.map(
        (m) => m.body
      )
    ).toEqual(["H", "L0", "B", "L1", "A", "C", "L2"]);
    // 이전 실행 시도의 맥락에는 그때까지 받은 메시지만 있다.
    expect(
      (await loadRunContext(t.db, run1.run.id))!.context.conversation.map(
        (m) => m.body
      )
    ).toEqual(["H", "L0", "B", "L1"]);
  });

  it("keeps send order within one run and puts an interrupt message first when it arrives after queued ones", async () => {
    const org = await organization();
    const list = async () =>
      (
        await listConversationMessages(
          t.db,
          org.organizationId,
          org.defaultConversation.id
        )
      ).map((m) => m.body);
    await org.send(org.defaultConversation, "H");
    const run0 = await org.claim();
    await org.send(org.defaultConversation, "A");
    await org.send(org.defaultConversation, "B");
    await run0.finish();
    const run1 = await org.claim();
    await run1.reply("L1");
    expect(await list()).toEqual(["H", "A", "B", "L1"]);

    await org.send(org.defaultConversation, "C");
    await org.send(org.defaultConversation, "I", "interrupt");
    await run1.finish();
    await (await org.claim()).finish();
    await org.claim();
    expect(await list()).toEqual(["H", "A", "B", "L1", "I", "C"]);
  });

  it("marks the Lead reply read when the owner has seen a later-received message that was sent before it", async () => {
    const { org, run0, ids } = await queuedWhileRunning();
    await sendQueuedMessageNow(t.db, org.organizationId, ids.B!);
    await run0.finish();
    const run1 = await org.claim();
    await run1.reply("L1");
    await run1.finish();
    await org.claim();
    // C는 L1보다 먼저 저장됐지만 L1 뒤에 받았다. C까지 보았으면 L1도 보았다.
    expect(
      await markConversationRead(
        t.db,
        org.organizationId,
        org.defaultConversation.id,
        ids.C!
      )
    ).toBe("ok");
    expect(
      (await listConversations(t.db, org.organizationId)).map((c) => c.unread)
    ).toEqual([false]);
  });

  it("puts a message back in the queue when a server restart requeues it, and places it where the next run takes it", async () => {
    const org = await organization();
    const list = async () =>
      (
        await listConversationMessages(
          t.db,
          org.organizationId,
          org.defaultConversation.id
        )
      ).map((m) => [m.body, m.deliveredToRunId !== null]);
    // Lead 메시지는 받는 실행 시도가 없다(`false`). A가 줄 세운 메시지로 돌아가도 L0 뒤 맨 끝이다.
    await org.send(org.defaultConversation, "A");
    const run0 = await org.claim();
    await run0.reply("L0");
    await interruptRun(t.db, run0.run.id, source);
    expect(await list()).toEqual([
      ["L0", false],
      ["A", false],
    ]);
    const [{ delivered_seq }] = (
      await t.db.execute<{ delivered_seq: string | null }>(
        sql`select delivered_seq from messages where body = 'A' and organization_id = ${org.organizationId}`
      )
    ).rows as [{ delivered_seq: string | null }];
    expect(delivered_seq).toBeNull();
    await org.claim();
    expect(await list()).toEqual([
      ["L0", false],
      ["A", true],
    ]);
  });
});

// 사용자 메시지의 받은 시각은 그 메시지를 받은 실행 시도가 시작한 시각이다(보낸 시각과 따로).
describe("delivery time", () => {
  /** 대화 기록과 줄 세운 메시지에서 본문으로 찾은 메시지의 [보낸 시각, 받은 시각]. */
  const times = async (
    org: Awaited<ReturnType<typeof organization>>,
    body: string
  ) => {
    const found = (
      await listConversationMessages(
        t.db,
        org.organizationId,
        org.defaultConversation.id
      )
    ).find((m) => m.body === body)!;
    return { createdAt: found.createdAt, deliveredAt: found.deliveredAt };
  };
  /** 보낸 시각을 한 시간 앞으로 옮겨 받은 시각과 겹치지 않게 한다. */
  const sentAnHourAgo = (messageId: string) =>
    t.db.execute(
      sql`update messages set created_at = created_at - interval '1 hour' where id = ${messageId}`
    );

  it("stamps a message queued while the Lead runs with the start of the later run that takes it", async () => {
    const org = await organization();
    await org.send(org.defaultConversation, "H");
    const run0 = await org.claim();
    expect((await times(org, "H")).deliveredAt).toBe(
      run0.claimed.run.startedAt
    );
    const { plan } = await org.send(org.defaultConversation, "A");
    await sentAnHourAgo(plan.message.id);
    expect((await times(org, "A")).deliveredAt).toBeNull();

    await run0.finish();
    const run1 = await org.claim();
    const a = await times(org, "A");
    expect(a.deliveredAt).toBe(run1.claimed.run.startedAt);
    expect(Date.parse(a.deliveredAt!)).toBeGreaterThan(Date.parse(a.createdAt));
    expect(
      (await loadRunContext(t.db, run1.run.id))!.context.conversation.find(
        (m) => m.body === "A"
      )?.deliveredAt
    ).toBe(run1.claimed.run.startedAt);
  });

  it("stamps a queued message sent now with the start of the run after the interruption", async () => {
    const org = await organization();
    await org.send(org.defaultConversation, "H");
    const run0 = await org.claim();
    const { plan } = await org.send(org.defaultConversation, "B");
    await sentAnHourAgo(plan.message.id);
    await sendQueuedMessageNow(t.db, org.organizationId, plan.message.id);
    await run0.finish();
    const run1 = await org.claim();
    expect((await times(org, "B")).deliveredAt).toBe(
      run1.claimed.run.startedAt
    );
  });

  it("clears the delivery time when a server restart requeues the message and stamps it again on the next run", async () => {
    const org = await organization();
    await org.send(org.defaultConversation, "A");
    const run0 = await org.claim();
    await interruptRun(t.db, run0.run.id, source);
    expect((await times(org, "A")).deliveredAt).toBeNull();
    const run1 = await org.claim();
    expect((await times(org, "A")).deliveredAt).toBe(
      run1.claimed.run.startedAt
    );
  });

  it("refuses a delivery position without a delivery time and the other way round", async () => {
    const org = await organization();
    await org.send(org.defaultConversation, "A");
    await org.claim();
    await expect(
      t.db.execute(
        sql`update messages set delivered_at = null where body = 'A' and organization_id = ${org.organizationId}`
      )
    ).rejects.toThrow();
    await expect(
      t.db.execute(
        sql`update messages set delivered_seq = null where body = 'A' and organization_id = ${org.organizationId}`
      )
    ).rejects.toThrow();
  });
});

// 대화 기록은 받은 순서 열쇠로 자르는 쪽(keyset)으로 읽는다. 줄 세운 메시지는 쪽과 따로다.
describe("transcript pages", () => {
  it("pages back through ties in delivery order, ends with hasMore false, and keeps older pages stable as new messages arrive", async () => {
    const org = await organization();
    const page = async (cursor: { before?: string; after?: string } = {}) => {
      const result = await listConversationPage(
        t.db,
        org.organizationId,
        org.defaultConversation.id,
        { ...cursor, limit: 3 }
      );
      if (result === "invalid_cursor") throw new Error(result);
      return { ...result, bodies: result.messages.map((m) => m.body) };
    };
    // 한 실행 시도가 받은 일곱 메시지는 위치가 같다. 같은 위치 안은 보낸 순서다.
    for (let i = 1; i <= 7; i++)
      await org.send(org.defaultConversation, `m${i}`);
    const run = await org.claim();
    await run.reply("L1");
    await run.reply("L2");
    await org.send(org.defaultConversation, "줄 선 말");

    const latest = await page();
    expect(latest).toMatchObject({ bodies: ["m7", "L1", "L2"], hasMore: true });
    const middle = await page({ before: latest.before! });
    expect(middle).toMatchObject({ bodies: ["m4", "m5", "m6"], hasMore: true });
    const oldest = await page({ before: middle.before! });
    expect(oldest).toMatchObject({
      bodies: ["m1", "m2", "m3"],
      hasMore: false,
      before: null,
    });

    // 새 메시지가 와도 이미 받은 커서의 쪽은 그대로이고, `after`로 새 것만 이어 받는다.
    await run.finish();
    const next = await org.claim();
    await next.reply("L3");
    expect((await page({ before: latest.before! })).bodies).toEqual([
      "m4",
      "m5",
      "m6",
    ]);
    const newer = await page({ after: latest.after! });
    expect(newer).toMatchObject({
      bodies: ["줄 선 말", "L3"],
      hasMore: false,
    });
    // `after` 쪽도 그보다 오래된 쪽의 커서를 준다(화면이 오래된 쪽을 덜어 낸 뒤 다시 받는다).
    expect((await page({ before: newer.before! })).bodies).toEqual([
      "m7",
      "L1",
      "L2",
    ]);
    expect(await page({ after: newer.after! })).toMatchObject({
      bodies: [],
      hasMore: false,
      before: null,
      after: newer.after,
    });
    for (const cursor of ["nope", Buffer.from("1.2").toString("base64url")])
      expect(
        await listConversationPage(
          t.db,
          org.organizationId,
          org.defaultConversation.id,
          { before: cursor }
        )
      ).toBe("invalid_cursor");
  });

  it("keeps queued messages out of the transcript pages and lists them apart", async () => {
    const org = await organization();
    await org.send(org.defaultConversation, "받은 말");
    await org.claim();
    await org.send(org.defaultConversation, "줄 선 말");
    const result = await listConversationPage(
      t.db,
      org.organizationId,
      org.defaultConversation.id
    );
    expect(
      result !== "invalid_cursor" && result.messages.map((m) => m.body)
    ).toEqual(["받은 말"]);
    expect(
      (
        await listQueuedMessages(
          t.db,
          org.organizationId,
          org.defaultConversation.id
        )
      ).map((m) => m.body)
    ).toEqual(["줄 선 말"]);
  });
});

describe("migration 0018_delivered_message_order", () => {
  it("places messages delivered before the migration where their run took them", async () => {
    // 지금 코드로 만든 기록에서 위치를 지우고 migration의 backfill 문만 다시 돌린다.
    const { org, run0, ids, transcript } = await (async () => {
      const org = await organization();
      const transcript = async () =>
        (
          await listConversationMessages(
            t.db,
            org.organizationId,
            org.defaultConversation.id
          )
        ).map((m) => m.body);
      await org.send(org.defaultConversation, "H");
      const run0 = await org.claim();
      await run0.reply("L0");
      const ids: Record<string, string> = {};
      for (const body of ["A", "B", "C"]) {
        const { plan } = await org.send(org.defaultConversation, body);
        ids[body] = plan.message.id;
      }
      return { org, run0, ids, transcript };
    })();
    await sendQueuedMessageNow(t.db, org.organizationId, ids.B!);
    await run0.finish();
    const run1 = await org.claim();
    await run1.reply("L1");
    await run1.finish();
    const run2 = await org.claim();
    await run2.reply("L2");
    const expected = ["H", "L0", "B", "L1", "A", "C", "L2"];
    expect(await transcript()).toEqual(expected);

    const file = await fsp.readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../migrations/0018_delivered_message_order.sql"
      ),
      "utf8"
    );
    const backfill = file.split("--> statement-breakpoint").at(-1)!;
    await withoutDeliveredAtCheck(async () => {
      await t.db.execute(
        sql`update messages set delivered_seq = null, delivered_at = null where organization_id = ${org.organizationId}`
      );
      await t.db.execute(sql.raw(backfill));
      await t.db.execute(sql.raw(await migrationStatement("0019", 1)));
    });
    expect(await transcript()).toEqual(expected);
  });
});

describe("migration 0019_delivered_message_time", () => {
  it("stamps messages delivered before the migration with the start of the run that took them", async () => {
    const org = await organization();
    await org.send(org.defaultConversation, "H");
    const run0 = await org.claim();
    await run0.reply("L0");
    await org.send(org.defaultConversation, "A");
    await org.send(org.defaultConversation, "Q");
    await run0.finish();
    const run1 = await org.claim();
    await run1.finish();
    const expected = (
      await listConversationMessages(
        t.db,
        org.organizationId,
        org.defaultConversation.id
      )
    ).map((m) => [m.body, m.deliveredAt]);
    expect(expected).toEqual([
      ["H", run0.claimed.run.startedAt],
      ["L0", null],
      ["A", run1.claimed.run.startedAt],
      ["Q", run1.claimed.run.startedAt],
    ]);
    // 받은 실행 시도를 찾지 못한 메시지는 보낸 시각을 쓴다.
    const [q] = (
      await t.db.execute<{ created_at: string }>(
        sql`select created_at from messages where body = 'Q' and organization_id = ${org.organizationId}`
      )
    ).rows;

    await withoutDeliveredAtCheck(async () => {
      await t.db.execute(
        sql`update messages set delivered_at = null where organization_id = ${org.organizationId}`
      );
      await t.db.execute(
        sql`update wakes set run_id = null from messages where wakes.message_id = messages.id and messages.body = 'Q' and messages.organization_id = ${org.organizationId}`
      );
      await t.db.execute(sql.raw(await migrationStatement("0019", 1)));
    });
    expect(
      (
        await t.db.execute<{ body: string; delivered_at: string | null }>(
          sql`select body, delivered_at from messages where organization_id = ${org.organizationId} order by seq`
        )
      ).rows.map((r) => [
        r.body,
        r.delivered_at && new Date(r.delivered_at).toISOString(),
      ])
    ).toEqual([
      ["H", run0.claimed.run.startedAt],
      ["L0", null],
      ["A", run1.claimed.run.startedAt],
      ["Q", new Date(q!.created_at).toISOString()],
    ]);
  });
});

/** migration 파일(`prefix`가 `0019`면 `0019_…`)의 `index`번째 문장(0부터). */
async function migrationStatement(prefix: string, index: number) {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../migrations"
  );
  const name = (await fsp.readdir(dir)).find((f) =>
    f.startsWith(`${prefix}_`)
  )!;
  const file = await fsp.readFile(path.join(dir, name), "utf8");
  return file.split("--> statement-breakpoint")[index]!;
}

/**
 * 받은 위치와 받은 시각이 함께 있어야 한다는 제약을 잠시 빼고 `fn`을 돌린다(backfill 문만 다시 돌릴 때). 끝나면 제약을 되살리므로
 * backfill 결과가 제약을 지키는지도 확인한다. 이 파일의 검사는 차례로 돌아 다른 검사와 겹치지 않는다.
 */
async function withoutDeliveredAtCheck(fn: () => Promise<void>) {
  await t.db.execute(
    sql`alter table messages drop constraint messages_delivered_at_check`
  );
  try {
    await fn();
  } finally {
    await t.db.execute(
      sql`alter table messages add constraint messages_delivered_at_check check ((delivered_seq is null) = (delivered_at is null))`
    );
  }
}

// 조직의 기본 대화는 하나뿐이다.
describe("default conversation", () => {
  it("allows a single default conversation per organization", async () => {
    const org = await organization();
    await expect(
      t.db.insert(conversations).values({
        id: randomUUID(),
        organizationId: org.organizationId,
        title: "또 하나의 기본 대화",
        isDefault: true,
        createdAt: new Date(),
      })
    ).rejects.toThrow();
  });
});
