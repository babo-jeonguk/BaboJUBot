import { describe, expect, it } from "vitest";
import { maxQueuedMessages } from "./message.ts";
import { lifecycleStages } from "./organization.ts";
import {
  newMessageRefusal,
  ownerActions,
  queuedMessageRefusal,
  type LeadRunState,
  type OwnerActionState,
} from "./owner-actions.ts";

const state = (
  overrides: Partial<OwnerActionState> = {}
): OwnerActionState => ({
  stage: "researching",
  leadPaused: false,
  run: "idle",
  queuedCount: 0,
  ...overrides,
});

const visible = (s: OwnerActionState) =>
  Object.entries(ownerActions(s).actions)
    .filter(([, verdict]) => verdict.visible)
    .map(([action]) => action)
    .sort();

const runStates: LeadRunState[] = ["idle", "running", "cancelling"];
const everyState = lifecycleStages.flatMap((stage) =>
  [false, true].flatMap((leadPaused) =>
    runStates.flatMap((run) =>
      [0, maxQueuedMessages - 1, maxQueuedMessages].map((queuedCount) =>
        state({ stage, leadPaused, run, queuedCount })
      )
    )
  )
);

describe("newMessageRefusal", () => {
  it("accepts a message below the queue cap and refuses closed organizations and a full queue", () => {
    expect(
      newMessageRefusal({ stage: "researching", queuedCount: 0 })
    ).toBeNull();
    expect(
      newMessageRefusal({ stage: "paused", queuedCount: maxQueuedMessages - 1 })
    ).toBeNull();
    expect(
      newMessageRefusal({
        stage: "researching",
        queuedCount: maxQueuedMessages,
      })
    ).toBe("queue_full");
    expect(newMessageRefusal({ stage: "stopped", queuedCount: 0 })).toBe(
      "organization_closed"
    );
    expect(
      newMessageRefusal({ stage: "completed", queuedCount: maxQueuedMessages })
    ).toBe("organization_closed");
  });
});

describe("queuedMessageRefusal", () => {
  it("lets a closed organization only withdraw", () => {
    for (const stage of ["completed", "stopped"] as const) {
      const s = { stage, leadPaused: false };
      expect(queuedMessageRefusal("withdraw", s)).toBeNull();
      expect(queuedMessageRefusal("edit", s)).toBe("organization_closed");
      expect(queuedMessageRefusal("send_now", s)).toBe("organization_closed");
    }
  });

  it("refuses only send-now while the organization or the Lead is paused", () => {
    for (const s of [
      { stage: "paused" as const, leadPaused: false },
      { stage: "researching" as const, leadPaused: true },
    ]) {
      expect(queuedMessageRefusal("send_now", s)).toBe("paused");
      expect(queuedMessageRefusal("edit", s)).toBeNull();
      expect(queuedMessageRefusal("withdraw", s)).toBeNull();
    }
    expect(
      queuedMessageRefusal("send_now", {
        stage: "researching",
        leadPaused: false,
      })
    ).toBeNull();
  });
});

describe("ownerActions", () => {
  it("shows one send button when the Lead is not running", () => {
    expect(visible(state())).toEqual(["edit", "send", "withdraw"]);
  });

  it("shows stop, interrupt-send, queue and send-now while the Lead is running", () => {
    expect(visible(state({ run: "running" }))).toEqual([
      "edit",
      "interrupt_send",
      "queue",
      "send_now",
      "stop_run",
      "withdraw",
    ]);
  });

  it("does not count a run being cancelled as running", () => {
    expect(visible(state({ run: "cancelling" }))).toEqual(
      visible(state({ run: "idle" }))
    );
  });

  it("shows only withdraw in a closed organization", () => {
    for (const stage of ["completed", "stopped"] as const)
      for (const run of runStates)
        expect(visible(state({ stage, run }))).toEqual(["withdraw"]);
  });

  it("says why a message is held and hides send-now while paused", () => {
    const org = ownerActions(state({ stage: "paused" }));
    expect(org.heldBy).toBe("organization_paused");
    expect(org.actions.send_now.visible).toBe(false);
    const lead = ownerActions(state({ leadPaused: true, run: "running" }));
    expect(lead.heldBy).toBe("lead_paused");
    expect(lead.actions.send_now.visible).toBe(false);
    expect(ownerActions(state()).heldBy).toBeNull();
  });

  it("keeps new message buttons visible but refused when the queue is full", () => {
    const { actions } = ownerActions(
      state({ run: "running", queuedCount: maxQueuedMessages })
    );
    expect(actions.queue).toEqual({ visible: true, refusal: "queue_full" });
    expect(actions.interrupt_send).toEqual({
      visible: true,
      refusal: "queue_full",
    });
    expect(actions.send_now).toEqual({ visible: true, refusal: null });
  });

  it("accepts every button it shows, except new messages on a full queue which the screen disables", () => {
    for (const s of everyState)
      for (const [action, verdict] of Object.entries(ownerActions(s).actions)) {
        if (!verdict.visible || !("refusal" in verdict) || !verdict.refusal)
          continue;
        expect({ state: s, action, refusal: verdict.refusal }).toEqual({
          state: s,
          action: expect.stringMatching(/^(send|queue|interrupt_send)$/),
          refusal: "queue_full",
        });
      }
  });

  it("keeps what the server accepts but the screen hides", () => {
    // 실행 중이 아니어도 `지금 보내기`는 받아 전달 방식만 바꾸고, 일시정지 중 새 `중단하고 보내기`는 받아 두고 재개 뒤 먼저 전달한다.
    const idle = ownerActions(state()).actions;
    expect(idle.send_now).toEqual({ visible: false, refusal: null });
    const paused = ownerActions(state({ stage: "paused" })).actions;
    expect(paused.interrupt_send).toEqual({ visible: false, refusal: null });
  });
});
