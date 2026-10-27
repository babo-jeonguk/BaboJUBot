import { defaultAgentAppearance, type Agent } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  chooseReplyConversation,
  conversationTitle,
  planOwnerMessage,
  planRunInterruption,
  planRunStart,
  type PendingWake,
} from "./run.ts";

const at = "2026-10-18T00:00:00.000Z";
const sequence = (...ids: string[]) => ({
  newId: () => ids.shift()!,
  now: () => new Date(at),
});

const lead: Agent = {
  id: "lead-1",
  organizationId: "org-1",
  role: "lead",
  name: "Research Lead",
  appearance: defaultAgentAppearance("lead-1"),
  createdAt: at,
};
describe("Lead conversations", () => {
  const organization = { organizationId: "org-1", agents: [lead] };

  it("starts a new conversation with its first owner message, titled after the message", () => {
    const plan = planOwnerMessage(
      organization,
      "new",
      { body: "  데이터셋\n후보를   정리해 줄래요?  ", delivery: "next_run" },
      sequence("conversation-2", "msg-1", "wake-1")
    );
    expect(plan.conversation).toEqual({
      id: "conversation-2",
      organizationId: "org-1",
      title: "데이터셋 후보를 정리해 줄래요?",
      isDefault: false,
      createdAt: at,
    });
    expect(plan.message).toMatchObject({
      id: "msg-1",
      conversationId: "conversation-2",
      author: "owner",
    });
    expect(plan.wake).toMatchObject({ messageId: "msg-1", agentId: "lead-1" });
    expect(plan.event.payload).toMatchObject({
      messageId: "msg-1",
      conversationId: "conversation-2",
    });
  });

  it("adds a message to an existing conversation without starting another", () => {
    const plan = planOwnerMessage(
      organization,
      { id: "conversation-1" },
      { body: "이어서", delivery: "interrupt" },
      sequence("msg-2", "wake-2")
    );
    expect(plan.conversation).toBeNull();
    expect(plan.message).toMatchObject({
      conversationId: "conversation-1",
      delivery: "interrupt",
    });
  });

  it("cuts a long first message to the title length", () => {
    const title = conversationTitle("가".repeat(40));
    expect([...title]).toHaveLength(30);
    expect(title.endsWith("…")).toBe(true);
    expect(conversationTitle("짧은 제목")).toBe("짧은 제목");
  });

  it("replies where the owner messages came from, sends self-initiated replies to the default conversation, and asks for a choice across conversations", () => {
    expect(chooseReplyConversation(undefined, ["c-2", "c-2"], "c-1")).toBe(
      "c-2"
    );
    expect(chooseReplyConversation(undefined, [], "c-1")).toBe("c-1");
    expect(chooseReplyConversation(undefined, ["c-2", "c-3"], "c-1")).toBe(
      "conversation_required"
    );
    expect(chooseReplyConversation("c-3", ["c-2", "c-3"], "c-1")).toBe("c-3");
  });
});

describe("planRunStart", () => {
  const wake = (id: string, body: string): PendingWake => ({
    id,
    organizationId: "org-1",
    agentId: "lead-1",
    createdAt: at,
    reason: {
      kind: "owner_message",
      wakeId: id,
      messageId: `msg-${id}`,
      conversationId: "conversation-1",
      body,
    },
  });

  it("resumes the previous session only under the same instructions bundle", () => {
    const start = (current: string | null, previous: string | null) =>
      planRunStart(
        {
          agent: lead,
          pendingWakes: [wake("w1", "x")],
          instructionsBundleVersion: current,
          previousRun: {
            instructionsBundleVersion: previous,
            nextSession: { turn: 3 },
          },
        },
        sequence("run-2")
      )?.run.sessionBefore;

    expect(start("v1", "v1")).toEqual({ turn: 3 });
    expect(start(null, null)).toEqual({ turn: 3 });
    expect(start("v2", "v1")).toBeNull();
    expect(start("v1", null)).toBeNull();
  });
});

describe("planRunInterruption", () => {
  const run = {
    id: "run-1",
    organizationId: "org-1",
    agentId: "agent-1",
    cancelReason: null,
    sessionBefore: { turn: 1 },
  };
  const now = () => new Date("2026-10-22T00:00:00.000Z");

  it("ends the run as a server restart, keeps the session it started with, and requeues its wakes", () => {
    const plan = planRunInterruption(
      run,
      {
        wakes: [
          { id: "wake-1", kind: "owner_message" },
          { id: "wake-2", kind: "heartbeat" },
        ],
        pendingHeartbeat: false,
      },
      { now }
    );
    expect(plan.update).toMatchObject({
      status: "server_restart",
      sessionAfter: { turn: 1 },
      finishedAt: "2026-10-22T00:00:00.000Z",
    });
    expect(plan.requeueWakeIds).toEqual(["wake-1", "wake-2"]);
    expect(plan.event).toMatchObject({
      type: "run.finished",
      payload: {
        runId: "run-1",
        stopReason: "server_restart",
        requeuedWakeIds: ["wake-1", "wake-2"],
      },
    });
  });

  it("merges its heartbeat into a heartbeat that started waiting meanwhile", () => {
    const plan = planRunInterruption(
      run,
      {
        wakes: [
          { id: "wake-1", kind: "heartbeat" },
          { id: "wake-2", kind: "task_comment" },
        ],
        pendingHeartbeat: true,
      },
      { now }
    );
    expect(plan.requeueWakeIds).toEqual(["wake-2"]);
  });

  it("keeps an owner cancellation already requested and does not hand its wakes over again", () => {
    const plan = planRunInterruption(
      { ...run, cancelReason: "organization_paused" },
      {
        wakes: [{ id: "wake-1", kind: "owner_message" }],
        pendingHeartbeat: false,
      },
      { now }
    );
    expect(plan.update.status).toBe("cancelled");
    expect(plan.requeueWakeIds).toEqual([]);
    expect(plan.event).toMatchObject({
      payload: { stopReason: "cancelled" },
    });
  });
});
