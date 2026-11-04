import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
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
// - BABOJUBOT_EPHEMERAL_HOME=1: 임시 제품 폴더(E2E). BABOJUBOT_HOME 대신 쓰고, 프로세스가 끝날 때 지운다.
// - BABOJUBOT_FAKE_PROVIDERS: 가짜 프로바이더 연결 수(기본 1). 2 이상이면 `fake-2`(가짜 프로바이더 2)…가 더 생긴다(E2E).
// - BABOJUBOT_FAKE_PROVIDER_SETTINGS: 가짜 연결 ID별 설정 JSON(지원하는 일·준비 상태·사용량·끼워 넣기 응답·로그인 명령, E2E).
//   예: {"fake-2":{"capabilities":{"steer":false},"readiness":{"status":"not_ready","reason":"product_login_missing"}}}
// - PORT, HOST, EMBEDDED_POSTGRES_PORT, BABOJUBOT_HOME
//   HOST 기본값은 127.0.0.1이다. 인증이 없으므로 외부 주소로 열면 그 네트워크의 누구나 API와 Event stream을 쓴다.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const env = process.env;
const temporaryHome = env.BABOJUBOT_EPHEMERAL_HOME === "1";
const productHome = temporaryHome
  ? mkdtempSync(path.join(os.tmpdir(), "babojubot-home-"))
  : path.resolve(env.BABOJUBOT_HOME ?? path.join(repoRoot, ".babojubot"));
// 임시 제품 폴더는 프로세스가 어떻게 끝나든 마지막에 지운다. SIGTERM에는 embedded-postgres의 종료 hook이
// 서버 정리보다 먼저 process.exit을 부를 수 있어, 종료 순서에 기대지 않는다.
if (temporaryHome)
  process.on("exit", () =>
    rmSync(productHome, { recursive: true, force: true, maxRetries: 3 })
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

const { handle, label } = await openConfiguredDatabase();
let server;
try {
  server = await startServer({
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
} catch (error) {
  await handle.close();
  throw error;
}
console.log(
  `BaboJUBot server on ${server.url} (${label}, product folder ${productHome})`
);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await server.close();
      } finally {
        await handle.close();
        process.exit(0);
      }
    })();
  });
}
