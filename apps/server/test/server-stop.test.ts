import http from "node:http";
import { eventStreamPath } from "@babojubot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { goal, quietCreation } from "./scenarios.ts";
import {
  eventually,
  startTestServer,
  within,
  type TestServer,
} from "./support.ts";

/**
 * 서버 처리기 안의 DB 호출을 멈춰 둔다. 걸어 둔 곳마다 첫 호출만 멈추고, 풀면 실제 저장을 돌린 결과를 `done`에 남긴다.
 * 요청을 보낸 쪽이 먼저 떠나도 서버 처리기는 계속 돌므로, 서버를 끄는 동안 그 처리기가 DB를 쓰는 상황을 만든다.
 */
const held = vi.hoisted(() => {
  type At = "tool_read" | "organizations" | "inbox" | "channel_messages";
  type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  };
  const deferred = <T>(): Deferred<T> => {
    // Promise의 executor는 생성자 안에서 바로 돌므로 돌려주기 전에 둘 다 정해진다.
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  type Held = {
    entered: Deferred<void>;
    release: Deferred<void>;
    done: Deferred<unknown>;
  };
  const armed = new Map<At, Held>();
  const all = new Set<Held>();
  return {
    arm(at: At): Held {
      const hold = {
        entered: deferred<void>(),
        release: deferred<void>(),
        done: deferred<unknown>(),
      };
      armed.set(at, hold);
      all.add(hold);
      return hold;
    },
    /** 걸어 둔 것을 모두 풀고 지운다. 시험이 중간에 실패해도 멈춘 처리기가 남지 않게 한다. */
    releaseAll() {
      for (const hold of all) hold.release.resolve();
      all.clear();
      armed.clear();
    },
    async around<T>(at: At, call: () => Promise<T>): Promise<T> {
      const hold = armed.get(at);
      if (!hold) return call();
      armed.delete(at);
      hold.entered.resolve();
      await hold.release.promise;
      try {
        const value = await call();
        hold.done.resolve(value);
        return value;
      } catch (error) {
        hold.done.reject(error);
        throw error;
      }
    },
  };
});
vi.mock("@babojubot/db", async (original) => {
  const real = await original<typeof import("@babojubot/db")>();
  return {
    ...real,
    // 조직 도구 처리기가 읽기 도구의 요약을 실행 활동에 남기는 저장(CI에서 닫힌 DB를 쓴 곳).
    appendRunActivity: (...args: Parameters<typeof real.appendRunActivity>) =>
      args[2].activity.type === "org_tool"
        ? held.around("tool_read", () => real.appendRunActivity(...args))
        : real.appendRunActivity(...args),
    listOrganizations: (...args: Parameters<typeof real.listOrganizations>) =>
      held.around("organizations", () => real.listOrganizations(...args)),
    listInbox: (...args: Parameters<typeof real.listInbox>) =>
      held.around("inbox", () => real.listInbox(...args)),
    // 가짜 채널의 경로는 서버가 시작한 뒤(`channel.listen`) 등록된다.
    listFakeChannelMessages: (
      ...args: Parameters<typeof real.listFakeChannelMessages>
    ) =>
      held.around("channel_messages", () =>
        real.listFakeChannelMessages(...args)
      ),
  };
});

/** Event stream 연결. 서버를 끄는 HTTP 단계가 시작하면 서버가 이 연결을 끊는다. */
async function openEventStream(baseUrl: string) {
  const socket = new WebSocket(
    baseUrl.replace(/^http/, "ws") + eventStreamPath
  );
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve())
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { closed };
}

/** 요청을 보내고 곧바로 떠난다(실행 시도가 멈춰 도구 요청을 끊는 것과 같다). 서버 처리기가 멈춘 뒤에 떠난다. */
async function abandon(
  baseUrl: string,
  path: string,
  hold: ReturnType<typeof held.arm>
) {
  const client = new AbortController();
  const request = fetch(baseUrl + path, { signal: client.signal }).then(
    () => "answered",
    () => "aborted"
  );
  await within(
    hold.entered.promise,
    10_000,
    `the handler of ${path} did not finish`
  );
  client.abort();
  expect(await request).toBe("aborted");
}

/**
 * 처리기를 멈춰 둔 채 서버를 끈다. HTTP 단계가 시작하면 처리기를 풀고, 그 저장이 열린 DB에서 끝난 뒤에야
 * 끄기가 끝나는지 순서로 본다. 고치기 전의 끄기는 연결만 닫고 곧바로 끝나 저장보다 먼저 끝난다.
 */
