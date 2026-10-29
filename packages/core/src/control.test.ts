import { describe, expect, it } from "vitest";
import { planAgentControl, planInterrupt } from "./control.ts";

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
