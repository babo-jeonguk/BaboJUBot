import {
  onlineManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveRefresh } from "./live-refresh.ts";

/**
 * 조회 하나의 가짜 서버. 응답 내용(`version`)은 요청이 시작될 때 고정되고, 응답은 `release`로 하나씩 돌려준다.
 * 요청 전에 기다렸다가 최신 값을 읽으면 trailing 유실을 놓치므로 시작 시점 snapshot을 쓴다.
 */
function fakeServer() {
  const gates: { settle: () => void; fail: () => void }[] = [];
  const server = {
    version: 0,
    calls: 0,
    running: 0,
    maxRunning: 0,
    queryFn: () => {
      const snapshot = server.version;
      server.calls++;
      server.running++;
      server.maxRunning = Math.max(server.maxRunning, server.running);
      return new Promise<number>((resolve, reject) =>
        gates.push({
          settle: () => {
            server.running--;
            resolve(snapshot);
          },
          fail: () => {
            server.running--;
            reject(new Error("server error"));
          },
        })
      );
    },
    /** 가장 오래 기다린 요청에 응답한다. */
    async release(ok = true) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      const gate = gates.shift()!;
      if (ok) gate.settle();
      else gate.fail();
      await flush();
    },
    pending: () => gates.length,
  };
  return server;
}

/** Query의 알림(setTimeout 0 일괄 처리)과 Promise 연쇄가 끝나기를 기다린다. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

let client: QueryClient;
let cleanups: (() => void)[];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 온라인 복귀 때 멈춘 조회를 이어가려면 앱처럼 client가 mount돼 있어야 한다.
  client.mount();
  cleanups = [];
});

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  client.clear();
  client.unmount();
  onlineManager.setOnline(true);
});

/** 화면이 조회를 보고 있는 상태(active observer)를 만든다. 첫 조회가 바로 시작된다. */
function observe(queryKey: readonly unknown[], queryFn: () => Promise<number>) {
  const observer = new QueryObserver(client, { queryKey, queryFn });
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(unsubscribe);
  return unsubscribe;
}

function startLiveRefresh() {
  const live = createLiveRefresh(client);
  cleanups.push(live.dispose);
  return live;
}

const data = (queryKey: readonly unknown[]) => client.getQueryData(queryKey);

