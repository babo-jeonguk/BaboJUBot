import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  openEphemeralDatabase,
  type DatabaseHandle,
} from "@babojubot/db";
import {
  providerCapabilitiesSchema,
  providerIdSchema,
  providerReadinessCheckSchema,
  steerOutcomes,
  usageSchema,
} from "@babojubot/contracts";
import { createFakeProviders, createConnection } from "@babojubot/runtime";
import { z } from "zod";
import { startServer } from "./app.ts";

// 환경 변수
// - DATABASE_URL: 외부 Postgres(운영). 없으면 embedded Postgres를 BABOJUBOT_HOME/postgres에 띄운다.
// - BABOJUBOT_EPHEMERAL_DB=1: 임시 embedded Postgres(E2E). 종료 때 지운다.
// - BABOJUBOT_FAKE_PROVIDERS: 가짜 프로바이더 연결 수(기본 1). 2 이상이면 `fake-2`(가짜 프로바이더 2)…가 더 생긴다(E2E).
// - BABOJUBOT_FAKE_PROVIDER_SETTINGS: 가짜 연결 ID별 설정 JSON(지원하는 일·준비 상태·사용량·끼워 넣기 응답·로그인 명령, E2E).
//   예: {"fake-2":{"capabilities":{"steer":false},"readiness":{"status":"not_ready","reason":"product_login_missing"}}}
// - PORT, HOST, EMBEDDED_POSTGRES_PORT, BABOJUBOT_HOME
//   HOST 기본값은 127.0.0.1이다. 인증이 없으므로 외부 주소로 열면 그 네트워크의 누구나 API와 Event stream을 쓴다.
// - BABOJUBOT_SHUTDOWN_TIMEOUT_MS: 종료 신호 뒤 정리 시한(ms, 1~2147483647 정수, 기본 30000). 아니면 시작하지 않는다.
//   서버를 감싼 실행기(Docker·Kubernetes·Playwright)의 정지 시한은 이보다 길게 둔다. 실행기가 먼저 강제로 끝내면 내장 Postgres가 남고, 다음 시작이 그것을 정상 정지한다.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const env = process.env;
const productHome = path.resolve(
  env.BABOJUBOT_HOME ?? path.join(repoRoot, ".babojubot")
);
// Real connections are opt-in. `claude:work`처럼 쓰면 같은 프로그램의 다른 계정 연결이 된다.
const enabled = (env.BABOJUBOT_PROVIDERS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const realProviders = [...new Set(enabled)].map((name) =>
  createConnection(name, {
    dataDir: productHome,
    mode: env.BABOJUBOT_CODEX_MODE === "exec" ? "exec" : "app-server",
  })
);

async function openConfiguredDatabase(): Promise<{
  handle: DatabaseHandle;
  label: string;
}> {
  if (env.DATABASE_URL)
    return {
      handle: await openDatabase({ url: env.DATABASE_URL }),
      label: "external Postgres",
    };
  if (env.BABOJUBOT_EPHEMERAL_DB === "1")
    return {
      handle: await openEphemeralDatabase(),
      label: "ephemeral embedded Postgres",
    };
  const dataDir = path.join(productHome, "postgres");
  const port = Number(env.EMBEDDED_POSTGRES_PORT ?? 54329);
  return {
    handle: await openDatabase({
      embedded: { dataDir, port, persistent: true },
    }),
    label: `embedded Postgres ${dataDir}`,
  };
}

/** 가짜 연결 ID별 설정(runtime `FakeProviderSettings`). */
const fakeProviderSettingsSchema = z.record(
  providerIdSchema,
  z.strictObject({
    capabilities: providerCapabilitiesSchema.partial().optional(),
    readiness: providerReadinessCheckSchema.optional(),
    usage: usageSchema.optional(),
    steerOutcome: z.enum(steerOutcomes).optional(),
    loginCommand: z.string().nullable().optional(),
  })
);
const fakeProviderSettings = fakeProviderSettingsSchema.parse(
  JSON.parse(env.BABOJUBOT_FAKE_PROVIDER_SETTINGS || "{}")
);

// 종료: SIGINT(Ctrl+C)·SIGTERM·SIGHUP(터미널 닫힘)은 이 진입점만 받는다. 서버 정리를 끝낸 뒤 DB를 닫고, 성공하면 0,
// 정리나 시작에 실패하면 1로 끝난다. 시작하는 동안 온 신호는 시작을 마친 뒤 같은 순서로 정리한다(서버는 띄우지 않는다).
// 정리가 시한 안에 끝나지 않으면 1로 끝내고, 그때 내장 Postgres는 DB 패키지가 프로세스 종료 때 멈춘다(즉시 정지).
const shutdownDeadlineMs = readShutdownDeadline(
  env.BABOJUBOT_SHUTDOWN_TIMEOUT_MS
);
let stopping: Promise<void> | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    stopping ??= shutdown(signal);
  });

const startup = start();
const { server, label } = await startup;
if (server)
  console.log(
    `BaboJUBot server on ${server.url} (${label}, product folder ${productHome})`
  );

async function start() {
  const { handle, label } = await openConfiguredDatabase();
  if (stopping) return { handle, label, server: undefined };
  try {
    const server = await startServer({
      db: handle.db,
      dataDir: productHome,
      port: Number(env.PORT ?? 3100),
      host: env.HOST ?? "127.0.0.1",
      providers: [
        ...createFakeProviders(
          Math.max(1, Number(env.BABOJUBOT_FAKE_PROVIDERS ?? 1) || 1),
          { settings: fakeProviderSettings }
        ),
        ...realProviders,
      ],
      webDistDir: path.join(repoRoot, "apps/web/dist"),
    });
    return { handle, label, server };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function shutdown(signal: NodeJS.Signals) {
  setTimeout(() => {
    console.error(
      `[server] shutdown after ${signal} did not finish in ${shutdownDeadlineMs / 1000}s`
    );
    process.exit(1);
  }, shutdownDeadlineMs).unref();
  let failed = false;
  const fail = (error: unknown) => {
    failed = true;
    console.error("[server] shutdown failed", error);
  };
  // 시작이 실패했으면 열린 자원은 시작 쪽이 이미 닫았다. 실패는 그대로 알린다.
  const started = await startup.catch((error: unknown) => {
    failed = true;
    console.error("[server] start failed", error);
  });
  if (started) {
    await started.server?.close().catch(fail);
    await started.handle.close().catch(fail);
  }
  process.exit(failed ? 1 : 0);
}

/** 정리 시한. Node 타이머는 1ms 미만이나 2147483647ms 초과를 1ms로 바꾸므로 그 범위의 정수만 받는다. */
function readShutdownDeadline(value: string | undefined): number {
  if (value === undefined || value === "") return 30_000;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647)
    throw new Error(
      `BABOJUBOT_SHUTDOWN_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, got "${value}"`
    );
  return ms;
}
