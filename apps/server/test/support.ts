import { mkdtemp } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attemptAll,
  attemptEach,
  combinedFailure,
  eventStreamPath,
  hasErrorCode,
  streamFrameSchema,
  type Event,
  type NotificationChannel,
  type ProviderConnection,
  type RuntimeAdapter,
  type StreamScope,
} from "@babojubot/contracts";
import { createTestDatabase, type TestDatabase } from "@babojubot/db/testing";
import { onTestFinished, vi } from "vitest";
import { within } from "@babojubot/process/test-support";
import WebSocket from "ws";
import {
  startServer,
  type RunningServer,
  type ServerOptions,
} from "../src/index.ts";
import { removeFolder } from "@babojubot/process/remove-folder";
import { folderCleanup } from "@babojubot/process/test-cleanup";
import { ownHome } from "./product-home.ts";

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
/**
 * 시험이 띄운 서버(`startServer`의 결과)의 끄기를 기다리는 상한. 제품의 서버 끄기(`app.ts`의 `stop`)는 단계마다 상한을 두지 않고,
 * 실행 진입점이 종료 시한(`main.ts`의 `BABOJUBOT_SHUTDOWN_TIMEOUT_MS`, 기본 30초)으로 전체를 끊는다. 시험은 진입점을 거치지 않으므로
 * 같은 값으로 기다린다: 제품이 정한 시한 안의 느린 끄기를 실패로 바꾸지 않고, 넘기면 끝을 확인하지 못한 것으로 실패한다. 다만 시험 서버
 * helper의 `close`(끄기 + DB 닫기 + 폴더 지우기)를 이 상한으로 감싸는 곳(`ownStart`로 helper 결과를 끄는 시험)은 안쪽 상한의 합보다
 * 먼저 끊을 수 있다. 그때는 감싼 쪽이 소유한 바깥 폴더만 남고, helper 자신의 DB와 작업 폴더는 그 안쪽 정리가 나중에 끝나면 닫힐 수
 * 있다. 상한을 넘겨도 끄기는 멈추지 않는다. 이 상한 하나는 시험 hook 시한(120초, `vitest.config.ts`)보다 짧아 무엇을 기다렸는지
 * 알린다. 정리 하나가 여러 상한을 차례로 기다리면 그 합이 hook 시한을 넘을 수 있고, 그때는 hook 시한의 실패로 끝난다.
 */
export const serverStopMs = 30_000;

/** 시험이 띄운 서버(`startServer`의 결과)를 끄고 그 끝을 `serverStopMs` 안에서 기다린다. 넘기면 실패하고 끄기는 멈추지 않는다. */
export const stopWithin = (server: { close(): Promise<void> }, what: string) =>
  within(server.close(), serverStopMs, `stopping ${what} did not finish`);

/**
 * 시작이 거절됐을 때 그 시작이 연 것을 모두 정리했는지 판정한다. 확인했으면 돌아오고, 확인하지 못하면 원인과 함께 던진다.
 * 판정은 시작이 거절되는 순간 한 번 한다(`ownStart`).
 */
export type StartEnded = (error: unknown) => void;

/** 판정 근거가 없는 시작. 시작이 거절되면 끝을 확인할 수 없으므로 실패한다(fail closed). */
const unconfirmedStart: StartEnded = (error) => {
  throw new Error(
    "a failed start was not expected, so its cleanup cannot be confirmed",
    {
      cause: error,
    }
  );
};

/**
 * 시험 서버 helper(`startTestServer`)의 계약: helper는 자기 정리가 모두 끝났을 때만 원래 오류 하나로 거절하고, 정리가 실패하면 그 실패를
 * 원래 오류 뒤에 묶어(`combinedFailure`, AggregateError) 거절한다. 묶인 거절이면 확인하지 못한 것이다(원래 오류가 처음부터 묶인 것이어서
 * 가를 수 없을 때도, fail closed).
 */
export const helperStartEnded: StartEnded = (error) => {
  if (error instanceof AggregateError)
    throw new Error("the test server helper did not confirm its cleanup", {
      cause: error,
    });
};

