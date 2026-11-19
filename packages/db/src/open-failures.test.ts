import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, withClient } from "./client.ts";
import { clusterUrl, startEmbeddedCluster } from "./embedded.ts";
import { candidatePort } from "./ports.ts";
import { testClusterPort } from "./testing.ts";

// DB를 여는 단계(cluster 시작 → DB 연결 → migration)와 닫는 단계에서 실패를 일부러 일으킨다. cluster는 시험 실행이 띄운
// 공용 cluster(globalSetup)를 가리키는 가짜로 바꿔 정지 횟수와 정지 실패를 시험이 정한다.
vi.mock("./embedded.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedded.ts")>()),
  startEmbeddedCluster: vi.fn(),
}));
vi.mock("drizzle-orm/node-postgres/migrator", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("drizzle-orm/node-postgres/migrator")>();
  return { ...real, migrate: vi.fn(real.migrate) };
});
const { migrate } = await import("drizzle-orm/node-postgres/migrator");

/** 정지를 세는 가짜 cluster. `stopFails`면 정지가 그 오류로 실패한다. */
function fakeCluster(port: number, stopFails?: Error) {
  const stop = vi.fn(async () => {
    if (stopFails) throw stopFails;
  });
  vi.mocked(startEmbeddedCluster).mockResolvedValueOnce({
    port,
    stop,
    stopping: () => "stopping Postgres",
  });
  return stop;
}

/** console.error·warn으로 남긴 값들. 정리 실패가 원래 오류와 따로 기록됐는지 본다. */
function logged() {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => [...error.mock.calls, ...warn.mock.calls].flat();
}

const embedded = { embedded: { dataDir: "unused", persistent: true } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opening a database that fails", () => {
  it("passes the start error through without stopping anything", async () => {
    const startError = new Error("injected: Postgres did not start");
    vi.mocked(startEmbeddedCluster).mockRejectedValueOnce(startError);

    await expect(openDatabase(embedded)).rejects.toBe(startError);
  });

  it("throws the connection error and stops Postgres once", async () => {
    const stop = fakeCluster(await candidatePort());

    await expect(openDatabase(embedded)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection error and records the stop failure when stopping Postgres also fails", async () => {
    const stopError = new Error("injected: Postgres did not stop");
    const stop = fakeCluster(await candidatePort(), stopError);
    const logs = logged();

    await expect(openDatabase(embedded)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logs()).toContain(stopError);
  });

  it("throws the migration error and stops Postgres once", async () => {
    const migrationError = new Error("injected: migration failed");
    vi.mocked(migrate).mockRejectedValueOnce(migrationError);
    const stop = fakeCluster(testClusterPort());

    await expect(openDatabase(embedded)).rejects.toBe(migrationError);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the migration error and records the stop failure when stopping Postgres also fails", async () => {
    const migrationError = new Error("injected: migration failed");
    vi.mocked(migrate).mockRejectedValueOnce(migrationError);
    const stopError = new Error("injected: Postgres did not stop");
    const stop = fakeCluster(testClusterPort(), stopError);
    const logs = logged();

    await expect(openDatabase(embedded)).rejects.toBe(migrationError);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logs()).toContain(stopError);
  });
});

describe("closing a database that fails", () => {
  it("still stops Postgres when closing the connections fails, and reports both failures", async () => {
    vi.mocked(migrate).mockResolvedValueOnce(undefined);
    const stopError = new Error("injected: Postgres did not stop");
    const stop = fakeCluster(testClusterPort(), stopError);
    const handle = await openDatabase(embedded);
    const poolError = new Error("injected: closing the connections failed");
    // 제품은 Promise를 돌려주는 end()만 부른다. 콜백 판(end(cb): void)은 빼고 그 판만 바꾼다.
    const pools: { end(this: pg.Pool): Promise<void> } = pg.Pool.prototype;
    const end = pools.end;
    vi.spyOn(pools, "end").mockImplementationOnce(async function (
      this: pg.Pool
    ) {
      await end.call(this);
      throw poolError;
    });

    const closing = handle.close();

    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    await expect(closing).rejects.toMatchObject({
      errors: [poolError, stopError],
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("a one-off connection that fails", () => {
  it("keeps the work's error and records the close failure", async () => {
    const workError = new Error("injected: the work failed");
    const closeError = new Error("injected: closing the connection failed");
    // 제품은 Promise를 돌려주는 end()만 부른다. 콜백 판(end(cb): void)은 빼고 그 판만 바꾼다.
    const clients: { end(this: pg.Client): Promise<void> } =
      pg.Client.prototype;
    const end = clients.end;
    vi.spyOn(clients, "end").mockImplementationOnce(async function (
      this: pg.Client
    ) {
      await end.call(this);
      throw closeError;
    });
    const logs = logged();

    await expect(
      withClient(clusterUrl(testClusterPort(), "postgres"), async () => {
        throw workError;
      })
    ).rejects.toBe(workError);
    expect(logs()).toContain(closeError);
  });
});
