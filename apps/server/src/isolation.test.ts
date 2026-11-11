import express from "express";
import type { DockerEnvironment } from "@babojubot/runtime";
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
    network: "babojubot-test",
    owner: "owner-test",
  },
  prepareNetwork: () => new Promise(() => {}),
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
  it("refuses an isolated run whose connection has no verified credential relay, or whose relay failed until the login can be read again", async () => {
    const asked: string[] = [];
    const docker: DockerEnvironment = {
      ...unresponsive,
      async prepareNetwork() {
        asked.push("prepareNetwork");
        return { gateway: "127.0.0.2" };
      },
    };
    gate = new IsolationGate({
      docker,
      toolsApp: express(),
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
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
    expect(asked).toEqual(["prepareNetwork"]);
    // 격리를 끄면 중계와 상관없이 지금처럼 이 컴퓨터에서 돈다.
    const off = new IsolationGate({
      docker,
      toolsApp: express(),
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
      async prepareNetwork() {
        asked.push("prepareNetwork");
        return { gateway: "127.0.0.2" };
      },
      async probe() {
        asked.push("probe");
        return { reached: [], toolsReached: true };
      },
    };
    gate = new IsolationGate({
      docker,
      toolsApp: express(),
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
      toolsApp: express(),
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
      toolsApp: express(),
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

  it("ends a safety check still running when it closes and opens no tools listener afterwards", async () => {
    const listeners = () =>
      process
        .getActiveResourcesInfo()
        .filter((name) => name === "TCPServerWrap").length;
    let prepared = 0;
    let finishNetwork!: () => void;
    const networkReady = new Promise<void>((resolve) => {
      finishNetwork = resolve;
    });
    let calledPrepare!: () => void;
    const prepareCalled = new Promise<void>((resolve) => {
      calledPrepare = resolve;
    });
    // 받은 중단 신호를 따르지 않고 늦게 끝나는 Docker. 끝나면 이 컴퓨터의 loopback을 gateway로 돌려준다.
    const slow: DockerEnvironment = {
      ...unresponsive,
      async prepareNetwork() {
        prepared++;
        calledPrepare();
        await networkReady;
        return { gateway: "127.0.0.1" };
      },
      async probe() {
        return { reached: [], toolsReached: true };
      },
    };
    const before = listeners();
    gate = new IsolationGate({
      docker: slow,
      toolsApp: express(),
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    const pending = gate.readiness(verified);
    await prepareCalled;
    await gate.close();
    // 닫으면 진행 중인 확인은 결과를 기다리지 않고 끝난다.
    await expect(pending).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    // 닫은 뒤 Docker가 끝나도 조직 도구 listener를 열지 않는다.
    finishNetwork();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listeners()).toBe(before);
    // 닫은 관문은 새 확인을 하지 않는다.
    gate.invalidate();
    await expect(gate.readiness(verified)).resolves.toEqual({
      status: "not_ready",
      reason: "isolation_unavailable",
    });
    expect(prepared).toBe(1);
  });

  it("shares one tools listener between overlapping safety checks and closes it with the gate", async () => {
    const listeners = () =>
      process
        .getActiveResourcesInfo()
        .filter((name) => name === "TCPServerWrap").length;
    let prepared = 0;
    let finishNetwork!: () => void;
    const networkReady = new Promise<void>((resolve) => {
      finishNetwork = resolve;
    });
    const tools: string[] = [];
    const docker: DockerEnvironment = {
      ...unresponsive,
      async prepareNetwork() {
        prepared++;
        await networkReady;
        return { gateway: "127.0.0.1" };
      },
      async probe(input) {
        tools.push(input.tools);
        return { reached: [], toolsReached: true };
      },
    };
    const before = listeners();
    gate = new IsolationGate({
      docker,
      toolsApp: express(),
      protectedPorts: () => [5432],
      readIsolated: async () => true,
      hostUrl: () => "http://127.0.0.1:1",
    });
    // 확인이 끝나기 전에 설정 화면을 다시 열면(다시 확인) 앞의 확인과 새 확인이 겹친다.
    const first = gate.readiness(verified);
    await expect.poll(() => prepared).toBe(1);
    gate.invalidate();
    const second = gate.readiness(verified);
    await expect.poll(() => prepared).toBe(2);
    finishNetwork();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    // 두 확인은 관문이 가진 listener 하나를 나눠 쓴다.
    expect(tools).toHaveLength(2);
    expect(tools[1]).toBe(tools[0]);
    expect(listeners()).toBe(before + 1);
    await gate.close();
    // 닫힌 listener 핸들은 다음 차례에 목록에서 빠진다.
    await expect.poll(() => listeners()).toBe(before);
  });
});