/** 시험이 받은 서버 진단: `console.error`·`console.warn` 호출의 인수 목록. */
export type Diagnostics = { error: unknown[][]; warn: unknown[][] };

/**
 * 지금부터 이 시험이 받는 서버 진단(`console.error`·`console.warn`)을 기록한다(출력은 그대로 둔다). 시험 정리가 기록을 되돌린다.
 * 제품은 시작 실패 뒤 정리가 실패하면 그 실패를 진단으로 따로 남기고 원래 오류를 던진다(`CODING_STANDARDS.md` 「제품 코드」의 정리 규칙,
 * `app.ts` `startServer`). 그래서 실패해야 하는 시작의 정리는 그 시작 동안의 진단 전체가 기대한 목록과 정확히 같은지로 확인한다
 * (`endedWith`). 다르면(정리 실패 진단이 있거나 다른 진단이 섞이면) 그 목록을 원인으로 확인하지 못한 것이다.
 */
export function startDiagnostics() {
  const error = vi.spyOn(console, "error");
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => {
    error.mockRestore();
    warn.mockRestore();
  });
  const received = (): Diagnostics => ({
    error: [...error.mock.calls],
    warn: [...warn.mock.calls],
  });
  return {
    received,
    endedWith:
      (expected: Diagnostics): StartEnded =>
      (failure) => {
        const diagnostics = received();
        if (!isDeepStrictEqual(diagnostics, expected))
          throw new Error(
            "the diagnostics of the failed start were not the expected ones, so its cleanup cannot be confirmed",
            { cause: { failure, diagnostics, expected } }
          );
      },
  };
}

/**
 * 시작 중인 서버(`starting`)를 곧바로 `own`(그 서버를 소유하는 정리)에 맡긴다. 맡긴 끝(`stop`)은 한 번만 돌고 같은 결과를 돌려준다:
 * 시작이 끝나기를 `serverStopMs` 안에서 기다려(시작 자체에는 제품 상한이 없다) 넘겨받았으면 끄고(`stopWithin`), 거절됐으면 그 순간
 * `ended`가 내린 판정을 따른다(확인하지 못했으면 그 원인으로 실패, fail closed). `ended`가 없으면 거절된 시작은 확인할 수 없다.
 * 시험 본문이 중간에 끄려면 같은 `stop`을 부른다.
 */
export function ownStart<S extends { close(): Promise<void> }>(
  own: (stop: () => Promise<void>) => void,
  starting: Promise<S>,
  what: string,
  ended: StartEnded = unconfirmedStart
) {
  // 거절되는 순간 판정한다. 그 뒤의 진단이 판정에 섞이지 않는다.
  const outcome = starting.then(
    (server) => ({ server }),
    (error: unknown) => {
      try {
        ended(error);
        return {};
      } catch (unconfirmed) {
        return { unconfirmed };
      }
    }
  );
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      const settled = await within(
        outcome,
        serverStopMs,
        `the start of ${what} did not end`
      );
      if ("server" in settled) return stopWithin(settled.server, what);
      if ("unconfirmed" in settled) throw settled.unconfirmed;
    })());
  own(stop);
  return { started: starting, stop };
}

/**
 * 시험이 붙잡아 둔 일(`work`)이 붙잡힌 자리(`held`)에 닿기를 상한 안에서 기다린다. 닿기 전에 `work`가 끝나면(성공이든 실패든) 붙잡힘을
 * 확인하지 못한 것이므로 그 끝으로 실패한다(실패면 그 오류, 성공이면 끝났다는 오류).
 */
export const heldOrEnded = (
  held: Promise<unknown>,
  work: Promise<unknown>,
  what: string
) =>
  within(
    Promise.race([
      held,
      work.then((value: unknown) => {
        throw new Error(`${what} ended before it was held`, { cause: value });
      }),
    ]),
    eventuallyMs,
    `${what} was not held`
  );

