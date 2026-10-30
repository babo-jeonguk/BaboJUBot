import {
  type NotificationChannel,
  eventStreamPath,
  streamFrameSchema,
  type Event,
  type RuntimeAdapter,
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
    body?: unknown,
    headers?: Record<string, string>
  ) => Promise<{ status: number; body: any }>;
  /** 실행 시도별 토큰으로 조직 도구를 부른다. */
  tool: (
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ status: number; body: any }>;
  /** 깨우기 대기열이 비고 실행 중인 실행 시도가 모두 끝날 때까지 기다린다. */
  drain: () => Promise<void>;
  /** 서버 시계의 지금 시각으로 지난 heartbeat를 처리한다. */
  tickHeartbeats: () => Promise<void>;
  /** 서버 시계의 지금 시각으로 보낼 차례인 알림을 모두 보내 본다. */
  deliverNotifications: () => Promise<void>;
  /** 서버(실행 중인 실행 시도 포함)만 멈추고 DB는 남긴다. */
  stopServer: () => Promise<void>;
  /** 구독 준비(`ready`)까지 기다린 Event stream 연결. `origin`을 주면 브라우저처럼 Origin header를 보낸다. */
  subscribe: (
    scope: StreamScope,
    options?: { origin?: string }
  ) => Promise<Subscription>;
  close: () => Promise<void>;
};

export type TestServerOptions = {
  /** 프로바이더 adapter. 기본은 가짜 프로바이더의 기본 시나리오다. */
  runtime?: RuntimeAdapter;
  /** 기록 시각에 쓰는 시계. */
  now?: () => Date;
  /** 알림을 보내고 답을 받는 채널. 기본은 가짜 채널이다. */
  notificationChannels?: NotificationChannel[];
  /** 하네스 라이브러리 디렉터리. 기본은 저장소의 `harness/`다. */
  harnessDir?: string;
};

/** 같은 프로세스에서 embedded Postgres와 서버를 띄우고 HTTP·Event stream으로만 검증한다. */
export async function startTestServer(
  options: TestServerOptions = {}
): Promise<TestServer> {
  const database = await createTestDatabase();
  let server: RunningServer;
  try {
    server = await startServer({ db: database.db, port: 0, ...options });
  } catch (error) {
    await database.close();
    throw error;
  }
  const sockets = new Set<WebSocket>();
  let serverStopped = false;

  const request: TestServer["request"] = async (
    method,
    path,
    body,
    headers = {}
  ) => {
    const res = await fetch(server.url + path, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  return {
    baseUrl: server.url,
    db: database.db,
    request,
    tool: (token, method, path, body) =>
      request(
        method,
        "/api/tools" + path,
        body,
        token === undefined ? {} : { authorization: `Bearer ${token}` }
      ),
    drain: () => server.drain(),
    tickHeartbeats: () => server.tickHeartbeats(),
    deliverNotifications: () => server.deliverNotifications(),
    async stopServer() {
      serverStopped = true;
      for (const socket of sockets) socket.terminate();
      await server.close();
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
      if (!serverStopped) await server.close();
      await database.close();
    },
  };
}
