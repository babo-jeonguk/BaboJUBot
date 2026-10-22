import { describe, expect, it } from "vitest";
import { planHeartbeat, planHeartbeatChange } from "./heartbeat.ts";

const at = (iso: string) => new Date(iso);
const agent = (
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    nextAt: string | null;
  },
  paused = false
) => ({ id: "agent-1", organizationId: "org-1", heartbeat, paused });
const source = (now: string) => ({ newId: () => "wake-1", now: () => at(now) });

describe("planHeartbeatChange", () => {
  it("schedules the next heartbeat one interval after turning it on, even while paused", () => {
    const now = at("2026-10-22T00:00:00.000Z");
    expect(
      planHeartbeatChange(
        agent({ enabled: false, intervalMinutes: 60, nextAt: null }),
        "paused",
        { enabled: true, intervalMinutes: 30 },
        now
      )
    ).toEqual({
      heartbeat: {
        enabled: true,
        intervalMinutes: 30,
        nextAt: "2026-10-22T00:30:00.000Z",
      },
      event: {
        organizationId: "org-1",
        type: "agent.heartbeat_changed",
        payload: {
          by: "owner",
          agentId: "agent-1",
          enabled: true,
          intervalMinutes: 30,
          nextAt: "2026-10-22T00:30:00.000Z",
        },
      },
    });
  });

  it("drops the schedule when turned off and records nothing for the same values", () => {
    const on = agent({
      enabled: true,
      intervalMinutes: 30,
      nextAt: "2026-10-22T00:30:00.000Z",
    });
    const now = at("2026-10-22T00:10:00.000Z");
    expect(
      planHeartbeatChange(
        on,
        "researching",
        { enabled: false, intervalMinutes: 30 },
        now
      )
    ).toMatchObject({
      heartbeat: { enabled: false, intervalMinutes: 30, nextAt: null },
    });
    expect(
      planHeartbeatChange(
        on,
        "researching",
        { enabled: true, intervalMinutes: 30 },
        now
      )
    ).toBe("unchanged");
  });

  it("refuses a change once the organization is completed or stopped", () => {
    for (const stage of ["completed", "stopped"] as const)
      expect(
        planHeartbeatChange(
          agent({ enabled: false, intervalMinutes: 60, nextAt: null }),
          stage,
          { enabled: true, intervalMinutes: 60 },
          at("2026-10-22T00:00:00.000Z")
        )
      ).toBe("organization_closed");
  });
});

describe("planHeartbeat", () => {
  const due = {
    enabled: true,
    intervalMinutes: 30,
    nextAt: "2026-10-22T00:30:00.000Z",
  };

  it("waits until the scheduled time and skips a heartbeat that is off", () => {
    expect(
      planHeartbeat(
        agent(due),
        { stage: "researching", pendingHeartbeat: false },
        source("2026-10-22T00:29:59.999Z")
      )
    ).toBeUndefined();
    expect(
      planHeartbeat(
        agent({ enabled: false, intervalMinutes: 30, nextAt: null }),
        { stage: "researching", pendingHeartbeat: false },
        source("2026-10-23T00:00:00.000Z")
      )
    ).toBeUndefined();
  });

  it("wakes once for every missed heartbeat and schedules the next one from now", () => {
    expect(
      planHeartbeat(
        agent(due),
        { stage: "researching", pendingHeartbeat: false },
        source("2026-10-22T05:00:00.000Z")
      )
    ).toEqual({
      wake: {
        id: "wake-1",
        organizationId: "org-1",
        agentId: "agent-1",
        kind: "heartbeat",
        createdAt: "2026-10-22T05:00:00.000Z",
      },
      nextAt: "2026-10-22T05:30:00.000Z",
      event: {
        organizationId: "org-1",
        type: "agent.heartbeat",
        payload: {
          agentId: "agent-1",
          wakeId: "wake-1",
          nextAt: "2026-10-22T05:30:00.000Z",
        },
      },
    });
  });

  it("does not pile up a second heartbeat while one is still waiting", () => {
    const plan = planHeartbeat(
      agent(due),
      { stage: "researching", pendingHeartbeat: true },
      source("2026-10-22T00:30:00.000Z")
    );
    expect(plan?.wake).toBeNull();
    expect(plan?.nextAt).toBe("2026-10-22T01:00:00.000Z");
  });

  it("keeps the schedule while the organization or the agent cannot start runs", () => {
    for (const stage of ["paused", "stopped", "completed"] as const)
      expect(
        planHeartbeat(
          agent(due),
          { stage, pendingHeartbeat: false },
          source("2026-10-22T01:00:00.000Z")
        )
      ).toBeUndefined();
    expect(
      planHeartbeat(
        agent(due, true),
        { stage: "researching", pendingHeartbeat: false },
        source("2026-10-22T01:00:00.000Z")
      )
    ).toBeUndefined();
  });
});
