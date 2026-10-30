import { defaultAgentAppearance, type Agent } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { admitsProviderRun, planAgentProviderChange } from "./provider.ts";

const agent: Agent = {
  id: "agent-1",
  organizationId: "org-1",
  role: "worker",
  name: "조사 1",
  appearance: defaultAgentAppearance("agent-1"),
  provider: "fake",
  model: "fake-mini",
  createdAt: "2026-10-30T00:00:00.000Z",
};

describe("admitsProviderRun", () => {
  it("admits a run while the provider runs fewer than its cap, and always when the cap is unlimited (0)", () => {
    expect(admitsProviderRun({ maxConcurrentRuns: 2, running: 1 })).toBe(true);
    expect(admitsProviderRun({ maxConcurrentRuns: 2, running: 2 })).toBe(false);
    // 상한을 줄여 진행 중인 수가 상한을 넘어도 끊지 않고 새 실행 시도만 막는다.
    expect(admitsProviderRun({ maxConcurrentRuns: 1, running: 2 })).toBe(false);
    expect(admitsProviderRun({ maxConcurrentRuns: 0, running: 50 })).toBe(true);
  });
});

describe("planAgentProviderChange", () => {
  it("records the previous and new choice, leaves an unchanged choice alone and refuses a closed organization", () => {
    expect(
      planAgentProviderChange(agent, "researching", {
        provider: "fake-2",
        model: null,
      })
    ).toEqual({
      update: { provider: "fake-2", model: null },
      event: {
        organizationId: "org-1",
        type: "agent.provider_changed",
        payload: {
          by: "owner",
          agentId: "agent-1",
          from: { provider: "fake", model: "fake-mini" },
          to: { provider: "fake-2", model: null },
        },
      },
    });
    expect(
      planAgentProviderChange(agent, "researching", {
        provider: "fake",
        model: "fake-mini",
      })
    ).toBe("unchanged");
    expect(
      planAgentProviderChange(agent, "completed", {
        provider: "fake-2",
        model: null,
      })
    ).toBe("organization_closed");
  });
});
