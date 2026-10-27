import { describe, expect, it } from "vitest";
import { planAgentControl } from "./control.ts";

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
