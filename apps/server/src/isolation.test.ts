import { createRelayHub, type DockerEnvironment } from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { IsolationGate } from "./isolation.ts";

let gate: IsolationGate | undefined;
afterEach(async () => {
  await gate?.close();
  gate = undefined;
});

/** Docker가 응답하지 않는 환경. 받은 중단 신호도 따르지 않는다(끝난 시험 컨테이너를 지우는 중 등). */
const unresponsive: DockerEnvironment = {
  settings: {
    docker: ["docker"],
    image: "babojubot-runner-test",
    owner: "owner-test",
    relay: createRelayHub(),
  },
  checkDaemon: () => new Promise(() => {}),
  probe: () => new Promise(() => {}),
  async removeOrphans() {},
};

describe("IsolationGate", () => {
  // Windows는 Docker 격리를 지원하지 않는다(docs/providers.md 격리 실행). 격리를 켜면 Docker를 부르지 않고
  // 격리 환경 없음으로 두며, 이 컴퓨터로 대신 돌리지 않는다(PR #131 리뷰 3회차 P6).
  it("treats isolation as unavailable on Windows without asking Docker, and starts no run", async () => {
    const asked: string[] = [];
    const docker: DockerEnvironment = {
      ...unresponsive,
      async checkDaemon() {
        asked.push("checkDaemon");
      },
      async probe() {
        asked.push("probe");
        return { interfaces: [], reached: [], proxied: [], toolsReached: true };
      },
    };
    gate = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
      platform: "win32",
    });
    await expect(gate.readiness(true)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    await expect(gate.place(true)).rejects.toThrow(
      "격리 실행 환경이 안전한지 확인하지 못해 실행하지 않았습니다."
    );
    expect(asked).toEqual([]);
    // 격리가 꺼져 있으면 Windows에서도 지금처럼 이 컴퓨터에서 돈다.
    const off = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => false,
      hostUrl: () => "http://127.0.0.1:1",
      platform: "win32",
    });
    await expect(off.place(true)).resolves.toEqual({
      toolsBaseUrl: "http://127.0.0.1:1",
    });
    await off.close();
  });

  it("decides that the environment is unavailable when the safety check does not finish within its time", async () => {
    gate = new IsolationGate({
      docker: unresponsive,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
      timeoutMs: 50,
    });
    await expect(gate.readiness(true)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    await expect(gate.place(true)).rejects.toThrow(
      "격리 실행 환경이 안전한지 확인하지 못해 실행하지 않았습니다."
    );
  });

  it("ends a safety check still running when it closes and checks nothing afterwards", async () => {
    let asked = 0;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let called!: () => void;
    const calledCheck = new Promise<void>((resolve) => {
      called = resolve;
    });
    // 받은 중단 신호를 따르지 않고 늦게 끝나는 Docker.
    const slow: DockerEnvironment = {
      ...unresponsive,
      async checkDaemon() {
        asked++;
        called();
        await finished;
      },
      async probe() {
        return { interfaces: [], reached: [], proxied: [], toolsReached: true };
      },
    };
    gate = new IsolationGate({
      docker: slow,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    const pending = gate.readiness(true);
    await calledCheck;
    await gate.close();
    // 닫으면 진행 중인 확인은 결과를 기다리지 않고 끝난다.
    await expect(pending).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    finish();
    // 닫은 관문은 새 확인을 하지 않는다.
    gate.invalidate();
    await expect(gate.readiness(true)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    expect(asked).toBe(1);
  });

  it.each([
    [
      "the relay opened the user API",
      { proxied: [{ host: "127.0.0.1", port: 5432 }] },
    ],
    ["the container has a network device", { interfaces: ["eth0"] }],
    [
      "the container reached this computer directly",
      { reached: [{ host: "127.0.0.1", port: 5432 }] },
    ],
  ])("finds the environment unsafe when %s", async (_case, found) => {
    gate = new IsolationGate({
      docker: {
        ...unresponsive,
        async checkDaemon() {},
        async probe() {
          return {
            interfaces: [],
            reached: [],
            proxied: [],
            toolsReached: true,
            ...found,
          };
        },
      },
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    await expect(gate.readiness(true)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unsafe",
    });
  });

  it("finds the environment unavailable when the tools relay is not reached (positive control)", async () => {
    gate = new IsolationGate({
      docker: {
        ...unresponsive,
        async checkDaemon() {},
        async probe() {
          return {
            interfaces: [],
            reached: [],
            proxied: [],
            toolsReached: false,
          };
        },
      },
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    await expect(gate.readiness(true)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
  });
});
