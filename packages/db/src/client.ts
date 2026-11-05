import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.ts";
import {
  clusterUrl,
  ephemeralCluster,
  startEmbeddedCluster,
  type EmbeddedOptions,
} from "./embedded.ts";

export {
  clusterUrl,
  emergencyStopMs,
  ephemeralCluster,
  freePort,
  startEmbeddedCluster,
  type EmbeddedOptions,
} from "./embedded.ts";

export type Database = NodePgDatabase<typeof schema>;

/** 열린 DB. `close`는 이 handle이 소유한 자원(연결, embedded cluster)만 정리한다. */
export type DatabaseHandle = {
  db: Database;
  url: string;
  close: () => Promise<void>;
};

export type DatabaseOptions =
  /** 외부 Postgres. 연결만 소유하며 서버를 멈추거나 지우지 않는다. */
  { url: string } | { embedded: EmbeddedOptions };

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const databaseName = "babojubot";

export async function migrateDatabase(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/** 연결하고 migration을 적용한다. embedded든 외부든 같은 migration 경로를 쓴다. */
export async function openDatabase(
  options: DatabaseOptions
): Promise<DatabaseHandle> {
  if ("url" in options) return connect(options.url, async () => {});

  const { port } = options.embedded;
  const stop = await startEmbeddedCluster(options.embedded);
  try {
    await ensureDatabase(clusterUrl(port, "postgres"));
    return await connect(clusterUrl(port, databaseName), stop);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function ensureDatabase(url: string) {
  await withClient(url, async (client) => {
    const { rowCount } = await client.query(
      "select 1 from pg_database where datname = $1",
      [databaseName]
    );
    if (!rowCount) await client.query(`create database ${databaseName}`);
  });
}

/** 연결 하나를 열어 쓰고 닫는다. DB 만들기·지우기처럼 pool 밖에서 하는 일에 쓴다. */
export async function withClient<T>(
  url: string,
  use: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

async function connect(
  url: string,
  release: () => Promise<void>
): Promise<DatabaseHandle> {
  const pool = new pg.Pool({ connectionString: url });
  // 쉬는 연결이 끊기면(Postgres 재시작 등) pool이 그 연결을 버린다. listener가 없으면 프로세스가 죽는다.
  pool.on("error", (error) => console.error("[db]", error.message));
  // 쓰는 중인 연결이 끊기면 pool의 error로 오지 않고 그 연결에서 난다. 그 일은 쿼리 실패로 이미 알게 되므로 여기서는 프로세스만 살린다.
  pool.on("connect", (client) => client.on("error", () => {}));
  const db = drizzle(pool, { schema });
  const close = async () => {
    try {
      await pool.end();
    } finally {
      await release();
    }
  };
  try {
    await migrateDatabase(db);
  } catch (error) {
    await close();
    throw error;
  }
  return { db, url, close };
}

/** 임시 dataDir와 빈 port에 embedded Postgres를 띄운다. `close`가 cluster와 dataDir를 지운다. 테스트와 E2E용. */
export async function openEphemeralDatabase(): Promise<DatabaseHandle> {
  return openDatabase({ embedded: await ephemeralCluster() });
}
