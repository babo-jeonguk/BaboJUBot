import {
  eventStreamPath,
  streamFrameSchema,
  type Event,
  type StreamScope,
} from "@babojubot/contracts";
import { createTestDatabase, type TestDatabase } from "@babojubot/db/testing";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../src/index.ts";

export type Subscription = {
  /** 받은 Event frame. */
  events: Event[];
  /** 다음 Event를 기다린다. 이미 받은 것이 있으면 바로 돌려준다. */
  next: (timeoutMs?: number) => Promise<Event>;
  /** 잠시 기다린 뒤 이 구독이 Event를 하나도 받지 않았는지 확인한다. */
  expectNoEvents: (ms?: number) => Promise<void>;
  close: () => void;
};

export type TestServer = {
  baseUrl: string;
  db: TestDatabase["db"];
  request: (
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: any }>;
  /** 구독 준비(`ready`)까지 기다린 Event stream 연결. `origin`을 주면 브라우저처럼 Origin header를 보낸다. */
  subscribe: (
    scope: StreamScope,
    options?: { origin?: string }
  ) => Promise<Subscription>;
  close: () => Promise<void>;
};

/** 같은 프로세스에서 embedded Postgres와 서버를 띄우고 HTTP·Event stream으로만 검증한다. */
export async function startTestServer(): Promise<TestServer> {
  const database = await createTestDatabase();
  let server: RunningServer;
  try {
    server = await startServer({ db: database.db, port: 0 });
  } catch (error) {
    await database.close();
    throw error;
  }
  const sockets = new Set<WebSocket>();

  return {
    baseUrl: server.url,
    db: database.db,
    async request(method, path, body) {
      const res = await fetch(server.url + path, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
    subscribe(scope, { origin } = {}) {
      const query =
        scope.kind === "organization"
          ? `?organizationId=${encodeURIComponent(scope.organizationId)}`
          : "";
      const socket = new WebSocket(
        server.url.replace(/^http/, "ws") + eventStreamPath + query,
        { origin }
      );
      sockets.add(socket);
      const events: Event[] = [];
      let waiter: (() => void) | undefined;
      let taken = 0;
      return new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("unexpected-response", (_req, res) =>
          reject(new Error(`upgrade refused: ${res.statusCode}`))
        );
        socket.on("message", (data) => {
          const frame = streamFrameSchema.parse(JSON.parse(String(data)));
          if (frame.type === "ready") return resolve(subscription);
          events.push(frame.event);
          waiter?.();
        });
        const subscription: Subscription = {
          events,
          next(timeoutMs = 2_000) {
            return new Promise((ok, fail) => {
              const take = () => {
                if (taken >= events.length) return false;
                waiter = undefined;
                clearTimeout(timer);
                ok(events[taken++]!);
                return true;
              };
              const timer = setTimeout(
                () => fail(new Error("no Event arrived")),
                timeoutMs
              );
              if (!take()) waiter = take;
            });
          },
          async expectNoEvents(ms = 300) {
            await new Promise((r) => setTimeout(r, ms));
            if (events.length)
              throw new Error(`unexpected Event: ${JSON.stringify(events)}`);
          },
          close: () => socket.close(),
        };
      });
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await server.close();
      await database.close();
    },
  };
}
