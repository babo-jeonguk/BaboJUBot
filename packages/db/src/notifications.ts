import type {
  FakeChannelMessage,
  Notification,
  OutboxEntry,
} from "@babojubot/contracts";
import {
  notificationContent,
  retryDelayMs,
  type NotificationFacts,
} from "@babojubot/core";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { isUuid } from "./rows.ts";
import {
  agents,
  approvals,
  fakeChannelMessages,
  messages,
  notificationOutbox,
  organizations,
  resultSubmissions,
  runs,
} from "./schema.ts";

// 알림 outbox. 전송 의도는 사건의 Event와 같은 transaction에 남고(rows.ts `insertEvent`),
// 전송은 짧은 claim → transaction 밖 채널 전송 → 같은 claim일 때만 정산(`settleNotification`)이다.

/** 가져간 알림. 정산은 `id`와 이 claim의 `claimToken`이 맞을 때만 반영된다. */
export type ClaimedNotification = {
  id: string;
  claimToken: string;
  /** 이번이 몇 번째 전송 시도(claim)인가. */
  attempts: number;
  notification: Notification;
};

/**
 * 보낼 차례인 알림을 오래된 것부터 가져간다(claim). 아직 안 보냈고, 재시도 예정이 지났으며, 다른 claim이 없거나 만료된 항목이다.
 * 동시에 가져가도 항목마다 한 claim만 이기며(`SKIP LOCKED`), claim마다 새 token과 시도 번호를 받는다. 내용은 원본에서 읽어 만든다.
 * 내용을 만들지 못한 항목은 그 claim의 실패로 정산해 재시도로 미루고, 나머지 항목은 그대로 돌려준다.
 */
export async function claimNotifications(
  db: Database,
  { now, leaseMs, limit }: { now: Date; leaseMs: number; limit: number }
): Promise<ClaimedNotification[]> {
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          isNull(notificationOutbox.sentAt),
          or(
            isNull(notificationOutbox.nextAttemptAt),
            lte(notificationOutbox.nextAttemptAt, now)
          ),
          or(
            isNull(notificationOutbox.claimExpiresAt),
            lte(notificationOutbox.claimExpiresAt, now)
          )
        )
      )
      .orderBy(asc(notificationOutbox.seq))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(notificationOutbox)
      .set({
        claimToken: sql`gen_random_uuid()`,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: sql`${notificationOutbox.attempts} + 1`,
      })
      .where(
        inArray(
          notificationOutbox.id,
          due.map((d) => d.id)
        )
      )
      .returning();
  });
  claimed.sort((a, b) => a.seq - b.seq);
  const result: ClaimedNotification[] = [];
  for (const row of claimed) {
    try {
      result.push({
        id: row.id,
        claimToken: row.claimToken!,
        attempts: row.attempts,
        notification: await buildNotification(db, row),
      });
    } catch (error) {
      await settleNotification(
        db,
        { id: row.id, claimToken: row.claimToken!, attempts: row.attempts },
        {
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        now
      );
    }
  }
  return result;
}

async function buildNotification(
  db: Database,
  row: typeof notificationOutbox.$inferSelect
): Promise<Notification> {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, row.organizationId));
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: org!.name,
    kind: row.kind,
    sourceId: row.sourceId,
    ...notificationContent(
      row.organizationId,
      row.sourceId,
      await factsOf(db, row)
    ),
    createdAt: row.createdAt.toISOString(),
  };
}

const missingSource = (row: typeof notificationOutbox.$inferSelect) =>
  new Error(`알림의 원본(${row.kind} ${row.sourceId})을 찾을 수 없습니다`);

