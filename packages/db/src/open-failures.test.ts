import { callArming } from "@babojubot/process/call-arming";
import { ownedListener } from "@babojubot/process/test-cleanup";
import net from "node:net";
import type pg from "pg";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { openDatabase, withClient } from "./client.ts";
import { clusterUrl, type EmbeddedCluster } from "./embedded.ts";
import { testClusterPort } from "./testing.ts";

// DB를 여는 단계(cluster 시작 → DB 연결 → migration)와 닫는 단계에서 실패를 일부러 일으킨다. cluster는 시험 실행이 띄운
// 공용 cluster(globalSetup)를 가리키는 가짜로 바꿔 정지 횟수와 정지 실패를 시험이 정한다.

/**
 * 한 시험이 일으키는 결함. 시험은 제품 호출을 `faultCalls.run(결함, () => 제품 호출, onTestFinished)`로 감싸고, 대역은 불린 순간 그
 * 호출의 결함을 잡는다. 감싸지 않은 호출과 다른 시험의 호출에는 결함이 없다(#286). 결함이 실패시킨 대상은 `failedAt`에 남는다.
 */
type Fault = {
  /** cluster 시작이 이 오류로 실패하거나 이 가짜 cluster를 돌려준다. 없으면 시작을 거절한다(진짜 cluster를 띄우지 않는다). */
  start?: Error | EmbeddedCluster;
  /** migration이 이 오류로 실패하거나("skip"이면) 건너뛴다. 없으면 진짜 migration을 한다. */
  migration?: Error | "skip";
  /** pool 닫기(`pg.Pool#end`)가 실제로 닫은 뒤 이 오류로 실패한다. */
  poolEndFails?: Error;
  /** 연결 하나 닫기(`pg.Client#end`)가 실제로 닫은 뒤 이 오류로 실패한다. */
  clientEndFails?: Error;
  failedAt: unknown[];
};
const faultCalls = callArming<Fault>();

vi.mock("./embedded.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./embedded.ts")>();
  const startEmbeddedCluster: typeof real.startEmbeddedCluster = async ({
    dataDir,
  }) => {
    const fault = faultCalls.current();
    if (fault?.start === undefined)
      throw new Error(
        "startEmbeddedCluster was called outside a test's fault arming"
      );
    if (!(fault.start instanceof Error)) return fault.start;
    fault.failedAt.push(`start ${dataDir}`);
    throw fault.start;
  };
  return { ...real, startEmbeddedCluster };
});
vi.mock("drizzle-orm/node-postgres/migrator", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("drizzle-orm/node-postgres/migrator")>();
  // 결함이 실패시킨 migration은 그 호출 하나라(무장이 고름) 기록은 "migrate"로 남긴다.
  const migrate: typeof real.migrate = async (db, config) => {
    const fault = faultCalls.current();
    if (fault?.migration === "skip") return;
    if (fault?.migration) {
      fault.failedAt.push("migrate");
      throw fault.migration;
    }
    return real.migrate(db, config);
  };
  return { ...real, migrate };
});

vi.mock("pg", async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof pg }>()).default;
  // 제품이 만드는 pool·연결만 이 하위 클래스다. 무장한 호출에서 닫기(`end`)가 실제로 닫은 뒤 그 결함으로 실패하고, 그 밖의 닫기와 다른
  // 인스턴스는 그대로다. 제품은 Promise를 돌려주는 `end()`만 부르고, 콜백 판(`end(cb)`)은 그대로 넘긴다.
  class Pool extends real.Pool {
    override end(): Promise<void>;
    override end(callback: () => void): void;
    override end(callback?: () => void): Promise<void> | void {
      if (callback) return super.end(callback);
      const fault = faultCalls.current();
      const ending = super.end();
      const failure = fault?.poolEndFails;
      if (!fault || !failure) return ending;
      const target = `pool end ${String(this.options.connectionString)}`;
      return ending.then(() => {
        fault.failedAt.push(target);
        throw failure;
      });
    }
  }
  class Client extends real.Client {
    override end(): Promise<void>;
    override end(callback: (error: Error) => void): void;
    override end(callback?: (error: Error) => void): Promise<void> | void {
      if (callback) return super.end(callback);
      const fault = faultCalls.current();
      const ending = super.end();
      const failure = fault?.clientEndFails;
      if (!fault || !failure) return ending;
      return ending.then(() => {
        fault.failedAt.push(this);
        throw failure;
      });
    }
  }
  return { ...real, Pool, Client, default: { ...real, Pool, Client } };
});

