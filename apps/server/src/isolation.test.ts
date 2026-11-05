import express from "express";
import type { DockerEnvironment } from "@babojubot/runtime";
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
    network: "babojubot-test",
    owner: "owner-test",
  },
  prepareNetwork: () => new Promise(() => {}),
  probe: () => new Promise(() => {}),
  async removeOrphans() {},
};

describe("IsolationGate", () => {
  it("decides that the environment is unavailable when the safety check does not finish within its time", async () => {
    gate = new IsolationGate({
      docker: unresponsive,
      toolsApp: express(),
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
    const pending = gate.readiness(true);
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
    await expect(gate.readiness(true)).resolves.toEqual({
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
    const first = gate.readiness(true);
    await expect.poll(() => prepared).toBe(1);
    gate.invalidate();
    const second = gate.readiness(true);
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
