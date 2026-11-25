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
    expect(reports).toEqual([["[server] closing the server failed", error]]);
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
    expect(reports).toEqual([["[server] closing the database failed", error]]);
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
    // 진단은 원인 코드만 남기므로(main.ts) 어느 닫기가 실패했는지는 문구가 가른다. 같은 코드여도 둘을 구분한다.
    expect(reports).toEqual([
      ["[server] closing the server failed", serverError],
      ["[server] closing the database failed", databaseError],
    ]);
  });

  // 정리 시한이 지나면 진입점이 어디서 멈췄는지 알린다. 서버·DB가 알리는 진행(예: 기다리는 요청, Postgres 정지)과
  // 지금 단계에 머문 시간, 앞 단계마다 걸린 시간을 붙인다.
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
    expect(where()).toMatch(/^the start for \d+\.\ds$/);
    startup({
      server: {
        close: () => (serverClosing(), serverClosed),
        progress: () => "waiting for requests: GET /api/inbox",
      },
      handle: {
        close: () => (databaseClosing(), databaseClosed),
        progress: () => "stopping Postgres (fast)",
      },
    });
    await atServer;
    expect(where()).toMatch(
      /^the server \(waiting for requests: GET \/api\/inbox\) for \d+\.\ds, after the start \d+\.\ds$/
    );
    releaseServer();
    await atDatabase;
    expect(where()).toMatch(
      /^the database \(stopping Postgres \(fast\)\) for \d+\.\ds, after the start \d+\.\ds, the server \d+\.\ds$/
    );
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