/** 정지를 세는 가짜 cluster. `stopFails`면 정지가 그 오류로 실패하고 `failedAt`에 `stop <port>`를 남긴다. */
function fakeCluster(failedAt: unknown[], port: number, stopFails?: Error) {
  const stop = vi.fn(async () => {
    if (!stopFails) return;
    failedAt.push(`stop ${port}`);
    throw stopFails;
  });
  return { port, stop, stopping: () => "stopping Postgres" };
}

/**
 * 받은 연결을 첫 내용을 받자마자 끊는(RST) listener를 이 시험이 열어 소유한다(닫기는 듣기 시작 전에 정리에 맡긴다). 연결 실패의 대상은 이 시험의
 * 이 포트이고, 받은 연결이 닿은 포트는 `dropped`에 남는다. 닫힌 빈 포트를 빌려 쓰면 그 사이 남이 그 번호를 잡을 수 있다(#286).
 */
async function droppingListener() {
  const dropped: (number | undefined)[] = [];
  const { server } = await ownedListener(
    // 연결의 첫 내용(시작 메시지)을 받은 뒤 끊는다. 쓰기 전에 끊기면 실패가 쓰기(EPIPE)로 날 수 있어 읽기의 실패(ECONNRESET)로 고정한다.
    net.createServer((socket) =>
      socket.once("data", () => {
        dropped.push(socket.localPort);
        socket.resetAndDestroy();
      })
    ),
    { port: 0, host: "127.0.0.1" },
    onTestFinished,
    "the connection-dropping listener"
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the connection-dropping listener has no port");
  return { port: address.port, dropped };
}

/** `fault`를 무장한 채 DB를 연다. */
function opened(fault: Fault) {
  return faultCalls.run(fault, () => openDatabase(embedded), onTestFinished);
}

/** console.error·warn으로 남긴 값들. 정리 실패가 원래 오류와 따로 기록됐는지 본다. */
function logged() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => [...error.mock.calls, ...warn.mock.calls].flat();
}

/** 진단은 오류 문구·객체 대신 원인 코드로 남는다(#286, failureCode). 남긴 줄에 그 코드가 있고, 오류 객체는 남기지 않는다. */
function expectLoggedCode(values: unknown[], code: string) {
  expect(values.filter((value) => value instanceof Error)).toEqual([]);
  expect(values).toContainEqual(expect.stringContaining(`(${code})`));
}

