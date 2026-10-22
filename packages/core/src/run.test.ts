import type { Agent } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { planRunInterruption, planRunStart, type PendingWake } from "./run.ts";

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
describe("planRunStart", () => {
  const wake = (id: string, body: string): PendingWake => ({
    id,
    organizationId: "org-1",
    agentId: "lead-1",
    createdAt: at,
    reason: { kind: "owner_message", wakeId: id, messageId: `msg-${id}`, body },
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
