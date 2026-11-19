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

/**
 * 연결 `p`의 첫 저장은 `gate`를 열 때까지 붙잡아 두고, 부른 차례를 남기는 가짜 저장. 다른 연결 `q`는 저장 차례를 기다리지
 * 않으므로, 그 저장이 시작되면(`otherSaving`) 그보다 먼저 시작한 `p`의 확인도 저장 차례를 정하는 자리까지 왔다.
 */
const fakes = () => {
  const gate = createGate();
  const stored = new Map<string, ProviderReadinessCheck>();
  const calls: string[] = [];
  const results = [ready, notReady];
  let saves = 0;
  let otherSaved!: () => void;
  const otherSaving = new Promise<void>((resolve) => (otherSaved = resolve));
  const connection = (
    id: string,
    checkReadiness: () => Promise<ProviderReadinessCheck>
  ): ProviderConnection => ({
    id,
    label: id.toUpperCase(),
    models: [],
    adapter: {
      ...fakeDeclarations(),
      async execute() {
        throw new Error("unused");
      },
      checkReadiness,
    },
  });
  const save = async (provider: string, check: ProviderReadinessCheck) => {
    const name = provider === "q" ? "Q" : ++saves === 1 ? "A" : "B";
    calls.push(`start ${name}`);
    if (name === "A") await gate.wait(new AbortController().signal);
    if (name === "Q") otherSaved();
    stored.set(provider, check);
    calls.push(`end ${name}`);
    return check;
  };
  return {
    gate,
    stored,
    calls,
    otherSaving,
    connections: [
      connection("p", async () => results.shift()!),
      connection("q", async () => ready),
    ],
    save,
  };
};

describe("ReadinessMonitor", () => {
  it("saves the latest started check last even when an older check's save is slow", async () => {
    const f = fakes();
    const monitor = new ReadinessMonitor({
      save: f.save,
      connections: f.connections,
      hub: { publishSettingsChanged() {} },
      now: () => new Date("2026-10-31T00:00:00.000Z"),
    });

    const a = monitor.check("p");
    await f.gate.reached;
    const b = monitor.check("p");
    // B와 같은 길을 거치는 다른 연결의 확인을 B 뒤에 시작해, 그 저장이 시작된 것을 B의 도착 신호로 쓴다. 그때 B는 A의
    // 저장을 기다리고 있어야 한다.
    const other = monitor.check("q");
    await f.otherSaving;
    expect(f.calls).toEqual(["start A", "start Q", "end Q"]);
    expect(monitor.checking("p")).toBe(true);

    f.gate.open();
    await Promise.all([a, b, other]);
    expect(f.stored.get("p")).toEqual(notReady);
    expect(monitor.checking("p")).toBe(false);
    expect(f.calls.filter((call) => !call.endsWith("Q"))).toEqual([
      "start A",
      "end A",
      "start B",
      "end B",
    ]);
  });
});

describe("ReadinessMonitor with the isolation safety check", () => {
  const unavailable: ProviderReadinessCheck = {
    status: "not_ready",
    reason: "isolation_unavailable",
  };
  const monitorWith = (
    before: () => Promise<ProviderReadinessCheck | null>,
    checkReadiness: () => Promise<ProviderReadinessCheck> = async () => ready
  ) => {
    const stored = new Map<string, ProviderReadinessCheck>();
    const connection: ProviderConnection = {
      id: "p",
      label: "P",
      models: [],
      adapter: {
        ...fakeDeclarations(),
        async execute() {
          throw new Error("unused");
        },
        checkReadiness,
      },
    };
    const monitor = new ReadinessMonitor({
      save: async (provider, check) => stored.set(provider, check),
      connections: [connection],
      hub: { publishSettingsChanged() {} },
      now: () => new Date("2026-11-06T00:00:00.000Z"),
      timeoutMs: 20,
      before,
    });
    return { monitor, stored };
  };

  it("saves the safety check's own result even when it takes longer than a connection's check may", async () => {
    // 안전 확인은 자기 시한 안에 결과(통과·경계 열림·환경 없음)를 정한다. 연결의 확인 시한은 그 결과를 알수없음으로 바꾸지 않는다.
    const { monitor, stored } = monitorWith(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(unavailable), 100))
    );
    await monitor.check("p");
    expect(stored.get("p")).toEqual(unavailable);
  });

  it("still limits the connection's own check after the safety check passes", async () => {
    const { monitor, stored } = monitorWith(
      async () => null,
      () => new Promise(() => {})
    );
    await monitor.check("p");
    expect(stored.get("p")).toEqual({
      status: "unknown",
      reason: "check_timeout",
    });
  });

  it("closes without waiting for a safety check that is still running", async () => {
    let reached!: () => void;
    const safetyCheckRunning = new Promise<void>((r) => (reached = r));
    const { monitor, stored } = monitorWith(() => {
      reached();
      return new Promise(() => {});
    });
    const check = monitor.check("p");
    // 안전 확인이 도는 중에 닫는다.
    await safetyCheckRunning;
    await monitor.close();
    await check;
    expect(stored.has("p")).toBe(false);
  });
});