async function stopWhileHeld(
  t: TestServer,
  hold: ReturnType<typeof held.arm>,
  waitingFor: string
) {
  const stream = await openEventStream(t.baseUrl);
  const errors = vi.spyOn(console, "error");
  const order: string[] = [];
  // 멈춰 둔 저장이 닫힌 DB를 만나면 `handled`가 그 오류로 실패한다.
  const handled = hold.done.promise.then(() => order.push("handled"));
  const stopping = t.stopServer().then(() => order.push("stopped"));
  try {
    await within(
      stream.closed,
      10_000,
      "the HTTP step of stopping did not finish"
    );
    // 정리 시한이 지나면 이 값이 무엇을 기다리다 멈췄는지 알린다.
    await vi.waitFor(
      () =>
        expect(t.stopProgress()).toBe(`waiting for requests: ${waitingFor}`),
      eventually
    );
  } finally {
    held.releaseAll();
  }
  await within(stopping, 10_000, "stopping the server did not finish");
  await within(handled, 10_000, "the held save did not finish");
  expect(order).toEqual(["handled", "stopped"]);
  expect(errors.mock.calls.filter(([tag]) => tag === "[server]")).toEqual([]);
}

/** 연결 하나를 다시 쓰는 GET. 응답 header와 재사용 여부를 돌려준다. */
function getOver(agent: http.Agent, url: string) {
  return new Promise<{ connection?: string; reused: boolean }>(
    (resolve, reject) => {
      const req = http.get(url, { agent }, (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            connection: res.headers.connection,
            reused: req.reusedSocket,
          })
        );
      });
      req.on("error", reject);
    }
  );
}

describe("stopping the server", () => {
  let t: TestServer | undefined;
  afterEach(async () => {
    held.releaseAll();
    vi.restoreAllMocks();
    await t?.close();
    t = undefined;
  });

  it("waits for a tool request the stopped run left behind before closing", async () => {
    const read = held.arm("tool_read");
    t = await startTestServer({ runtime: quietCreation() });
    const created = await t.request("POST", "/api/organizations", {
      name: "종료 대기 조직",
      ...goal,
    });
    expect(created.status).toBe(201);
    // 생성으로 깨어난 Lead가 맥락을 읽는 도구 요청. 끄기가 실행 시도를 멈추면 요청을 보낸 쪽이 먼저 떠난다.
    await within(
      read.entered.promise,
      10_000,
      "the Lead's context read did not finish"
    );
    await stopWhileHeld(t, read, "GET /api/tools/run-context");
  });

  it("waits for a user request whose client left before closing", async () => {
    t = await startTestServer();
    const list = held.arm("organizations");
    await abandon(t.baseUrl, "/api/organizations", list);
    await stopWhileHeld(t, list, "GET /api/organizations");
  });

  it("waits for a channel request registered after the server started", async () => {
    t = await startTestServer();
    const messages = held.arm("channel_messages");
    await abandon(t.baseUrl, "/api/channels/fake/messages", messages);
    await stopWhileHeld(t, messages, "GET /api/channels/fake/messages");
  });

  // 끄기를 시작할 때 처리 중이던 연결은 서버가 바로 닫지 않는다. 그 연결로 끄는 중에 들어온 요청은 처리하되
  // 응답 뒤 연결을 닫아, 같은 연결로 요청이 이어져 처리기 기다리기가 끝나지 않는 일이 없게 한다.
  it("closes a kept-alive connection after answering a request that arrived while stopping", async () => {
    t = await startTestServer();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const inbox = held.arm("inbox");
      const first = getOver(agent, t.baseUrl + "/api/inbox");
      await within(
        inbox.entered.promise,
        10_000,
        "the Inbox handler did not finish"
      );
      // 다른 처리기 하나를 더 멈춰 두어 끄기가 처리기를 기다리는 동안 이 연결로 다음 요청을 보낸다.
      const list = held.arm("organizations");
      await abandon(t.baseUrl, "/api/organizations", list);
      const stream = await openEventStream(t.baseUrl);
      const stopping = t.stopServer();
      try {
        await within(
          stream.closed,
          10_000,
          "the HTTP step of stopping did not finish"
        );
        inbox.release.resolve();
        await within(first, 10_000, "the Inbox answer did not finish");
        const second = await within(
          getOver(agent, t.baseUrl + "/api/health"),
          10_000,
          "the answer while stopping did not finish"
        );
        expect(second).toEqual({ connection: "close", reused: true });
      } finally {
        held.releaseAll();
      }
      await within(stopping, 10_000, "stopping the server did not finish");
    } finally {
      agent.destroy();
    }
  });
});
