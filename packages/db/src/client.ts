import type { ChildProcess } from "node:child_process";
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

/** 이 프로세스가 띄우고 멈추는 embedded Postgres. `persistent: false`면 정지 때 dataDir를 지운다. */
export type EmbeddedOptions = {
  dataDir: string;
  port: number;
  persistent: boolean;
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

/** embedded cluster의 DB 하나에 연결할 주소. */
export const clusterUrl = (port: number, database: string) =>
  `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;

/**
 * embedded cluster를 띄우고 멈추는 함수를 돌려준다. `stop`이 돌아오면 postgres는 끝났다.
 * `settings`는 postgres 설정(`이름=값`)이다.
 */
export async function startEmbeddedCluster(
  { dataDir, port, persistent }: EmbeddedOptions,
  settings: string[] = []
): Promise<() => Promise<void>> {
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password: "postgres",
    persistent,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: settings.flatMap((setting) => ["-c", setting]),
    onLog: () => {},
    onError: (error) => console.error("[embedded-postgres]", error),
  });
  // postgres가 먼저 끝나 cluster가 프로세스를 잊었으면 `stop`은 dataDir를 지우지 않으므로 여기서 지운다.
  const stop = async () => {
    await cluster.stop();
    if (!persistent) await fsp.rm(dataDir, { recursive: true, force: true });
  };
  try {
    if (!fs.existsSync(path.join(dataDir, "PG_VERSION")))
      await cluster.initialise();
    await startCluster(cluster);
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * embedded-postgres의 `stop`은 이미 끝난 postgres의 exit를 기다리며 멈춘다(upstream issue #32).
 * 종료 hook도 모든 cluster에 `stop`을 부르므로, postgres가 끝나면 cluster가 그 프로세스를 잊게 한다.
 * `start`가 실패해도 postgres는 이미 끝났으므로 `stop`은 바로 돌아온다.
 */
async function startCluster(cluster: EmbeddedPostgres) {
  // 18.4.0-beta.17의 비공개 field. 버전을 올리면 이 우회가 아직 필요한지 확인한다.
  const internal = cluster as unknown as { process?: ChildProcess };
  const forgetWhenExited = () => {
    const child = internal.process;
    if (!child) return;
    const forget = () => {
      if (internal.process === child) internal.process = undefined;
    };
    if (child.exitCode !== null || child.signalCode !== null) forget();
    else child.once("exit", forget);
  };
  try {
    await cluster.start();
  } catch (error) {
    forgetWhenExited();
    // embedded-postgres는 postgres가 먼저 끝나면 이유 없이 reject한다.
    throw error ?? new Error("embedded Postgres exited before it was ready");
  }
  forgetWhenExited();
}

async function ensureDatabase(url: string) {
  const client = new pg.Client({ connectionString: url });
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
  // 쉬는 연결이 끊기면(Postgres 재시작 등) pool이 그 연결을 버린다. listener가 없으면 프로세스가 죽는다.
  pool.on("error", (error) => console.error("[db]", error.message));
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
    return await openDatabase({
      embedded: { dataDir, port: await freePort(), persistent: false },
    });
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
