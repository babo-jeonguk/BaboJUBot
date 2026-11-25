import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attemptAll,
  attemptEach,
  combinedFailure,
  eventStreamPath,
  streamFrameSchema,
  type Event,
  type NotificationChannel,
  type ProviderConnection,
  type RuntimeAdapter,
  type StreamScope,
} from "@babojubot/contracts";
import { createTestDatabase, type TestDatabase } from "@babojubot/db/testing";
import { vi } from "vitest";
import { within } from "@babojubot/process/test-support";
import WebSocket from "ws";
import {
  startServer,
  type RunningServer,
  type ServerOptions,
} from "../src/index.ts";
import { removeFolder } from "@babojubot/process/remove-folder";
import { folderCleanup } from "@babojubot/process/test-cleanup";

/**
 * 서버 작업·Event·준비 확인처럼 끝나는 신호가 오는 대기의 상한(#215). 신호가 오면 바로 끝나므로 넉넉해도 통과 시간은
 * 늘지 않는다. 느린 실행기(Windows 2 vCPU)에서는 서버 작업 하나가 기본 1~2초를 넘길 수 있어 그것을 감당하는 값이다.
 */
export const eventuallyMs = 15_000;
export const eventually = { timeout: eventuallyMs };
/**
 * 서버 시작의 준비 확인이 끝나기를 기다리는 상한. 제품의 준비 확인은 격리 안전 확인 시한(60초, `src/isolation.ts`)과
 * 연결 확인 시한(30초, `src/readiness.ts`) 안에 끝나므로 그 합(90초)에 여유를 둔다. 이보다 짧으면 제품이 정한 시한 안의
 * 느린 확인을 시험이 실패로 바꾼다. 시험 시한(120초, `vitest.config.ts`)보다는 짧아, 시한에 걸리기 전에 무엇을 기다리다
 * 실패했는지 알린다. 검사가 기다리는 신호의 상한(`eventuallyMs`)과 따로 두는 것은 이 대기가 검사가 아닌 공용 준비라서다.
 */
export const readinessSettleMs = 100_000;

export type Subscription = {
  /** 받은 Event frame. */
  events: Event[];
  /** 다음 Event를 기다린다. 이미 받은 것이 있으면 바로 돌려준다. 기본 상한은 `eventuallyMs`다. */
  next: (timeoutMs?: number) => Promise<Event>;
  /**
   * 이 구독이 받은 Event가 `since`개(기본 0)에서 늘지 않았는지 확인한다. 시간을 재지 않고 순서 표시를 쓴다: 이 연결로
   * ping을 보내 pong을 받으면, 서버가 그 전에 이 연결로 보낸 Event는 모두 받은 것이다(한 연결의 frame은 보낸 순서로 온다).
   * 서버는 요청의 Event를 응답 전에 보내므로(commit 뒤 할 일), 끝난 요청이 남긴 Event는 빠짐없이 본다.
   * 한계: 응답 뒤에 따로 도는 일(실행 시도 등)이 나중에 남길 Event는 보지 못한다. 그런 일은 그 끝(`drain` 등)을 먼저 기다린다.
   */
  expectNoEvents: (since?: number) => Promise<void>;
  /** 받은 전역 설정 변경 신호(`settings_changed`) 수. */
  settingsSignals: () => number;
  /**
   * 서버가 지금까지 이 연결로 보낸 frame을 모두 받을 때까지 기다린다(ping을 보내 pong을 받는다. 한 연결의 frame은 보낸 순서로 온다).
   * 연결이 실패했으면 그 실패로 끝난다.
   */
  caughtUp: () => Promise<void>;
  /** 시험이 청한 닫힘. 그 뒤의 닫힘은 실패가 아니다. */
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
  /**
   * 이 에이전트가 받은 촉진의 처리가 끝날 때까지 기다린다. 요청의 촉진은 응답 전에 시작하므로, 요청 뒤에 부르면 그 요청이
   * 실행 시도를 시작했는지(시작했다면 그 끝까지)가 정해진 뒤다. "시작하지 않았다"를 시간 대신 이것 뒤에 확인한다.
   */
  kickHandled: (agentId: string) => Promise<void>;
  /** 서버 시계의 지금 시각으로 지난 heartbeat를 처리한다. */
  tickHeartbeats: () => Promise<void>;
  tickCompactions: () => Promise<void>;
  /** 서버 시계의 지금 시각으로 보낼 차례인 알림을 모두 보내 본다. */
  deliverNotifications: () => Promise<void>;
  /** 서버(실행 중인 실행 시도 포함)만 멈추고 DB는 남긴다. */
  stopServer: () => Promise<void>;
  /** 서버를 끄는 중이면 지금 하는 단계(정리 시한이 지났을 때 알리는 값). */
  stopProgress: () => string;
  /** 구독 준비(`ready`)까지 기다린 Event stream 연결. `origin`을 주면 브라우저처럼 Origin header를 보낸다. */
  subscribe: (
    scope: StreamScope,
    options?: { origin?: string }
  ) => Promise<Subscription>;
  /** 서버·DB·이 helper가 만든 작업 폴더를 치운다. 각 단계를 따로 시도하고 실패를 모아 알린다. */
  close: () => Promise<void>;
};

