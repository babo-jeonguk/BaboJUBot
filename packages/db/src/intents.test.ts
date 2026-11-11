import { createHash, randomUUID } from "node:crypto";
import type { WakeReason } from "@babojubot/contracts";
import { planOrganizationCreation, planOwnerMessage } from "@babojubot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlAgent } from "./control.ts";
import { insertOwnerMessage } from "./conversations.ts";
import {
  acceptIntent,
  countSettleAttempt,
  findIntent,
  intentSettleAttemptLimit,
} from "./intents.ts";
import { insertOrganizationCreation } from "./organizations.ts";
import { updateProviderLimit } from "./providers.ts";
import { findAgentDetail } from "./run-views.ts";
import {
  claimNextRun,
  endRunBeforeModel,
  finishRun,
  interruptRun,
  listAgentsWithPendingWakes,
} from "./runs.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

// 실행 의도 복구 깨우기와 모델을 부르기 전에 끝나는 실행 시도(#150).

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await updateProviderLimit(t.db, "fake", 0);
});
afterAll(async () => {
  await t?.close();
});

const source = { newId: randomUUID, now: () => new Date() };
const kinds = (reasons: WakeReason[] | undefined) =>
  (reasons ?? []).map((r) => r.kind);

/** Lead의 실행 시도가 의도 하나를 수락한 채 서버 재시작으로 끝나고, 복구 깨우기를 받은 다음 실행 시도가 시작된 상태. */
async function recovering() {
  const creation = planOrganizationCreation(
    { name: "조직", goal: "목표", lead: { provider: "fake", model: null } },
    { files: [] },
    source
  );
  await insertOrganizationCreation(t.db, creation);
  const lead = creation.agents[0]!;
  const orgId = lead.organizationId;
  const claim = () =>
    claimNextRun(t.db, lead.id, { tokenDigest: randomUUID(), source });
  const created = (await claim())!;
  await finishRun(
    t.db,
    created.run.id,
    {
      stopReason: "completed",
      error: null,
      summary: null,
      usage: null,
      nextSession: null,
    },
    source
  );
  const say = async (body: string) => {
    const plan = planOwnerMessage(
      { organizationId: orgId, agents: creation.agents },
      creation.defaultConversation,
      { body, delivery: "next_run" },
      source
    );
    expect(
      (await insertOwnerMessage(t.db, plan, { steerable: () => false })).kind
    ).toBe("ok");
  };
  await say("일 시작");
  const first = (await claim())!;
  const request = JSON.stringify({ params: {}, body: { body: "답장" } });
  const accepted = await acceptIntent(
    t.db,
    { id: first.run.id },
    {
      key: "k-1",
      tool: "send_message",
      request,
      digest: createHash("sha256").update(request).digest("hex"),
      source: null,
    }
  );
  if (accepted.kind !== "accepted") throw new Error("not accepted");
  await interruptRun(t.db, first.run.id, source);
  const second = (await claim())!;
  expect(kinds(second.wakeReasons)).toEqual([
    "owner_message",
    "intent_recovery",
  ]);
  return { orgId, lead, claim, say, second, intentId: accepted.intent.id };
}

describe("a run that ends before the model", () => {
  it("keeps the recovery wake and its pending intents when the owner cancels during recovery, while the other inputs follow the cancel contract", async () => {
    const { orgId, lead, claim, second, intentId } = await recovering();
    expect((await controlAgent(t.db, orgId, lead.id, "pause")).kind).toBe("ok");
    const ended = await endRunBeforeModel(
      t.db,
      second.run.id,
      "cancelled",
      source
    );
    expect(ended).toMatchObject({
      kind: "ok",
      value: "ended",
      after: {
        events: [
          {
            type: "run.finished",
            payload: {
              stopReason: "cancelled",
              requeuedWakeIds: [expect.any(String)],
            },
          },
        ],
      },
    });
    expect((await findIntent(t.db, intentId))?.status).toBe("accepted");
    // 일시정지 동안에는 받지 않고, 재개하면 복구 깨우기만 다시 받는다(사용자 메시지는 취소된 실행 시도의 입력이라 다시 보내지 않음).
    expect(await claim()).toBeUndefined();
    await controlAgent(t.db, orgId, lead.id, "resume");
    expect(kinds((await claim())?.wakeReasons)).toEqual(["intent_recovery"]);
  });

  it("requeues every input when recovery is blocked, keeps the agent out of admission until the owner retries, and resets the attempt count on retry", async () => {
    const { orgId, lead, claim, say, second, intentId } = await recovering();
    for (let i = 0; i < intentSettleAttemptLimit; i++)
      expect(await countSettleAttempt(t.db, [intentId])).toBe(true);
    expect(await countSettleAttempt(t.db, [intentId])).toBe(false);
    const ended = await endRunBeforeModel(
      t.db,
      second.run.id,
      { blocked: "retry_exhausted" },
      source
    );
    expect(
      ended.kind === "ok" && ended.after.events.map((e) => e.type)
    ).toEqual(["run.finished", "agent.recovery_blocked"]);
    expect(
      (await findAgentDetail(t.db, orgId, lead.id))?.recovery
    ).toMatchObject({ state: "blocked", reason: "retry_exhausted" });
    await say("막힌 동안");
    expect(await claim()).toBeUndefined();
    expect(
      await listAgentsWithPendingWakes(t.db, { organizationId: orgId })
    ).toEqual([]);

    expect((await controlAgent(t.db, orgId, lead.id, "recover")).kind).toBe(
      "ok"
    );
    expect((await findAgentDetail(t.db, orgId, lead.id))?.recovery?.state).toBe(
      "retrying"
    );
    expect(await countSettleAttempt(t.db, [intentId])).toBe(true);
    expect(kinds((await claim())?.wakeReasons)).toEqual([
      "owner_message",
      "intent_recovery",
      "owner_message",
    ]);
  });
});
