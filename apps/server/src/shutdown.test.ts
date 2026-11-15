import { describe, expect, it } from "vitest";
import { closeStarted, type Started } from "./shutdown.ts";

// 서버 진입점(main.ts)의 정리 순서: 서버를 닫고 DB를 닫는다. 하나가 실패해도 나머지를 닫고, 실패는 알린 뒤 false로 돌려준다
// (진입점은 그때 1로 끝난다). 실제 서버·DB로는 닫기 실패를 결정적으로 만들 수 없어 이 경계에서 확인한다.
function resource(name: string, calls: string[], error?: Error) {
  return {
    close: async () => {
      calls.push(name);
      if (error) throw error;
    },
  };
}
function reporter() {
  const reports: [string, unknown][] = [];
  return {
    reports,
    report: (message: string, error: unknown) =>
      void reports.push([message, error]),
  };
}

describe("closeStarted", () => {
  it("closes the server and then the database", async () => {
    const calls: string[] = [];
    const { reports, report } = reporter();
    const ok = await closeStarted(
      Promise.resolve({
        server: resource("server", calls),
        handle: resource("database", calls),
      }),
      report
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(["server", "database"]);
    expect(reports).toEqual([]);
  });

  it("closes the database when the stop came before the server started", async () => {
    const calls: string[] = [];
    const { reports, report } = reporter();
    const ok = await closeStarted(
      Promise.resolve({ handle: resource("database", calls) }),
      report
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(["database"]);
    expect(reports).toEqual([]);
  });

  it("still closes the database when the server fails to close, and reports the failure", async () => {
    const calls: string[] = [];
    const { reports, report } = reporter();
    const error = new Error("server close failed");
    const ok = await closeStarted(
      Promise.resolve({
        server: resource("server", calls, error),
        handle: resource("database", calls),
      }),
      report
    );
    expect(ok).toBe(false);
    expect(calls).toEqual(["server", "database"]);
    expect(reports).toEqual([["[server] shutdown failed", error]]);
  });

  it("reports a database that fails to close", async () => {
    const calls: string[] = [];
    const { reports, report } = reporter();
    const error = new Error("database close failed");
    const ok = await closeStarted(
      Promise.resolve({
        server: resource("server", calls),
        handle: resource("database", calls, error),
      }),
      report
    );
    expect(ok).toBe(false);
    expect(calls).toEqual(["server", "database"]);
    expect(reports).toEqual([["[server] shutdown failed", error]]);
  });

  it("reports both failures when the server and the database fail to close", async () => {
    const calls: string[] = [];
    const { reports, report } = reporter();
    const serverError = new Error("server close failed");
    const databaseError = new Error("database close failed");
    const ok = await closeStarted(
      Promise.resolve({
        server: resource("server", calls, serverError),
        handle: resource("database", calls, databaseError),
      }),
      report
    );
    expect(ok).toBe(false);
    expect(calls).toEqual(["server", "database"]);
    expect(reports).toEqual([
      ["[server] shutdown failed", serverError],
      ["[server] shutdown failed", databaseError],
    ]);
  });

  // 정리 시한이 지나면 진입점이 어디서 멈췄는지 알린다. 서버를 닫는 중이면 서버가 알리는 진행(예: 기다리는 요청)을 붙인다.
  it("names the step it is on while closing", async () => {
    const { report } = reporter();
    let where = () => "";
    let releaseServer!: () => void;
    let releaseDatabase!: () => void;
    let serverClosing!: () => void;
    let databaseClosing!: () => void;
    const serverClosed = new Promise<void>(
      (resolve) => (releaseServer = resolve)
    );
    const databaseClosed = new Promise<void>(
      (resolve) => (releaseDatabase = resolve)
    );
    const atServer = new Promise<void>((resolve) => (serverClosing = resolve));
    const atDatabase = new Promise<void>(
      (resolve) => (databaseClosing = resolve)
    );
    let startup!: (started: Started) => void;
    const closing = closeStarted(
      new Promise<Started>((resolve) => (startup = resolve)),
      report,
      (describe) => (where = describe)
    );
    expect(where()).toBe("the start");
    startup({
      server: {
        close: () => (serverClosing(), serverClosed),
        progress: () => "waiting for requests: GET /api/inbox",
      },
      handle: { close: () => (databaseClosing(), databaseClosed) },
    });
    await atServer;
    expect(where()).toBe("the server (waiting for requests: GET /api/inbox)");
    releaseServer();
    await atDatabase;
    expect(where()).toBe("the database");
    releaseDatabase();
    expect(await closing).toBe(true);
  });

  it("reports a failed start and has nothing left to close", async () => {
    const { reports, report } = reporter();
    const error = new Error("start failed");
    const ok = await closeStarted(Promise.reject(error), report);
    expect(ok).toBe(false);
    expect(reports).toEqual([["[server] start failed", error]]);
  });
});
