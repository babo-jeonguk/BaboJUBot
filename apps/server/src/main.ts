import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDatabase,
  openEphemeralDatabase,
  type DatabaseHandle,
} from "@babojubot/db";
import { startServer } from "./app.ts";

// 환경 변수
// - DATABASE_URL: 외부 Postgres(운영). 없으면 embedded Postgres를 BABOJUBOT_HOME/postgres에 띄운다.
// - BABOJUBOT_EPHEMERAL_DB=1: 임시 embedded Postgres(E2E). 종료 때 지운다.
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

const { handle, label } = await openConfiguredDatabase();
let server;
try {
  server = await startServer({
    db: handle.db,
    port: Number(env.PORT ?? 3100),
    host: env.HOST ?? "127.0.0.1",
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
