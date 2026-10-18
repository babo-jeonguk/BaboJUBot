import type { Agent } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { planRunStart, type PendingWake } from "./run.ts";

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
    kind: "owner_message",
    messageId: `msg-${id}`,
    body,
    createdAt: at,
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