/**
 * 그것을 쓰는 것(돌려준 정리의 `own`)이 모두 끝난 뒤에만 `close`를 하는 정리(`folderCleanup`). 시험 정리와 파일의 제품 폴더 정리
 * (`ownHome`) 둘 다에 같은 결과로 맡긴다: 그것을 쓰는 서버가 데이터 폴더 없이 뜨면 제품 폴더도 쓴다.
 */
export function closedAfterUsers(close: () => Promise<void>) {
  const users = homeUsers(close);
  onTestFinished(users.cleanUp);
  return users;
}

/**
 * `closedAfterUsers`에서 시험 정리 등록만 뺀 것: 쓰는 것이 모두 끝난 뒤에만 `close`를 하는 정리를 파일의 제품 폴더 정리(`ownHome`)에
 * 맡긴다. 시험 정리는 부른 쪽이 맞는 hook(afterEach 등)에서 `cleanUp`으로 돌린다.
 */
export function homeUsers(close: () => Promise<void>) {
  const users = folderCleanup(close);
  ownHome(users.cleanUp);
  return users;
}

/**
 * 시험 서버의 정리를 모듈의 afterEach에서 이 시험의 정리로 넘긴다. 그 서버(DB와 작업 폴더)는 돌려준 정리에 맡긴 것(그 DB를 쓰는 다른
 * 서버 등)이 모두 끝난 뒤에만 닫는다(`closedAfterUsers`). 부른 쪽은 같은 동기 단계에서 모듈 변수를 비운다.
 */
export const handOver = (server: TestServer) =>
  closedAfterUsers(() => server.close());

/**
 * 시험 서버(`first`)를 이 시험의 정리로 넘기고(`handOver`) 그 DB로 서버를 하나 더 띄운다. 새 서버는 띄우는 즉시 그 정리가 소유하므로
 * (`ownStart`) 시험 서버의 DB는 새 서버의 끝을 확인한 뒤에만 닫힌다. 부른 쪽은 같은 동기 단계에서 모듈 변수를 비운다.
 */
export function startOnDatabaseOf(
  first: TestServer,
  options: Omit<ServerOptions, "db" | "port">,
  what: string,
  ended?: StartEnded
) {
  const users = handOver(first);
  return ownStart(
    users.own,
    startServer({ db: first.db, port: 0, ...options }),
    what,
    ended
  );
}

/**
 * 시험이 붙잡아 둔 것을 풀고(`open`) 붙잡혀 있던 일(`pending`: transaction, 요청)이 모두 끝나기를 상한 안에서 기다린다. 하나가 실패해도
 * 나머지를 기다리고 실패를 모아 알린다. 상한을 넘기면 그 일은 계속 돌고 이 정리는 실패한다. 그 DB의 정리(서버 끄기, DB 닫기)는
 * 따로 돌며, 그 일이 그 상한들보다 오래 남으면 그 정리도 실패하고 DB를 남긴다(fail closed). 그 안에 끝나면 DB는 닫힌다.
 */
export const releaseHeld = (
  open: () => unknown,
  pending: (() => unknown)[],
  what: string
) =>
  within(attemptAll([open, ...pending]), eventuallyMs, `${what} did not end`);

/** 구독이 받은 것: Event frame과 전역 설정 변경 신호(`settings_changed`) 수. */
export type Received = { events: Event[]; settingsSignals: number };

/**
 * Event stream 구독. 받은 것은 연결이 실패하지 않았을 때만 내준다. 원본 배열·계수기를 내주면 연결이 끊긴 뒤에도 마지막 값이
 * 정상 관측값처럼 읽혀, 그 뒤 서버가 보내면 안 되는 것을 시험이 보지 못한 채 통과했다(#298 외부 리뷰 2회차 SPEC-2-R1).
 */