export type TestServerOptions = {
  /** 가짜 프로바이더 연결 하나의 adapter. 기본은 가짜 프로바이더의 기본 시나리오다. */
  runtime?: RuntimeAdapter;
  /** 이름 붙은 프로바이더 연결 여러 개. `runtime`과 함께 쓰지 않는다. */
  providers?: ProviderConnection[];
  /** 기록 시각에 쓰는 시계. */
  now?: () => Date;
  /** 알림을 보내고 답을 받는 채널. 기본은 가짜 채널이다. */
  notificationChannels?: NotificationChannel[];
  /** 하네스 라이브러리 디렉터리. 기본은 저장소의 `harness/`다. */
  harnessDir?: string;
  dataDir?: string;
  /** 격리 실행의 Docker 환경. 없으면 격리를 켜도 실제 연결은 준비안됨이다. */
  isolation?: ServerOptions["isolation"];
  /** 빌드한 화면 디렉터리. 있으면 API 밖의 경로에 SPA로 낸다. */
  webDistDir?: string;
  /** 서버 시작의 준비 확인을 기다리는 상한. 기본은 `readinessSettleMs`이며 서버에는 넘기지 않는다. */
  readinessSettleMs?: number;
};

/** 같은 프로세스에서 embedded Postgres와 서버를 띄우고 HTTP·Event stream으로만 검증한다. */
export async function startTestServer({
  readinessSettleMs: settleMs = readinessSettleMs,
  ...options
}: TestServerOptions = {}): Promise<TestServer> {
  const database = await createTestDatabase();
  // 넘겨받은 폴더는 넘긴 쪽이 치운다. 이 helper가 만든 폴더만 지운다.
  let ownDataDir: string | undefined;
  let server: RunningServer | undefined;
  /** 연 Event stream의 즉시 끊기. 서버를 끄기 전에 모두 끊는다(시험이 청한 닫힘이다). */
  const sockets = new Set<() => void>();
  /** 서버의 끝. 한 번만 하고, 끄기를 부른 쪽과 정리가 같은 결과를 기다린다. */
  let stopped: Promise<void> | undefined;

  const request: TestServer["request"] = async (
    method,
    path,
    body,
    headers = {}
  ) => {
    const res = await fetch(server!.url + path, {
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
  // 서버를 넘기기 전(폴더 만들기·서버 시작·준비 확인)의 실패는 여기서 치운다.
  try {
    const dataDir =
      options.dataDir ??
      (ownDataDir = await mkdtemp(
        path.join(tmpdir(), "babojubot-workspaces-")
      ));
    server = await startServer({
      db: database.db,
      port: 0,
      ...options,
      dataDir,
    });
    // 서버 시작의 준비 확인이 끝난 뒤에 검사를 시작한다. 그래야 그 확인의 설정 변경 신호가 검사가 센 신호에 섞이지 않는다.
    // 조회가 실패하면(응답이 깨짐 등) 다시 묻지 않고 그 오류로 실패한다.
    let unsettled: string[] | undefined;
    let failed: { error: unknown } | undefined;
    await vi
      .waitUntil(
        async () => {
          try {
            const { body } = await request("GET", "/api/providers");
            unsettled = body.providers
              .filter(
                (p: {
                  readiness: { checking: boolean; reason: string | null };
                }) =>
                  p.readiness.checking || p.readiness.reason === "not_checked"
              )
              .map(
                (p: {
                  id: string;
                  readiness: { checking: boolean; reason: string | null };
                }) =>
                  `${p.id} (${p.readiness.checking ? "checking" : "not_checked"})`
              );
            return unsettled!.length === 0;
          } catch (error) {
            failed = { error };
            return true;
          }
        },
        { timeout: settleMs, interval: 10 }
      )
      .catch(() => {
        throw new Error(
          `the test server's providers did not finish their startup readiness check in ${settleMs}ms: ${unsettled ? unsettled.join(", ") : "no answer from GET /api/providers yet"}`
        );
      });
    if (failed) throw failed.error;
  } catch (error) {
    // 원래 실패를 그대로 알린다. 서버가 닫힌 것을 확인한 뒤에만 그 서버가 쓰는 DB와 폴더를 닫고 지운다. 확인하지 못하면 둘 다
    // 남긴다(`folderCleanup`). 치우기가 실패하면 그 실패를 원래 실패와 함께 알린다.
    const dataDir = ownDataDir;
    const closing = folderCleanup(() =>
      attemptAll([
        () => database.close(),
        async () => {
          if (dataDir) await removeFolder(dataDir);
        },
      ])
    );
    closing.own(() => server?.close());
    const failures = await attemptEach([closing.cleanUp]);
    if (failures.length > 0)
      throw combinedFailure(
        [error, ...failures],
        "the test server was not handed over and cleaning up after it failed",
        { cause: error }
      );
    throw error;
  }

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
    kickHandled: (agentId) => server.kickHandled(agentId),
    tickHeartbeats: () => server.tickHeartbeats(),
    tickCompactions: () => server.tickCompactions(),
    deliverNotifications: () => server.deliverNotifications(),
    stopProgress: () => server.progress(),
    stopServer() {
      for (const terminate of sockets) terminate();
      return (stopped ??= server.close());
    },
    async subscribe(scope, { origin } = {}) {
      const query =
        scope.kind === "organization"
          ? `?organizationId=${encodeURIComponent(scope.organizationId)}`
          : "";
      const { subscription } = await openEventStream(
        server.url.replace(/^http/, "ws") + eventStreamPath + query,
        { origin, opened: (terminate) => sockets.add(terminate) }
      );
      return subscription;
    },
    async close() {
      // 넘기기 전 실패의 정리와 같다. 서버의 끝(끄기를 이미 불렀으면 그 결과)을 확인한 뒤에만 DB와 폴더를 닫고 지운다.
      const closing = folderCleanup(() =>
        attemptAll([
          () => database.close(),
          async () => {
            if (ownDataDir) await removeFolder(ownDataDir);
          },
        ])
      );
      closing.own(() => {
        for (const terminate of sockets) terminate();
        return (stopped ??= server.close());
      });
      await closing.cleanUp();
    },
  };
}

/**
 * Event stream 연결 하나를 열고 준비(`ready` frame)를 기다린다. 연결의 실패는 하나로 모은다: 연결 오류, 거절된 연결(업그레이드 응답),
 * 시험이 청하지 않은 닫힘, 읽지 못한 frame 가운데 먼저 온 것이다. 준비·다음 Event·순서 표시(pong) 대기가 모두 그 실패로 끝난다.
 * 준비 뒤의 실패를 버리면 연결이 끊겨도 다음 대기가 시한까지 기다리거나 받은 Event가 모자란 채 단언했다(#298 리뷰 1회차 SPEC-2).
 * `close`와 `terminate`는 시험이 청한 닫힘이라 실패가 아니다. `opened`는 연결을 만든 직후 그 `terminate`를 받는다(정리 등록).
 */
export async function openEventStream(
  url: string,
  {
    origin,
    opened,
  }: { origin?: string; opened?: (terminate: () => void) => void } = {}
): Promise<{ subscription: Subscription; terminate: () => void }> {
  const socket = new WebSocket(url, { origin });
  let closing = false;
  const terminate = () => {
    closing = true;
    socket.terminate();
  };
  opened?.(terminate);
  let failure: { error: unknown } | undefined;
  /** 지금 기다리는 쪽의 거절. 연결이 실패하면 모두 그 실패로 끝난다. */
  const waiting = new Set<(error: unknown) => void>();
  const fail = (error: unknown) => {
    failure ??= { error };
    for (const reject of waiting) reject(failure.error);
  };
  /** `until`이 끝나거나 연결이 실패할 때까지. 이미 실패했으면 바로 그 실패다. */
  const unlessFailed = <T>(until: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      if (failure) return reject(failure.error);
      waiting.add(reject);
      until.then(
        (value) => {
          waiting.delete(reject);
          resolve(value);
        },
        (error: unknown) => {
          waiting.delete(reject);
          reject(error);
        }
      );
    });
  socket.on("error", (error) => fail(error));
  socket.once("unexpected-response", (_req, res) =>
    fail(new Error(`upgrade refused: ${res.statusCode}`))
  );
  socket.on("close", (code, reason) => {
    if (!closing)
      fail(
        new Error(
          `the Event stream closed before the test closed it (code ${code}${reason.length ? `, ${reason.toString()}` : ""})`
        )
      );
  });
  const events: Event[] = [];
  let settingsSignals = 0;
  let arrived: (() => void) | undefined;
  let ready!: () => void;
  const readied = new Promise<void>((resolve) => (ready = resolve));
  socket.on("message", (data) => {
    try {
      const frame = streamFrameSchema.parse(JSON.parse(String(data)));
      if (frame.type === "ready") return ready();
      if (frame.type === "settings_changed") {
        settingsSignals++;
        return;
      }
      events.push(frame.event);
      arrived?.();
    } catch (error) {
      fail(error);
    }
  });
  const caughtUp = () =>
    within(
      unlessFailed(
        new Promise<void>((resolve) => {
          socket.once("pong", () => resolve());
          socket.ping();
        })
      ),
      eventuallyMs,
      "the Event stream's pong did not finish"
    );
  let taken = 0;
  const subscription: Subscription = {
    events,
    next: (timeoutMs = eventuallyMs) =>
      within(
        unlessFailed(
          new Promise<Event>((resolve) => {
            const take = () => {
              if (taken >= events.length) return;
              arrived = undefined;
              resolve(events[taken++]!);
            };
            arrived = take;
            take();
          })
        ),
        timeoutMs,
        "no Event arrived"
      ),
    async expectNoEvents(since = 0) {
      await caughtUp();
      if (events.length > since)
        throw new Error(
          `unexpected Event: ${JSON.stringify(events.slice(since))}`
        );
    },
    settingsSignals: () => settingsSignals,
    caughtUp,
    close: () => {
      closing = true;
      socket.close();
    },
  };
  await within(
    unlessFailed(readied),
    eventuallyMs,
    "the Event stream did not get ready"
  );
  return { subscription, terminate };
}

/** 막힌 순서를 시한 안에 그 이름으로 알린다. 테스트 전체 시한까지 기다리지 않는다. 공용 시험 도움을 그대로 내보낸다. */
export { within };
