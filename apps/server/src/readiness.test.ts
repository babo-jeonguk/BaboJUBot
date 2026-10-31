import type {
  ProviderConnection,
  ProviderReadinessCheck,
} from "@babojubot/contracts";
import { createGate, fakeDeclarations } from "@babojubot/runtime/testing";
import { describe, expect, it } from "vitest";
import { ReadinessMonitor } from "./readiness.ts";

const ready: ProviderReadinessCheck = { status: "ready", reason: null };
const notReady: ProviderReadinessCheck = {
  status: "not_ready",
  reason: "credentials_invalid",
};

/** 첫 저장은 `gate`를 열 때까지 붙잡아 두고, 부른 차례를 남기는 가짜 저장. */
const fakes = () => {
  const gate = createGate();
  const stored = new Map<string, ProviderReadinessCheck>();
  const calls: string[] = [];
  const results = [ready, notReady];
  let saves = 0;
  const connection: ProviderConnection = {
    id: "p",
    label: "P",
    models: [],
    adapter: {
      ...fakeDeclarations(),
      async execute() {
        throw new Error("unused");
      },
      async checkReadiness() {
        return results.shift()!;
      },
    },
  };
  const save = async (provider: string, check: ProviderReadinessCheck) => {
    const name = ++saves === 1 ? "A" : "B";
    calls.push(`start ${name}`);
    if (name === "A") await gate.wait(new AbortController().signal);
    stored.set(provider, check);
    calls.push(`end ${name}`);
    return check;
  };
  return { gate, stored, calls, connection, save };
};

describe("ReadinessMonitor", () => {
  it("saves the latest started check last even when an older check's save is slow", async () => {
    const f = fakes();
    const monitor = new ReadinessMonitor({
      save: f.save,
      connections: [f.connection],
      hub: { publishSettingsChanged() {} },
      now: () => new Date("2026-10-31T00:00:00.000Z"),
    });

    const a = monitor.check("p");
    await f.gate.reached;
    const b = monitor.check("p");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(monitor.checking("p")).toBe(true);

    f.gate.open();
    await Promise.all([a, b]);
    expect(f.stored.get("p")).toEqual(notReady);
    expect(monitor.checking("p")).toBe(false);
    expect(f.calls).toEqual(["start A", "end A", "start B", "end B"]);
  });
});
