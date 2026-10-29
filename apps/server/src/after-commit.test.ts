import type { Event } from "@babojubot/contracts";
import type { RunCancellation } from "@babojubot/core";
import { refused, stored } from "@babojubot/db";
import { describe, expect, it } from "vitest";
import { applyAfterCommit, completeStored } from "./after-commit.ts";

const event = (id: number): Event => ({
  id,
  organizationId: "A",
  type: "organization.created",
  payload: { name: "x", stage: "planning", leadAgentId: "lead" },
  createdAt: new Date().toISOString(),
});

/** 부른 순서를 남기는 가짜 hub·dispatcher. 조직 재개 처리는 `release`를 부를 때까지 끝나지 않는다. */
const fakes = () => {
  const calls: string[] = [];
  let release = () => {};
  const resumed = new Promise<void>((resolve) => (release = resolve));
  return {
    calls,
    release: () => release(),
    deps: {
      hub: {
        publish: (...events: Event[]) =>
          calls.push(`publish ${events.map((e) => e.id).join(",")}`),
      },
      dispatcher: {
        cancel: (cancellation: RunCancellation | null) =>
          calls.push(`cancel ${cancellation?.runIds.join(",") ?? "none"}`),
        kickOrganization: async (organizationId: string) => {
          calls.push(`resume ${organizationId}`);
          await resumed;
          calls.push(`resumed ${organizationId}`);
        },
        kick: (agentId: string) => calls.push(`kick ${agentId}`),
      },
    },
  };
};

describe("applyAfterCommit", () => {
  it("publishes, cancels, waits for the resumed organization, then kicks", async () => {
    const f = fakes();
    const applied = applyAfterCommit(f.deps, {
      events: [event(1), event(2)],
      cancellation: { reason: "owner_interrupt", runIds: ["r1"] },
      resumedOrganizationId: "A",
      woken: ["lead", "worker"],
    });
    await Promise.resolve();
    expect(f.calls).toEqual(["publish 1,2", "cancel r1", "resume A"]);

    f.release();
    await applied;
    expect(f.calls).toEqual([
      "publish 1,2",
      "cancel r1",
      "resume A",
      "resumed A",
      "kick lead",
      "kick worker",
    ]);
  });

  it("does only what the stored result asks for", async () => {
    const f = fakes();
    await applyAfterCommit(f.deps, { events: [event(3)], woken: ["lead"] });
    expect(f.calls).toEqual(["publish 3", "kick lead"]);
  });
});

describe("completeStored", () => {
  it("applies what comes after a successful save and returns only the value", async () => {
    const f = fakes();
    expect(
      await completeStored(f.deps, stored({ id: "x" }, { events: [event(4)] }))
    ).toEqual({ kind: "ok", value: { id: "x" } });
    expect(f.calls).toEqual(["publish 4"]);
  });

  it("applies nothing for a refusal", async () => {
    const f = fakes();
    expect(await completeStored(f.deps, refused("not_found"))).toEqual({
      kind: "refused",
      reason: "not_found",
    });
    expect(f.calls).toEqual([]);
  });
});
