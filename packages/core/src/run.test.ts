import { defaultAgentAppearance, type Agent } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  bundleWakes,
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
  provider: "fake",
  model: null,
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
  const wake = (
    id: string,
    body: string,
    delivery: "next_run" | "interrupt" = "next_run"
  ): PendingWake => ({
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
    delivery,
  });
  const heartbeat = (id: string): PendingWake => ({
    id,
    organizationId: "org-1",
    agentId: "lead-1",
    createdAt: at,
    reason: { kind: "heartbeat", wakeId: id },
    delivery: null,
  });
  const plan = (pendingWakes: PendingWake[]) =>
    planRunStart(
      {
        agent: lead,
        pendingWakes,
        instructionsBundleVersion: null,
        previousRun: undefined,
      },
      sequence("run-2")
    );

  it("bundles every pending wake when no interrupt message waits", () => {
    const started = plan([
      wake("w1", "하나"),
      heartbeat("w2"),
      wake("w3", "셋"),
    ]);
    expect(started?.wakeIds).toEqual(["w1", "w2", "w3"]);
    expect(started?.event.payload).toMatchObject({
      wakeIds: ["w1", "w2", "w3"],
    });
  });

  it("gives an interrupt run only the interrupt messages and leaves queued messages and other wakes for the following run", () => {
    const pending = [
      wake("w1", "줄 선 하나"),
      heartbeat("w2"),
      wake("w3", "중단하고 보낸 말", "interrupt"),
      wake("w4", "줄 선 둘"),
      wake("w5", "또 중단하고 보낸 말", "interrupt"),
    ];
    expect(bundleWakes(pending).map((w) => w.id)).toEqual(["w3", "w5"]);
    const started = plan(pending);
    expect(started?.wakeIds).toEqual(["w3", "w5"]);
    expect(started?.wakeReasons).toMatchObject([
      { body: "중단하고 보낸 말" },
      { body: "또 중단하고 보낸 말" },
    ]);
    expect(plan([])).toBeUndefined();
  });

  it("resumes the previous session only under the same instructions bundle", () => {
    const start = (current: string | null, previous: string | null) =>
      planRunStart(
        {
          agent: lead,
          pendingWakes: [wake("w1", "x")],
          instructionsBundleVersion: current,
          previousRun: {
            provider: "fake",
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

  it("pins the agent's provider and model on the run and starts a new session after a provider change", () => {
    const start = (
      agent: Pick<Agent, "provider" | "model">,
      previousProvider: string
    ) =>
      planRunStart(
        {
          agent: { ...lead, ...agent },
          pendingWakes: [wake("w1", "x")],
          instructionsBundleVersion: "v1",
          previousRun: {
            provider: previousProvider,
            instructionsBundleVersion: "v1",
            nextSession: { turn: 3 },
          },
        },
        sequence("run-2")
      )?.run;

    expect(start({ provider: "fake-2", model: "m" }, "fake-2")).toMatchObject({
      provider: "fake-2",
      model: "m",
      sessionBefore: { turn: 3 },
    });
    // 모델만 바뀌면 세션을 이어 간다. 프로바이더 연결이 바뀌면 새 세션이다.
    expect(
      start({ provider: "fake", model: "other" }, "fake")?.sessionBefore
    ).toEqual({ turn: 3 });
    expect(
      start({ provider: "fake", model: null }, "fake-2")?.sessionBefore
    ).toBeNull();
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
