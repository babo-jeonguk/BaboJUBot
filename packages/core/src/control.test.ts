import { describe, expect, it } from "vitest";
import { planAgentControl, planInterrupt, steerTarget } from "./control.ts";

const agent = (paused = false) => ({
  id: "agent-1",
  organizationId: "org-1",
  paused,
});

describe("planAgentControl interrupt", () => {
  it("cancels the running run without a message and keeps the agent unpaused", () => {
    expect(
      planAgentControl(agent(), "researching", "interrupt", "run-1")
    ).toEqual({
      paused: false,
      cancellation: { reason: "owner_interrupt", runIds: ["run-1"] },
      event: {
        organizationId: "org-1",
        type: "agent.interrupted",
        payload: {
          by: "owner",
          agentId: "agent-1",
          runId: "run-1",
          messageId: null,
        },
      },
    });
  });

  it("changes nothing when no run is waiting to be cancelled", () => {
    expect(planAgentControl(agent(), "researching", "interrupt", null)).toBe(
      "unchanged"
    );
    expect(planAgentControl(agent(true), "paused", "interrupt", null)).toBe(
      "unchanged"
    );
  });

  it("refuses a finished organization", () => {
    for (const stage of ["completed", "stopped"] as const)
      expect(planAgentControl(agent(), stage, "interrupt", "run-1")).toBe(
        "organization_closed"
      );
  });
});

describe("planInterrupt", () => {
  const message = { id: "msg-1", organizationId: "org-1", agentId: "lead-1" };
  const interrupted = (runId: string | null) => ({
    organizationId: "org-1",
    type: "agent.interrupted",
    payload: { by: "owner", agentId: "lead-1", runId, messageId: "msg-1" },
  });

  it("cancels the run in progress, joining one already cleaning up", () => {
    expect(
      planInterrupt(message, {
        stage: "researching",
        leadPaused: false,
        runningRunId: "run-1",
      })
    ).toEqual({
      cancellation: { reason: "owner_interrupt", runIds: ["run-1"] },
      event: interrupted("run-1"),
    });
  });

  it("interrupts no run while the organization or the Lead is paused, even one the pause is still cleaning up", () => {
    // 붙잡힌 메시지는 재개를 기다리지 진행 중 실행 시도 뒤를 기다리지 않는다.
    for (const held of [
      { stage: "paused" as const, leadPaused: false },
      { stage: "researching" as const, leadPaused: true },
    ])
      expect(
        planInterrupt(message, { ...held, runningRunId: "run-1" })
      ).toEqual({ cancellation: null, event: interrupted(null) });
  });

  it("refuses a finished organization", () => {
    expect(
      planInterrupt(message, {
        stage: "stopped",
        leadPaused: false,
        runningRunId: null,
      })
    ).toBe("organization_closed");
  });
});

describe("steerTarget", () => {
  const running = { id: "run-1", provider: "fake", cancelReason: null };
  const steerable = (provider: string) => provider === "fake";
  const target = (state: Partial<Parameters<typeof steerTarget>[0]> = {}) =>
    steerTarget(
      { stage: "researching", leadPaused: false, running, ...state },
      steerable
    );

  it("steers into the running run when its provider supports it", () => {
    expect(target()).toBe("run-1");
  });

  it("queues instead when there is no run to steer into, it is being cancelled, the provider cannot steer, or the message is held", () => {
    expect(target({ running: undefined })).toBeNull();
    expect(
      target({ running: { ...running, cancelReason: "owner_interrupt" } })
    ).toBeNull();
    expect(target({ running: { ...running, provider: "fake-2" } })).toBeNull();
    expect(target({ stage: "paused" })).toBeNull();
    expect(target({ leadPaused: true })).toBeNull();
    expect(target({ stage: "stopped" })).toBeNull();
  });
});
