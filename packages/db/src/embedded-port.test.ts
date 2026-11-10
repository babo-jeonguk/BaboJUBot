import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withClient } from "./client.ts";
import {
  clusterUrl,
  startEmbeddedCluster,
  type EmbeddedCluster,
} from "./embedded.ts";

// 테스트가 정한 후보 번호를 먼저 내주고, 목록이 비면 실제 candidatePort를 부른다.
const ports = vi.hoisted(() => ({
  candidates: [] as number[],
  calls: 0,
}));

vi.mock("./ports.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ports.ts")>();
  return {
    candidatePort: async () => {
      ports.calls++;
      return ports.candidates.shift() ?? actual.candidatePort();
    },
  };
});

beforeEach(() => {
  ports.candidates.length = 0;
  ports.calls = 0;
});

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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function temporaryDataDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
}

describe("embedded Postgres port", () => {
  it("starts on another port when the free port it picked is taken before Postgres binds it", async () => {
    // 번호만 미리 받은 사이 그 port를 남이 잡으면, Postgres는 다른 빈 port로 켜져야 한다.
    const taken = await occupyPort();
    ports.candidates.push(taken.port);
    const dataDir = await temporaryDataDir();
    let cluster: EmbeddedCluster | undefined;
    try {
      cluster = await startEmbeddedCluster({ dataDir, persistent: false });
      expect(cluster.port).not.toBe(taken.port);
      const { rows } = await withClient(
        clusterUrl(cluster.port, "postgres"),
        (client) =>
          client.query<{ data_directory: string }>("show data_directory")
      );
      expect(fs.realpathSync(rows[0]!.data_directory)).toBe(
        fs.realpathSync(dataDir)
      );
    } finally {
      await cluster?.stop();
      await taken.close();
    }
  }, 60_000);

  it("fails with the Postgres log instead of serving elsewhere when its configured port is taken", async () => {
    // 정한 port를 남이 잡았으면 그 port의 다른 프로그램에 붙지 않고 Postgres 로그와 함께 실패한다.
    const taken = await occupyPort();
    const dataDir = await temporaryDataDir();
    try {
      await expect(
        startEmbeddedCluster({ dataDir, port: taken.port, persistent: false })
      ).rejects.toThrow('could not bind IPv4 address "127.0.0.1"');
      expect(ports.calls).toBe(0);
      expect(fs.existsSync(dataDir)).toBe(false);
    } finally {
      await taken.close();
    }
  }, 60_000);

  it("gives up after a few taken free ports", async () => {
    // 빈 port 후보가 계속 남에게 잡혀 있으면 정한 횟수만 다시 켜고 실패한다.
    const taken = await occupyPort();
    ports.candidates.push(...Array.from({ length: 6 }, () => taken.port));
    const dataDir = await temporaryDataDir();
    try {
      await expect(
        startEmbeddedCluster({ dataDir, persistent: false })
      ).rejects.toThrow("embedded Postgres exited before it was ready");
      expect(ports.calls).toBe(5);
    } finally {
      await taken.close();
    }
  }, 60_000);
});
