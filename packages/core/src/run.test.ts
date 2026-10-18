import type { Agent, RunResult } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import {
  acceptsToolCalls,
  planOwnerMessage,
  planRunFinish,
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
  createdAt: at,
};
const worker: Agent = { ...lead, id: "worker-1", role: "worker" };

describe("planOwnerMessage", () => {
  it("records the message for the Lead, a pending wake and an Event together", () => {
    const plan = planOwnerMessage(
      { organizationId: "org-1", agents: [worker, lead] },
      { body: "목표를 정하자", delivery: "next_run" },
      sequence("msg-1", "wake-1")
    );
    expect(plan.message).toEqual({
      id: "msg-1",
      organizationId: "org-1",
      agentId: "lead-1",
      author: "owner",
      body: "목표를 정하자",
      delivery: "next_run",
      sentByRunId: null,
      deliveredToRunId: null,
      createdAt: at,
    });
    expect(plan.wake).toEqual({
      id: "wake-1",
      organizationId: "org-1",
      agentId: "lead-1",
      kind: "owner_message",
      messageId: "msg-1",
      createdAt: at,
    });
    expect(plan.event).toEqual({
      organizationId: "org-1",
      type: "message.created",
      payload: {
        messageId: "msg-1",
        agentId: "lead-1",
        author: "owner",
        runId: null,
      },
    });
  });
});

describe("planRunStart", () => {
  const wake = (id: string, body: string): PendingWake => ({
    id,
    organizationId: "org-1",
    agentId: "lead-1",
    kind: "owner_message",
    messageId: `msg-${id}`,
    body,
    createdAt: at,
  });

  it("bundles every pending wake into one run, in order", () => {
    const plan = planRunStart(
      {
        agent: lead,
        pendingWakes: [wake("w1", "첫째"), wake("w2", "둘째")],
        instructionsBundleVersion: null,
        previousRun: undefined,
      },
      sequence("run-1")
    );
    expect(plan?.run).toEqual({
      id: "run-1",
      organizationId: "org-1",
      agentId: "lead-1",
      instructionsBundleVersion: null,
      sessionBefore: null,
      startedAt: at,
    });
    expect(plan?.wakeReasons).toEqual([
      {
        kind: "owner_message",
        wakeId: "w1",
        messageId: "msg-w1",
        body: "첫째",
      },
      {
        kind: "owner_message",
        wakeId: "w2",
        messageId: "msg-w2",
        body: "둘째",
      },
    ]);
    expect(plan?.event).toEqual({
      organizationId: "org-1",
      type: "run.started",
      payload: { runId: "run-1", agentId: "lead-1", wakeIds: ["w1", "w2"] },
    });
  });

  it("starts nothing without a pending wake", () => {
    expect(
      planRunStart(
        {
          agent: lead,
          pendingWakes: [],
          instructionsBundleVersion: null,
          previousRun: undefined,
        },
        sequence("run-1")
      )
    ).toBeUndefined();
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

describe("planRunFinish", () => {
  const result: RunResult = {
    stopReason: "completed",
    error: null,
    summary: "답장함",
    usage: { inputTokens: 1, outputTokens: 2, costUsd: null },
    nextSession: { turn: 1 },
  };
  const run = { id: "run-1", organizationId: "org-1", agentId: "lead-1" };

  it("ends the run with the runtime's stop reason and announces it", () => {
    const plan = planRunFinish(run, result, sequence());
    expect(plan.update).toEqual({
      status: "completed",
      summary: "답장함",
      error: null,
      usage: result.usage,
      sessionAfter: { turn: 1 },
      finishedAt: at,
    });
    expect(plan.event).toEqual({
      organizationId: "org-1",
      type: "run.finished",
      payload: {
        runId: "run-1",
        agentId: "lead-1",
        stopReason: "completed",
        summary: "답장함",
        error: null,
      },
    });
  });
});

describe("acceptsToolCalls", () => {
  it("allows organization tools only while the run is running", () => {
    expect(acceptsToolCalls("running")).toBe(true);
    for (const status of ["completed", "failed", "cancelled"] as const)
      expect(acceptsToolCalls(status)).toBe(false);
  });
});
