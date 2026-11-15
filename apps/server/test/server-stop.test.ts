import { eventStreamPath } from "@babojubot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { goal, quietCreation } from "./scenarios.ts";
import { startTestServer, within, type TestServer } from "./support.ts";

/**
 * 서버 처리기 안의 DB 호출 하나를 멈춰 둔다. 걸어 둔 곳의 첫 호출만 멈추고, 풀면 실제 저장을 돌린 결과를 `done`에 남긴다.
 * 요청을 보낸 쪽이 먼저 떠나도 서버 처리기는 계속 돌므로, 서버를 끄는 동안 그 처리기가 DB를 쓰는 상황을 만든다.
 */
const held = vi.hoisted(() => {
  type At = "tool_read" | "organizations";
  type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  };
  const deferred = <T>() => {
    const parts = {} as Deferred<T>;
    parts.promise = new Promise<T>((resolve, reject) =>
      Object.assign(parts, { resolve, reject })
    );
    return parts;
  };
  type Held = {
    at: At;
    entered: Deferred<void>;
    release: Deferred<void>;
    done: Deferred<unknown>;
  };
  let current: Held | undefined;
  return {
    arm(at: At): Held {
      current = {
        at,
        entered: deferred(),
        release: deferred(),
        done: deferred(),
      };
      return current;
    },
    async around<T>(at: At, call: () => Promise<T>): Promise<T> {
      const hold = current;
      if (hold?.at !== at) return call();
      current = undefined;
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

/**
 * 처리기를 멈춰 둔 채 서버를 끈다. HTTP 단계가 시작한 뒤에도 끄기가 끝나지 않아야 하고,
 * 처리기를 풀면 그 저장이 열린 DB에서 끝난 뒤 끄기가 끝나야 한다.
 */
async function stopWhileHeld(t: TestServer, hold: ReturnType<typeof held.arm>) {
  const stream = await openEventStream(t.baseUrl);
  const errors = vi.spyOn(console, "error");
  let stopped = false;
  const stopping = t.stopServer().finally(() => {
    stopped = true;
  });
  await within(stream.closed, "the HTTP step of stopping");
  // 고치기 전의 끄기는 연결만 닫고 곧바로 끝난다. 그럴 틈을 주는 짧은 기다림이며, 고친 뒤에는 이 기다림으로 실패하지 않는다.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(stopped).toBe(false);
  hold.release.resolve();
  await within(stopping, "stopping the server");
  // 멈춰 둔 저장이 닫힌 DB를 만나면 여기서 그 오류로 실패한다.
  await hold.done.promise;
  expect(errors.mock.calls.filter(([tag]) => tag === "[server]")).toEqual([]);
}

describe("stopping the server", () => {
  let t: TestServer | undefined;
  afterEach(async () => {
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
    await within(read.entered.promise, "the Lead's context read");
    await stopWhileHeld(t, read);
  });

  it("waits for a user request whose client left before closing", async () => {
    t = await startTestServer();
    const list = held.arm("organizations");
    const client = new AbortController();
    const request = fetch(t.baseUrl + "/api/organizations", {
      signal: client.signal,
    }).then(
      () => "answered",
      () => "aborted"
    );
    await within(list.entered.promise, "listing organizations");
    client.abort();
    expect(await request).toBe("aborted");
    await stopWhileHeld(t, list);
  });
});
