import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;

/** 열린 DB. `close`는 이 handle이 소유한 자원(연결, embedded cluster)만 정리한다. */
export type DatabaseHandle = {
  db: Database;
  url: string;
  close: () => Promise<void>;
};

export type DatabaseOptions =
  /** 외부 Postgres. 연결만 소유하며 서버를 멈추거나 지우지 않는다. */
  | { url: string }
  /** 이 프로세스가 띄우고 멈추는 embedded Postgres. `persistent: false`면 정지 때 dataDir를 지운다. */
  | { embedded: { dataDir: string; port: number; persistent: boolean } };

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

  const { dataDir, port, persistent } = options.embedded;
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password: "postgres",
    persistent,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (error) => console.error("[embedded-postgres]", error),
  });
  if (!fs.existsSync(path.join(dataDir, "PG_VERSION")))
    await cluster.initialise();
  // start가 실패하면 postgres 프로세스는 이미 끝났다. 이때 stop은 오지 않을 exit를 기다리므로 부르지 않는다.
  await cluster.start();
  try {
    await ensureDatabase(cluster);
    return await connect(
      `postgres://postgres:postgres@127.0.0.1:${port}/${databaseName}`,
      () => cluster.stop()
    );
  } catch (error) {
    await cluster.stop();
    throw error;
  }
}

async function ensureDatabase(cluster: EmbeddedPostgres) {
  const client = cluster.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  try {
    const { rowCount } = await client.query(
      "select 1 from pg_database where datname = $1",
      [databaseName]
    );
    if (!rowCount) await client.query(`create database ${databaseName}`);
  } finally {
    await client.end();
  }
}

async function connect(
  url: string,
  release: () => Promise<void>
): Promise<DatabaseHandle> {
  const pool = new pg.Pool({ connectionString: url });
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
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
  try {
    const handle = await openDatabase({
      embedded: { dataDir, port: await freePort(), persistent: false },
    });
    return {
      ...handle,
      close: async () => {
        try {
          await handle.close();
        } finally {
          await fsp.rm(dataDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await fsp.rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
