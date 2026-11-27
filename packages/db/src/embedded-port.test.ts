import fs from "node:fs";
import net from "node:net";
import { callArming } from "@babojubot/process/call-arming";
import {
  ownedListener,
  releaseAcquired,
} from "@babojubot/process/test-cleanup";
import { testFolders } from "@babojubot/process/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { withClient } from "./client.ts";
import { clusterUrl, startEmbeddedCluster } from "./embedded.ts";

/**
 * 시험이 정한 후보 번호(`candidates`)를 먼저 내주고, 목록이 비면 실제 candidatePort를 부른다. 번호를 고르는 호출은 인수가 없어 시험의
 * 대상으로 가를 수 없으므로, 시험은 cluster 시작을 `portCalls.run(무장, () => 시작, onTestFinished)`로 감싼다. 대역은 불린 순간 그
 * 호출의 무장을 잡는다: 다른 시험의 늦은 시작이나 감싸지 않은 호출은 시험이 정한 번호를 꺼내지 않는다(#286). `picked`는 그 호출이
 * 고른 번호를 고른 차례대로 모두(시험의 번호와 실제로 고른 번호) 남긴다.
 */
type PortArming = { candidates: number[]; picked: number[] };
const portCalls = callArming<PortArming>();

vi.mock("./ports.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ports.ts")>();
  return {
    candidatePort: async () => {
      const arming = portCalls.current();
      if (!arming) return actual.candidatePort();
      const next = arming.candidates.shift() ?? (await actual.candidatePort());
      arming.picked.push(next);
      return next;
    },
  };
});

/** 시험의 dataDir와 그 안에서 도는 cluster. cluster는 폴더를 지우기 전에 멈춘다. */
const folders = testFolders();

/**
 * 시험이 정한 후보 번호로 무장한 채 cluster를 시작한다. 무장의 끝과 cluster 멈춤은 시작하는 순간 폴더 정리에 맡긴다(시작이 끝나면
 * 멈추고, 실패했으면 멈출 것이 없다).
 */
function startArmed(
  arming: PortArming,
  options: Parameters<typeof startEmbeddedCluster>[0]
) {
  const starting = portCalls.run(
    arming,
    () => startEmbeddedCluster(options),
    (end) => folders.ownArming(end)
  );
  folders.own(
    () => releaseAcquired(starting, (cluster) => cluster.stop()),
    "the embedded cluster"
  );
  return starting;
}

/** 127.0.0.1의 port 하나를 잡고 있는 server. 닫기는 듣기 전에 시험 정리에 맡긴다. */
async function occupyPort() {
  const { server } = await ownedListener(
    net.createServer(),
    { port: 0, host: "127.0.0.1" },
    onTestFinished,
    "the port-taking server"
  );
  return { port: (server.address() as net.AddressInfo).port };
}

const temporaryDataDir = () => folders.make("babojubot-pg-");

describe("embedded Postgres port", () => {
  it("starts on another port when the free port it picked is taken before Postgres binds it", async () => {
    // 번호만 미리 받은 사이 그 port를 남이 잡으면, Postgres는 다른 빈 port로 켜져야 한다.
    const taken = await occupyPort();
    const arming: PortArming = { candidates: [taken.port], picked: [] };
    const dataDir = await temporaryDataDir();
    const cluster = await startArmed(arming, { dataDir, persistent: false });
    expect(cluster.port).not.toBe(taken.port);
    // 시험의 번호를 이 시작이 처음 받았고, 그 번호가 막혀 다시 고른 번호(마지막)에 켜졌다. 그 사이 실제로 고른 번호를 남이 잡았으면
    // 한 번 더 골랐을 수 있어 가운데는 정하지 않는다.
    expect(arming.picked[0]).toBe(taken.port);
    expect(arming.picked.at(-1)).toBe(cluster.port);
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
    const arming: PortArming = { candidates: [], picked: [] };
    await expect(
      startArmed(arming, { dataDir, port: taken.port, persistent: false })
    ).rejects.toThrow('could not bind IPv4 address "127.0.0.1"');
    expect(arming.picked).toEqual([]);
    expect(fs.existsSync(dataDir)).toBe(false);
  }, 60_000);

  it("gives up after a few taken free ports", async () => {
    // 빈 port 후보가 계속 남에게 잡혀 있으면 정한 횟수만 다시 켜고 실패한다.
    const taken = await occupyPort();
    const arming: PortArming = {
      candidates: Array.from({ length: 6 }, () => taken.port),
      picked: [],
    };
    const dataDir = await temporaryDataDir();
    await expect(
      startArmed(arming, { dataDir, persistent: false })
    ).rejects.toThrow("embedded Postgres exited before it was ready");
    expect(arming.picked).toEqual(Array.from({ length: 5 }, () => taken.port));
  }, 60_000);
});
