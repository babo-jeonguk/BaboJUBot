import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { callArming } from "@babojubot/process/call-arming";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { withClient } from "./client.ts";
import { clusterUrl, startEmbeddedCluster } from "./embedded.ts";

/**
 * 시험이 정한 후보 번호(`candidates`)를 먼저 내주고, 목록이 비면 실제 candidatePort를 부른다. 번호를 고르는 호출은 인수가 없어 시험의
 * 대상으로 가를 수 없으므로, 시험은 cluster 시작을 `portCalls.run(무장, () => 시작, onTestFinished)`로 감싼다. 대역은 불린 순간 그
 * 호출의 무장을 잡는다: 다른 시험의 늦은 시작이나 감싸지 않은 호출은 시험이 정한 번호를 꺼내지 않는다(#286). `calls`는 그 호출이
 * 번호를 고른 횟수, `handedOut`은 내준 시험의 번호다.
 */
type PortArming = { candidates: number[]; handedOut: number[]; calls: number };
const portCalls = callArming<PortArming>();

vi.mock("./ports.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ports.ts")>();
  return {
    candidatePort: async () => {
      const arming = portCalls.current();
      if (!arming) return actual.candidatePort();
      arming.calls++;
      const next = arming.candidates.shift();
      if (next === undefined) return actual.candidatePort();
      arming.handedOut.push(next);
      return next;
    },
  };
});

/** 시험이 정한 후보 번호로 무장한 채 cluster를 시작한다. */
function startArmed(
  arming: PortArming,
  options: Parameters<typeof startEmbeddedCluster>[0]
) {
  return portCalls.run(
    arming,
    () => startEmbeddedCluster(options),
    onTestFinished
  );
}

/** 127.0.0.1의 port 하나를 잡고 있는 server. */
async function occupyPort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

async function temporaryDataDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
}

describe("embedded Postgres port", () => {
  it("starts on another port when the free port it picked is taken before Postgres binds it", async () => {
    // 번호만 미리 받은 사이 그 port를 남이 잡으면, Postgres는 다른 빈 port로 켜져야 한다.
    const taken = await occupyPort();
    onTestFinished(() => taken.close());
    const arming: PortArming = {
      candidates: [taken.port],
      handedOut: [],
      calls: 0,
    };
    const dataDir = await temporaryDataDir();
    const cluster = await startArmed(arming, { dataDir, persistent: false });
    onTestFinished(() => cluster.stop());
    expect(cluster.port).not.toBe(taken.port);
    // 시험의 번호를 이 시작이 받았고, 그 번호가 막혀 다시 골랐다.
    expect(arming.handedOut).toEqual([taken.port]);
    expect(arming.calls).toBeGreaterThanOrEqual(2);
    const { rows } = await withClient(
      clusterUrl(cluster.port, "postgres"),
      (client) =>
        client.query<{ data_directory: string }>("show data_directory")
    );
    expect(fs.realpathSync(rows[0]!.data_directory)).toBe(
      fs.realpathSync(dataDir)
    );
  }, 60_000);

  it("fails with the Postgres log instead of serving elsewhere when its configured port is taken", async () => {
    // 정한 port를 남이 잡았으면 그 port의 다른 프로그램에 붙지 않고 Postgres 로그와 함께 실패한다.
    const taken = await occupyPort();
    const dataDir = await temporaryDataDir();
    onTestFinished(() => taken.close());
    const arming: PortArming = { candidates: [], handedOut: [], calls: 0 };
    await expect(
      startArmed(arming, { dataDir, port: taken.port, persistent: false })
    ).rejects.toThrow('could not bind IPv4 address "127.0.0.1"');
    expect(arming.calls).toBe(0);
    expect(fs.existsSync(dataDir)).toBe(false);
  }, 60_000);

  it("gives up after a few taken free ports", async () => {
    // 빈 port 후보가 계속 남에게 잡혀 있으면 정한 횟수만 다시 켜고 실패한다.
    const taken = await occupyPort();
    const arming: PortArming = {
      candidates: Array.from({ length: 6 }, () => taken.port),
      handedOut: [],
      calls: 0,
    };
    const dataDir = await temporaryDataDir();
    onTestFinished(() => taken.close());
    await expect(
      startArmed(arming, { dataDir, persistent: false })
    ).rejects.toThrow("embedded Postgres exited before it was ready");
    expect(arming.calls).toBe(5);
    expect(arming.handedOut).toEqual(
      Array.from({ length: 5 }, () => taken.port)
    );
  }, 60_000);
});