export type Subscription = {
  /** 다음 Event를 기다린다. 이미 받은 것이 있으면 바로 돌려준다. 기본 상한은 `eventuallyMs`다. */
  next: (timeoutMs?: number) => Promise<Event>;
  /**
   * 서버가 지금까지 이 연결로 보낸 frame을 모두 받은 뒤 받은 것을 돌려준다. 시간을 재지 않고 순서 표시를 쓴다: 이 연결로
   * ping을 보내 pong을 받으면, 서버가 그 전에 이 연결로 보낸 frame은 모두 받은 것이다(한 연결의 frame은 보낸 순서로 온다).
   * 서버는 요청의 Event와 설정 신호를 응답 전에 보내므로(commit 뒤 할 일), 끝난 요청이 남긴 것은 빠짐없이 본다.
   * 응답 뒤에 따로 도는 일(실행 시도 등)이 남길 것은 그 끝(`drain` 등)을 먼저 기다린 뒤 부른다. 연결이 실패했으면 그 실패로 끝난다.
   */
  received: () => Promise<Received>;
  /** 이 구독이 받은 Event가 `since`개(기본 0)에서 늘지 않았는지 `received`로 확인한다. */
  expectNoEvents: (since?: number) => Promise<void>;
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
  /** 서버를 끈 것을 확인한 뒤에만 DB를 닫고 이 helper가 만든 작업 폴더를 지운다. 한 번만 돌고 다시 부르면 같은 결과를 돌려준다. */
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
  /**
   * 서버 시작(`startServer`)이 거절될 때 그 정리를 확인하는 판정(`StartEnded`). 서버를 띄우지 못하게 하는 시험만 준다(`startDiagnostics`의
   * `endedWith`). 없으면 거절된 시작의 정리를 확인할 수 없어 DB와 작업 폴더를 남기고 실패한다.
   */
  startEnded?: StartEnded;
};

/** 같은 프로세스에서 embedded Postgres와 서버를 띄우고 HTTP·Event stream으로만 검증한다. */
export async function startTestServer({
  readinessSettleMs: settleMs = readinessSettleMs,
  startEnded = unconfirmedStart,
  ...options
}: TestServerOptions = {}): Promise<TestServer> {
  const database = await createTestDatabase();
  // 넘겨받은 폴더는 넘긴 쪽이 치운다. 이 helper가 만든 폴더만 지운다.
  let ownDataDir: string | undefined;
  let server: RunningServer | undefined;
  /** 서버 시작. 불렀는지로 시작 전 실패와 시작 실패를 가른다. */
  let starting: Promise<RunningServer> | undefined;
  /** 연 Event stream의 즉시 끊기. 서버를 끄기 전에 모두 끊는다(시험이 청한 닫힘이다). */
  const sockets = new Set<() => void>();
  /** 서버의 끝. 한 번만 하고, 끄기를 부른 쪽과 정리가 같은 결과를 기다린다. */
  let stopped: Promise<void> | undefined;
  /** 서버를 끈다: 연 Event stream을 먼저 끊고(시험이 청한 닫힘) 한 번만 끈다(`stopWithin`). */
  const stopOnce = (running: RunningServer) => {
    for (const terminate of sockets) terminate();
    return (stopped ??= stopWithin(running, "the test server"));
  };
  /** 서버의 끝을 확인한 뒤의 정리: DB를 닫고 이 helper가 만든 작업 폴더를 지운다. 둘은 서로 독립이라 모두 시도한다. */
  const release = () =>
    attemptAll([
      () => database.close(),
      async () => {
        if (ownDataDir) await removeFolder(ownDataDir);
      },
    ]);

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
    server = await (starting = startServer({
      db: database.db,
      port: 0,
      ...options,
      dataDir,
    }));
    // 서버 시작의 준비 확인이 끝난 뒤에 검사를 시작한다. 그래야 그 확인의 설정 변경 신호가 검사가 센 신호에 섞이지 않는다.
    // 조회가 실패하면(응답이 깨짐 등) 다시 묻지 않고 그 오류로 실패한다.
    let unsettled: string[] | undefined;
    await pollUntil(
      async () => {
        const { body } = await request("GET", "/api/providers");
        unsettled = body.providers
          .filter(
            (p: { readiness: { checking: boolean; reason: string | null } }) =>
              p.readiness.checking || p.readiness.reason === "not_checked"
          )
          .map(
            (p: {
              id: string;
              readiness: { checking: boolean; reason: string | null };
            }) =>
              `${p.id} (${p.readiness.checking ? "checking" : "not_checked"})`
          );
        return unsettled!.length === 0 || undefined;
      },
      {
        timeoutMs: settleMs,
        intervalMs: 10,
        timedOut: () =>
          `the test server's providers did not finish their startup readiness check in ${settleMs}ms: ${unsettled ? unsettled.join(", ") : "no answer from GET /api/providers yet"}`,
      }
    );
  } catch (error) {
    // 원래 실패를 그대로 알린다. 서버가 닫힌 것을 확인한 뒤에만 그 서버가 쓰는 DB와 폴더를 닫고 지운다. 확인하지 못하면 둘 다
    // 남긴다(`folderCleanup`). 치우기가 실패하면 그 실패를 원래 실패와 함께 알린다.
    const closing = folderCleanup(release);
    // 넘겨받은 서버는 끈다. 서버 시작이 거절됐으면 그 시작이 연 것을 정리했는지 판정한다(`startEnded`). 시작 전에 실패했으면 확인할 것이 없다.
    closing.own(() => {
      if (server) return stopOnce(server);
      if (starting) startEnded(error);
    });
    const failures = await attemptEach([closing.cleanUp]);
    if (failures.length > 0)
      throw combinedFailure(
        [error, ...failures],
        "the test server was not handed over and cleaning up after it failed",
        { cause: error }
      );
    throw error;
  }

  // 넘긴 뒤의 정리. 넘기기 전 실패의 정리와 같다: 서버의 끝(끄기를 이미 불렀으면 그 결과)을 확인한 뒤에만 DB와 폴더를 닫고 지운다. 한 번만
  // 돌고 다시 부르면 같은 결과를 돌려준다(시험 서버를 넘겨받은 정리와 모듈의 afterEach가 함께 불러도 두 번 닫지 않는다).
  const handed = folderCleanup(release);
  handed.own(() => stopOnce(server!));
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
    stopServer: () => stopOnce(server!),
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
    close: handed.cleanUp,
  };
}

