import { defaultAgentAppearance } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { planAgentProfileChange } from "./agent-profile.ts";

const agent = {
  id: "agent-1",
  organizationId: "org-1",
  name: "Analyst 1",
  appearance: {
    color: "sky",
    eyes: "round",
    mouth: "smile",
    accessory: "none",
  } as const,
};

describe("planAgentProfileChange", () => {
  it("records only what changed with the previous name", () => {
    const plan = planAgentProfileChange(
      agent,
      { name: "통계 담당", appearance: agent.appearance },
      ["Research Lead"]
    );
    expect(plan).toEqual({
      update: { name: "통계 담당" },
      event: {
        organizationId: "org-1",
        type: "agent.profile_changed",
        payload: {
          by: "owner",
          agentId: "agent-1",
          name: { from: "Analyst 1", to: "통계 담당" },
          appearance: null,
        },
      },
    });
  });

  it("records a new face without touching the name", () => {
    const appearance = { ...agent.appearance, accessory: "glasses" } as const;
    expect(planAgentProfileChange(agent, { appearance }, [])).toMatchObject({
      update: { appearance },
      event: { payload: { name: null, appearance } },
    });
  });

  it("is unchanged when nothing differs", () => {
    expect(
      planAgentProfileChange(
        agent,
        { name: "Analyst 1", appearance: { ...agent.appearance } },
        []
      )
    ).toBe("unchanged");
  });

  it("refuses a name another agent of the organization already has, ignoring case", () => {
    expect(
      planAgentProfileChange(agent, { name: "research lead" }, [
        "Research Lead",
      ])
    ).toBe("name_taken");
  });

  it("lets an agent change only the case of its own name", () => {
    expect(
      planAgentProfileChange(agent, { name: "ANALYST 1" }, ["Research Lead"])
    ).toMatchObject({ update: { name: "ANALYST 1" } });
  });
});

describe("defaultAgentAppearance", () => {
  it("is stable for the same id and varies across ids", () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    expect(defaultAgentAppearance(ids[0]!)).toEqual(
      defaultAgentAppearance(ids[0]!)
    );
    const faces = new Set(
      ids.map((id) => JSON.stringify(defaultAgentAppearance(id)))
    );
    expect(faces.size).toBeGreaterThan(6);
  });
});
