import type { Event } from "@babojubot/contracts";
import { describe, expect, it } from "vitest";
import { EventHub } from "./event-hub.ts";

const event = (id: number, organizationId: string): Event => ({
  id,
  organizationId,
  type: "organization.created",
  payload: { name: "x", stage: "goal_setting", leadAgentId: crypto.randomUUID() },
  createdAt: new Date().toISOString(),
});

describe("EventHub", () => {
  it("routes by scope without rewriting the organization ID", () => {
    const hub = new EventHub();
    const all: Event[] = [];
    const a: Event[] = [];
    hub.subscribe({ kind: "all" }, (e) => all.push(e));
    hub.subscribe({ kind: "organization", organizationId: "A" }, (e) => a.push(e));

    hub.publish(event(1, "A"));
    hub.publish(event(2, "B"));

    expect(all.map((e) => [e.id, e.organizationId])).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
    expect(a.map((e) => e.id)).toEqual([1]);
  });

  it("stops delivering after unsubscribe and isolates a failing subscriber", () => {
    const hub = new EventHub();
    const got: number[] = [];
    const off = hub.subscribe({ kind: "all" }, (e) => got.push(e.id));
    hub.subscribe({ kind: "all" }, () => {
      throw new Error("broken socket");
    });

    hub.publish(event(1, "A"));
    off();
    hub.publish(event(2, "A"));

    expect(got).toEqual([1]);
  });
});