describe("live refresh", () => {
  test("a burst of signals during a slow refetch keeps one request in flight, shows that response and then fetches the state after the last signal", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await server.release();
    expect(data(key)).toBe(0);
    const live = startLiveRefresh();

    server.version = 1;
    live.refresh({ queryKey: key });
    await flush();
    for (let v = 2; v <= 10; v++) {
      server.version = v;
      live.refresh({ queryKey: key });
    }
    await flush();
    expect(server.running).toBe(1);

    await server.release();
    expect(data(key)).toBe(1);
    await server.release();
    expect(data(key)).toBe(10);
    expect(server.pending()).toBe(0);
    expect(server.calls).toBe(3);
    expect(server.maxRunning).toBe(1);
  });

  test("a signal that arrives while an earlier fetch is already running fetches again after it ends", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await server.release();
    // 화면 이동·focus 등으로 Event 이전에 시작된 조회.
    void client.refetchQueries({ queryKey: key });
    await flush();
    const live = startLiveRefresh();

    server.version = 1;
    live.refresh({ queryKey: key });
    await flush();
    expect(server.running).toBe(1);
    await server.release();
    expect(data(key)).toBe(0);
    await server.release();
    expect(data(key)).toBe(1);
    expect(server.maxRunning).toBe(1);
  });

  test("a signal during the first load without cached data fetches again after it", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await flush();
    const live = startLiveRefresh();

    server.version = 1;
    live.refresh();
    await flush();
    await server.release();
    expect(data(key)).toBe(0);
    await server.release();
    expect(data(key)).toBe(1);
    expect(server.maxRunning).toBe(1);
  });

  test("while signals keep coming every completed response is shown before they stop", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await server.release();
    const live = startLiveRefresh();

    for (let v = 1; v <= 4; v++) {
      server.version = v;
      live.refresh({ queryKey: key });
      await flush();
      if (v > 1) {
        await server.release();
        expect(data(key)).toBe(v - 1);
      }
    }
    await server.release();
    expect(data(key)).toBe(4);
    expect(server.maxRunning).toBe(1);
  });

  test("overlapping full, prefix and exact signals for the same query run one fetch and one follow-up", async () => {
    const orgServer = fakeServer();
    const listServer = fakeServer();
    const org = ["organizations", "a"];
    const orgs = ["organizations"];
    observe(org, orgServer.queryFn);
    observe(orgs, listServer.queryFn);
    await orgServer.release();
    await listServer.release();
    const live = startLiveRefresh();

    live.refresh();
    live.refresh({ queryKey: orgs, exact: true });
    live.refresh({ queryKey: org });
    live.refresh({ queryKey: orgs, exact: true });
    live.refresh({ queryKey: org });
    await flush();
    expect(orgServer.running + listServer.running).toBe(2);
    await orgServer.release();
    await listServer.release();
    await orgServer.release();
    await listServer.release();
    await flush();
    expect(orgServer.calls).toBe(3);
    expect(listServer.calls).toBe(3);
    expect(orgServer.pending() + listServer.pending()).toBe(0);
    expect(orgServer.maxRunning + listServer.maxRunning).toBe(2);
  });

  test("a slow query of one organization does not hold back another organization", async () => {
    const a = fakeServer();
    const b = fakeServer();
    observe(["organizations", "a"], a.queryFn);
    observe(["organizations", "b"], b.queryFn);
    await a.release();
    await b.release();
    const live = startLiveRefresh();

    a.version = 1;
    live.refresh({ queryKey: ["organizations", "a"] });
    b.version = 1;
    live.refresh({ queryKey: ["organizations", "b"] });
    await flush();
    await b.release();
    expect(data(["organizations", "b"])).toBe(1);
    expect(data(["organizations", "a"])).toBe(0);
    await a.release();
    expect(data(["organizations", "a"])).toBe(1);
  });

  test("a failed fetch releases the query and a signal that came during it still fetches again", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await server.release();
    const live = startLiveRefresh();

    live.refresh({ queryKey: key });
    await flush();
    server.version = 2;
    live.refresh({ queryKey: key });
    await server.release(false);
    expect(client.getQueryState(key)?.status).toBe("error");
    await server.release();
    expect(data(key)).toBe(2);
    expect(client.getQueryState(key)?.status).toBe("success");

    // 오류 뒤에도 다음 신호를 받는다.
    server.version = 3;
    live.refresh({ queryKey: key });
    await server.release();
    expect(data(key)).toBe(3);
  });

  test("a query no screen is watching is only marked stale", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    await client.prefetchQuery({
      queryKey: key,
      queryFn: () => Promise.resolve(0),
    });
    client.setQueryDefaults(key, { queryFn: server.queryFn });
    const live = startLiveRefresh();

    live.refresh({ queryKey: key });
    await flush();
    expect(server.calls).toBe(0);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  test("while offline a signal waits for the paused fetch and gets the latest state once back online", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await server.release();
    const live = startLiveRefresh();

    onlineManager.setOnline(false);
    server.version = 1;
    live.refresh({ queryKey: key });
    await flush();
    server.version = 2;
    live.refresh({ queryKey: key });
    await flush();
    expect(server.calls).toBe(1);
    expect(client.getQueryState(key)?.fetchStatus).toBe("paused");

    onlineManager.setOnline(true);
    await server.release();
    expect(data(key)).toBe(2);
    // 멈춘 동안 온 두 번째 신호는 요청이 실제로 나갔는지 알 수 없으므로 한 번 더 확인한다.
    await server.release();
    expect(data(key)).toBe(2);
    await flush();
    expect(server.pending()).toBe(0);
    expect(server.maxRunning).toBe(1);
  });

  test("a mutation that refetches over a running refresh still ends on the state after the last signal", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await server.release();
    const live = startLiveRefresh();

    server.version = 1;
    live.refresh({ queryKey: key });
    await flush();
    // mutation 성공의 직접 갱신은 기본값대로 진행 중 조회를 취소하고 새로 시작한다.
    server.version = 2;
    void client.invalidateQueries({ queryKey: key });
    await flush();
    server.version = 3;
    live.refresh({ queryKey: key });
    await server.release();
    await server.release();
    expect(data(key)).toBe(2);
    await server.release();
    expect(data(key)).toBe(3);
    expect(server.pending()).toBe(0);
  });

  test("a query that loses its screen during a fetch is marked stale after that fetch ends", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    const leave = observe(key, server.queryFn);
    await server.release();
    void client.refetchQueries({ queryKey: key });
    await flush();
    leave();
    const live = startLiveRefresh();

    live.refresh({ queryKey: key });
    await server.release();
    expect(server.calls).toBe(2);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  test("after dispose a running fetch's completion starts nothing new", async () => {
    const server = fakeServer();
    const key = ["organizations", "a"];
    observe(key, server.queryFn);
    await server.release();
    const live = startLiveRefresh();

    live.refresh({ queryKey: key });
    await flush();
    live.refresh({ queryKey: key });
    live.dispose();
    live.refresh({ queryKey: key });
    await server.release();
    await flush();
    expect(server.calls).toBe(2);
    expect(server.pending()).toBe(0);
  });
});
