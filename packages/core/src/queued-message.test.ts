import { describe, expect, it } from "vitest";
import {
  planEdit,
  planSendNow,
  planWithdrawal,
  type QueuedMessageState,
} from "./queued-message.ts";

const queued = (
  overrides: Partial<QueuedMessageState> = {}
): QueuedMessageState => ({
  id: "msg-1",
  organizationId: "org-1",
  agentId: "lead-1",
  conversationId: "conversation-1",
  author: "owner",
  delivery: "next_run",
  withdrawn: false,
  deliveredToRunId: null,
  ...overrides,
});
const ids = {
  messageId: "msg-1",
  agentId: "lead-1",
  conversationId: "conversation-1",
};

describe("planWithdrawal", () => {
  it("withdraws a queued owner message", () => {
    expect(planWithdrawal(queued())).toMatchObject({
      event: {
        organizationId: "org-1",
        type: "message.withdrawn",
        payload: { by: "owner", ...ids },
      },
    });
  });

  it("refuses a delivered message and hides missing, withdrawn and Lead messages", () => {
    expect(planWithdrawal(queued({ deliveredToRunId: "run-1" }))).toBe(
      "message_delivered"
    );
    expect(planWithdrawal(undefined)).toBe("not_found");
    expect(planWithdrawal(queued({ withdrawn: true }))).toBe("not_found");
    expect(planWithdrawal(queued({ author: "agent", delivery: null }))).toBe(
      "not_found"
    );
  });
});

describe("planEdit", () => {
  const editable = (overrides: Partial<QueuedMessageState> = {}) => ({
    ...queued(overrides),
    body: "처음 글",
  });

  it("records the previous and new text, also while paused", () => {
    for (const stage of ["researching", "paused"] as const)
      expect(planEdit(editable(), stage, "고친 글")).toEqual({
        event: {
          organizationId: "org-1",
          type: "message.edited",
          payload: {
            by: "owner",
            ...ids,
            previousBody: "처음 글",
            body: "고친 글",
          },
        },
      });
  });

  it("refuses delivered messages and closed organizations, and hides missing or withdrawn ones", () => {
    expect(
      planEdit(editable({ deliveredToRunId: "run-1" }), "researching", "x")
    ).toBe("message_delivered");
    expect(planEdit(editable(), "stopped", "x")).toBe("organization_closed");
    expect(planEdit(undefined, "researching", "x")).toBe("not_found");
    expect(planEdit(editable({ withdrawn: true }), "researching", "x")).toBe(
      "not_found"
    );
  });
});

describe("planSendNow", () => {
  const running = {
    stage: "researching" as const,
    agentPaused: false,
    runningRunId: "run-1",
  };

  it("cancels the running run and records the message sent now with the control command", () => {
    expect(planSendNow(queued(), running)).toEqual({
      cancellation: { reason: "owner_interrupt", runIds: ["run-1"] },
      events: [
        {
          organizationId: "org-1",
          type: "message.sent_now",
          payload: { by: "owner", ...ids },
        },
        {
          organizationId: "org-1",
          type: "agent.interrupted",
          payload: {
            by: "owner",
            agentId: "lead-1",
            runId: "run-1",
            messageId: "msg-1",
          },
        },
      ],
    });
  });

  it("changes only the delivery when the Lead is not running", () => {
    expect(
      planSendNow(queued(), { ...running, runningRunId: null })
    ).toMatchObject({ cancellation: null });
  });

  it("refuses delivered messages, finished organizations and paused organizations or Leads", () => {
    expect(planSendNow(queued({ deliveredToRunId: "run-1" }), running)).toBe(
      "message_delivered"
    );
    expect(planSendNow(undefined, running)).toBe("not_found");
    for (const stage of ["completed", "stopped"] as const)
      expect(planSendNow(queued(), { ...running, stage })).toBe(
        "organization_closed"
      );
    expect(
      planSendNow(queued(), {
        stage: "paused",
        agentPaused: false,
        runningRunId: null,
      })
    ).toBe("paused");
    expect(planSendNow(queued(), { ...running, agentPaused: true })).toBe(
      "paused"
    );
  });
});
