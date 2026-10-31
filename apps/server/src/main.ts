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
import { createFakeProviders } from "@babojubot/runtime";
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
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const env = process.env;

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
  const dataDir = path.join(
    env.BABOJUBOT_HOME ?? path.join(repoRoot, ".babojubot"),
    "postgres"
  );
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
    port: Number(env.PORT ?? 3100),
    host: env.HOST ?? "127.0.0.1",
    providers: createFakeProviders(
      Math.max(1, Number(env.BABOJUBOT_FAKE_PROVIDERS ?? 1) || 1),
      { settings: fakeProviderSettings }
    ),
    webDistDir: path.join(repoRoot, "apps/web/dist"),
  });
} catch (error) {
  await handle.close();
  throw error;
}
console.log(`BaboJUBot server on ${server.url} (${label})`);

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