/** 알림 내용을 만들 원본의 사실. 원본은 outbox 항목과 같은 조직에서만 찾는다. */
async function factsOf(
  db: Database,
  row: typeof notificationOutbox.$inferSelect
): Promise<NotificationFacts> {
  const inOrg = row.organizationId;
  switch (row.kind) {
    case "lead_message": {
      const [m] = await db
        .select({ body: messages.body })
        .from(messages)
        .where(
          and(eq(messages.organizationId, inOrg), eq(messages.id, row.sourceId))
        );
      if (!m) throw missingSource(row);
      return { kind: row.kind, body: m.body };
    }
    case "approval_request": {
      const [a] = await db
        .select({ kind: approvals.kind })
        .from(approvals)
        .where(
          and(
            eq(approvals.organizationId, inOrg),
            eq(approvals.id, row.sourceId)
          )
        );
      if (!a) throw missingSource(row);
      return { kind: row.kind, approvalKind: a.kind };
    }
    case "result_submission": {
      const [s] = await db
        .select({ summary: resultSubmissions.summary })
        .from(resultSubmissions)
        .where(
          and(
            eq(resultSubmissions.organizationId, inOrg),
            eq(resultSubmissions.id, row.sourceId)
          )
        );
      if (!s) throw missingSource(row);
      return { kind: row.kind, summary: s.summary };
    }
    case "run_failure": {
      const [r] = await db
        .select({ error: runs.error, agentName: agents.name })
        .from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(and(eq(runs.organizationId, inOrg), eq(runs.id, row.sourceId)));
      if (!r) throw missingSource(row);
      return { kind: row.kind, agentName: r.agentName, error: r.error };
    }
  }
}

/**
 * claim의 전송 결과를 남긴다. 그 claim의 token이 아직 항목에 있을 때만 반영하고(`true`), 만료 뒤 다른 claim이 가져갔거나
 * 이미 정산했으면 아무것도 바꾸지 않는다(`false`). 만료됐어도 아직 아무도 다시 가져가지 않았으면 그 결과가 유효하므로 반영한다. 실패면 시도 횟수에 따라 다음 시도를 미룬다.
 */
export async function settleNotification(
  db: Database,
  claim: Pick<ClaimedNotification, "id" | "claimToken" | "attempts">,
  outcome: { kind: "sent" } | { kind: "failed"; error: string },
  now: Date
): Promise<boolean> {
  const rows = await db
    .update(notificationOutbox)
    .set(
      outcome.kind === "sent"
        ? {
            sentAt: now,
            claimToken: null,
            claimExpiresAt: null,
            lastError: null,
          }
        : {
            claimToken: null,
            claimExpiresAt: null,
            lastError: outcome.error,
            nextAttemptAt: new Date(
              now.getTime() + retryDelayMs(claim.attempts)
            ),
          }
    )
    .where(
      and(
        eq(notificationOutbox.id, claim.id),
        eq(notificationOutbox.claimToken, claim.claimToken),
        isNull(notificationOutbox.sentAt)
      )
    )
    .returning({ id: notificationOutbox.id });
  return rows.length > 0;
}

/** outbox 항목과 전송 상태. 쌓인 순서다. */
export async function listOutbox(db: Database): Promise<OutboxEntry[]> {
  const rows = await db
    .select()
    .from(notificationOutbox)
    .orderBy(asc(notificationOutbox.seq));
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    sourceId: row.sourceId,
    eventId: row.eventId,
    createdAt: row.createdAt.toISOString(),
    delivery: {
      status: row.sentAt ? "sent" : "pending",
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      sentAt: row.sentAt?.toISOString() ?? null,
      lastError: row.lastError,
    },
  }));
}

/** 가짜 채널의 전송 기록. 같은 알림을 다시 받으면 처음 기록을 그대로 둔다. */
export async function recordFakeChannelMessage(
  db: Database,
  notification: Notification
): Promise<void> {
  const { id, createdAt: _createdAt, ...content } = notification;
  await db
    .insert(fakeChannelMessages)
    .values({ ...content, notificationId: id })
    .onConflictDoNothing({ target: fakeChannelMessages.notificationId });
}

const toFakeChannelMessage = ({
  seq: _seq,
  deliveredAt,
  ...row
}: typeof fakeChannelMessages.$inferSelect): FakeChannelMessage => ({
  ...row,
  deliveredAt: deliveredAt.toISOString(),
});

/** 가짜 채널이 받은 알림. 받은 순서다. */
export async function listFakeChannelMessages(
  db: Database
): Promise<FakeChannelMessage[]> {
  const rows = await db
    .select()
    .from(fakeChannelMessages)
    .orderBy(asc(fakeChannelMessages.seq));
  return rows.map(toFakeChannelMessage);
}

export async function findFakeChannelMessage(
  db: Database,
  id: string
): Promise<FakeChannelMessage | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(fakeChannelMessages)
    .where(eq(fakeChannelMessages.id, id));
  return row && toFakeChannelMessage(row);
}