/**
 * Event stream 연결 하나를 열고 준비(`ready` frame)를 기다린다. 연결의 실패는 하나로 모은다: 연결 오류, 거절된 연결(업그레이드 응답),
 * 시험이 청하지 않은 닫힘, 읽지 못한 frame 가운데 먼저 온 것이다. 준비·다음 Event·받은 것(`received`) 대기가 모두 그 실패로 끝난다.
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
  const received = async (): Promise<Received> => {
    await within(
      unlessFailed(
        new Promise<void>((resolve) => {
          socket.once("pong", () => resolve());
          socket.ping();
        })
      ),
      eventuallyMs,
      "the Event stream's pong did not finish"
    );
    return { events: [...events], settingsSignals };
  };
  let taken = 0;
  const subscription: Subscription = {
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
    received,
    async expectNoEvents(since = 0) {
      const { events } = await received();
      if (events.length > since)
        throw new Error(
          `unexpected Event: ${JSON.stringify(events.slice(since))}`
        );
    },
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

/**
 * `check`를 바로 한 번, 그 뒤 `intervalMs`마다 묻는다. 값을 돌려주면(`undefined`는 "아직") 그 값으로 끝나고, 던지면 다시 묻지 않고
 * 그 실패로 끝난다. 실패를 "아직"으로 세면 원인을 버리고 상한까지 기다렸다(#286). 상한이 지나면 `timedOut()`의 문구로 실패한다.
 * `vi.waitUntil`은 확인의 실패와 상한을 같은 거절로 돌려주므로, 확인의 실패는 받아 두어 대기를 끝내고 대기가 끝난 뒤 다시 던진다.
 */
