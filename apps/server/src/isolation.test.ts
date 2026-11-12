import { createRelayHub, type DockerEnvironment } from "@babojubot/runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRelayEndpoint } from "@babojubot/contracts";
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

/** 인증 중계를 흉내 낸다. 상태만 바꿀 수 있다. */
function relay(state: {
  verified: boolean;
  failed: boolean;
  readable?: boolean;
}) {
  const endpoint: CredentialRelayEndpoint & { recovered: number } = {
    recovered: 0,
    get verified() {
      return state.verified;
    },
    failed: () => state.failed,
    async recover() {
      endpoint.recovered++;
      if (state.readable) state.failed = false;
    },
    onFailure: () => () => {},
    handle: () => {},
  };
  return endpoint;
}
/** 검증된 인증 중계가 있는 실제 연결. */
const verified = {
  isolatable: true,
  credentialRelay: relay({ verified: true, failed: false }),
};

describe("IsolationGate", () => {
  // #148: 로그인 원본을 컨테이너에 넣지 않는다. 중계가 없거나 검증되지 않았거나 실패 상태면 Docker 확인 전에 막고 이 컴퓨터로도 돌리지 않는다.
  it("refuses an isolated run whose connection has no verified credential relay, or whose relay failed until a different login can be read", async () => {
    const asked: string[] = [];
    const docker: DockerEnvironment = {
      ...unresponsive,
      async checkDaemon() {
        asked.push("checkDaemon");
      },
    };
    gate = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
      // 복구 뒤에는 안전 확인으로 간다. 이 시험은 그 결과를 보지 않으므로 짧게 끝낸다.
      timeoutMs: 50,
    });
    for (const target of [
      { isolatable: true },
      {
        isolatable: true,
        credentialRelay: relay({ verified: false, failed: false }),
      },
    ]) {
      await expect(gate.readiness(target)).resolves.toEqual({
        status: "not_ready",
        reason: "credential_relay_unverified",
      });
      await expect(gate.place(target)).rejects.toThrow("검증되지 않아");
    }
    const state = { verified: true, failed: true, readable: false };
    const broken = { isolatable: true, credentialRelay: relay(state) };
    await expect(gate.place(broken)).rejects.toThrow("로그인을 쓰지 못해");
    await expect(gate.readiness(broken)).resolves.toEqual({
      status: "not_ready",
      reason: "credential_relay_failed",
    });
    expect(broken.credentialRelay.recovered).toBe(1);
    expect(asked).toEqual([]);
    // 사용자가 로그인을 고치고 다시 확인하면 풀린다(그 뒤로는 안전 확인으로 간다).
    state.readable = true;
    await gate.readiness(broken);
    expect(state.failed).toBe(false);
    expect(asked).toEqual(["checkDaemon"]);
    // 격리를 끄면 중계와 상관없이 지금처럼 이 컴퓨터에서 돈다.
    const off = new IsolationGate({
      docker,
      protectedPorts: () => [5432],
      readIsolated: async () => false,
      hostUrl: () => "http://127.0.0.1:1",
    });
    await expect(off.place({ isolatable: true })).resolves.toEqual({
      toolsBaseUrl: "http://127.0.0.1:1",
    });
    await off.close();
  });

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
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    await expect(gate.place(verified)).rejects.toThrow(
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
    await expect(off.place(verified)).resolves.toEqual({
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
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    await expect(gate.place(verified)).rejects.toThrow(
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
    const pending = gate.readiness(verified);
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
    await expect(gate.readiness(verified)).resolves.toEqual({
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
    await expect(gate.readiness(verified)).resolves.toEqual({
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
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
  });
});
