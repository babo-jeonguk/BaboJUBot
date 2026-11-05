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
});