export async function pollUntil<T>(
  check: () => T | undefined | Promise<T | undefined>,
  {
    timeoutMs,
    intervalMs,
    timedOut,
  }: { timeoutMs: number; intervalMs: number; timedOut: () => string }
): Promise<T> {
  let seen: { value: T } | { error: unknown } | undefined;
  await vi
    .waitUntil(
      async () => {
        try {
          const value = await check();
          if (value !== undefined) seen = { value };
        } catch (error) {
          seen = { error };
        }
        return seen !== undefined;
      },
      { timeout: timeoutMs, interval: intervalMs }
    )
    // 확인의 실패는 위에서 받아 대기를 끝내므로, 여기 오는 것은 상한뿐이다.
    .catch(() => {
      throw new Error(timedOut());
    });
  if ("error" in seen!) throw seen.error;
  return seen!.value;
}

/**
 * server 시험이 띄우는 listener(net·http 서버)의 소유. 만든 서버를 받아 곧바로 그 닫기를 `own`(onTestFinished, withCleanup의 defer,
 * folderCleanup의 own 가운데 그 listener를 소유하는 정리)에 맡기고, 그다음 `at`에서 듣기를 상한 안에서 기다린다.
 * 닫기는 받은 연결을 먼저 끊고(서버 닫기는 연결이 모두 끝나야 끝난다) 닫힘을 상한 안에서 확인한다. 듣기 전에 실패했거나 이미 닫은 서버는
 * 닫을 것이 없다(`ERR_SERVER_NOT_RUNNING`). 그 밖의 닫기 오류와 상한은 실패다. 듣지 못하면 그 오류로 거절된다.
 * 돌려주는 `close`는 맡긴 것과 같은 닫기다. 시험 중간에 닫아야 하면(포트를 비우기 등) 그것을 부르고, 정리는 닫을 것이 없음으로 끝난다.
 */
export async function ownedListener<S extends net.Server>(
  server: S,
  at: net.ListenOptions,
  own: (close: () => Promise<void>) => void,
  what: string
): Promise<{ server: S; close: () => Promise<void> }> {
  const connections = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const close = () => {
    for (const socket of connections) socket.destroy();
    return within(
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error && !hasErrorCode("ERR_SERVER_NOT_RUNNING")(error)
            ? reject(error)
            : resolve()
        )
      ),
      eventuallyMs,
      `${what} did not close`
    );
  };
  own(close);
  await within(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(at, () => {
        server.off("error", reject);
        resolve();
      });
    }),
    eventuallyMs,
    `${what} did not start listening`
  );
  return { server, close };
}

/**
 * 이 시험 동안 가짜 시계를 켜고 시험 정리가 되돌린다. 대상 코드가 입출력 없이 microtask와 타이머로만 움직이는 시험에서 쓴다. 그 위에서는
 * `outcomeAfterDrain`으로 "저절로 일어날 일이 다 일어난 뒤"를 판정한다(#286).
 */
export function fakeClock() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** 가짜 시계 위에서 대상 코드가 시험의 다음 행동 없이 할 수 있는 일을 모두 마친 뒤 `promise`의 결과. */
export type DrainedOutcome = "pending" | "resolved" | { rejected: unknown };

/**
 * 가짜 시계의 타이머를 남김없이 돌리고 microtask가 빈 뒤 `promise`가 어떻게 됐는가. 이 뒤에는 가짜 시계의 타이머도 microtask도
 * 남지 않으므로, 이때 풀리지 않았으면(`"pending"`) 가짜 시계로는 더 풀리지 않는다. 실제 시계의 상한(`within`)이나 입출력은 이 뒤에도
 * 따로 풀 수 있다. 틀린 구현이 기다리던 쪽을 먼저
 * 풀면(microtask로든 타이머로든) 이 뒤에는 이미 풀려 있다. 이벤트 루프 한 차례만 기다리면 타이머로 미룬 풀림을 놓쳤다(#286).
 */
export async function outcomeAfterDrain(
  promise: Promise<unknown>
): Promise<DrainedOutcome> {
  let outcome: DrainedOutcome = "pending";
  void promise.then(
    () => (outcome = "resolved"),
    (error: unknown) => (outcome = { rejected: error })
  );
  await vi.runAllTimersAsync();
  return outcome;
}