const embedded = { embedded: { dataDir: "unused", persistent: true } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opening a database that fails", () => {
  it("passes the start error through without stopping anything", async () => {
    const startError = new Error("injected: Postgres did not start");
    const fault: Fault = { start: startError, failedAt: [] };

    await expect(opened(fault)).rejects.toBe(startError);
    expect(fault.failedAt).toEqual([`start ${embedded.embedded.dataDir}`]);
  });

  it("throws the connection error and stops Postgres once", async () => {
    const failedAt: unknown[] = [];
    const listener = await droppingListener();
    const cluster = fakeCluster(failedAt, listener.port);

    await expect(opened({ start: cluster, failedAt })).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect(listener.dropped).toEqual([listener.port]);
    expect(cluster.stop).toHaveBeenCalledTimes(1);
    expect(failedAt).toEqual([]);
  });

  it("keeps the connection error and records the stop failure when stopping Postgres also fails", async () => {
    const stopError = Object.assign(
      new Error("injected: Postgres did not stop"),
      { code: "EMBEDDED_STOP_TIMEOUT" }
    );
    const failedAt: unknown[] = [];
    const listener = await droppingListener();
    const cluster = fakeCluster(failedAt, listener.port, stopError);
    const logs = logged();

    await expect(opened({ start: cluster, failedAt })).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect(listener.dropped).toEqual([listener.port]);
    expect(cluster.stop).toHaveBeenCalledTimes(1);
    expect(failedAt).toEqual([`stop ${cluster.port}`]);
    expectLoggedCode(logs(), "EMBEDDED_STOP_TIMEOUT");
  });

  it("throws the migration error and stops Postgres once", async () => {
    const migrationError = new Error("injected: migration failed");
    const failedAt: unknown[] = [];
    const cluster = fakeCluster(failedAt, testClusterPort());

    await expect(
      opened({ start: cluster, migration: migrationError, failedAt })
    ).rejects.toBe(migrationError);
    expect(cluster.stop).toHaveBeenCalledTimes(1);
    expect(failedAt).toEqual(["migrate"]);
  });

  it("keeps the migration error and records the stop failure when stopping Postgres also fails", async () => {
    const migrationError = new Error("injected: migration failed");
    const stopError = Object.assign(
      new Error("injected: Postgres did not stop"),
      { code: "EMBEDDED_STOP_TIMEOUT" }
    );
    const failedAt: unknown[] = [];
    const cluster = fakeCluster(failedAt, testClusterPort(), stopError);
    const logs = logged();

    await expect(
      opened({ start: cluster, migration: migrationError, failedAt })
    ).rejects.toBe(migrationError);
    expect(cluster.stop).toHaveBeenCalledTimes(1);
    expect(failedAt).toEqual(["migrate", `stop ${cluster.port}`]);
    expectLoggedCode(logs(), "EMBEDDED_STOP_TIMEOUT");
  });
});

describe("closing a database that fails", () => {
  it("still stops Postgres when closing the connections fails, and reports both failures", async () => {
    const stopError = Object.assign(
      new Error("injected: Postgres did not stop"),
      { code: "EMBEDDED_STOP_TIMEOUT" }
    );
    const poolError = new Error("injected: closing the connections failed");
    const failedAt: unknown[] = [];
    const cluster = fakeCluster(failedAt, testClusterPort(), stopError);
    const fault: Fault = {
      start: cluster,
      migration: "skip",
      poolEndFails: poolError,
      failedAt,
    };
    const handle = await opened(fault);

    const closing = faultCalls.run(fault, () => handle.close(), onTestFinished);

    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    await expect(closing).rejects.toMatchObject({
      errors: [poolError, stopError],
    });
    expect(cluster.stop).toHaveBeenCalledTimes(1);
    expect(failedAt).toEqual([
      `pool end ${handle.url}`,
      `stop ${cluster.port}`,
    ]);
  });
});

describe("a one-off connection that fails", () => {
  it("keeps the work's error and records the close failure", async () => {
    const workError = new Error("injected: the work failed");
    const closeError = Object.assign(
      new Error("injected: closing the connection failed"),
      { code: "ECONNRESET" }
    );
    const fault: Fault = { clientEndFails: closeError, failedAt: [] };
    const used: pg.Client[] = [];
    const logs = logged();

    await expect(
      faultCalls.run(
        fault,
        () =>
          withClient(
            clusterUrl(testClusterPort(), "postgres"),
            async (client) => {
              used.push(client);
              throw workError;
            }
          ),
        onTestFinished
      )
    ).rejects.toBe(workError);
    expect(fault.failedAt).toEqual(used);
    expect(used).toHaveLength(1);
    expectLoggedCode(logs(), "ECONNRESET");
  });
});
