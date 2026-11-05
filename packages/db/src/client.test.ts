import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  clusterUrl,
  ephemeralCluster,
  freePort,
  openDatabase,
  withClient,
} from "./client.ts";
import { createTestDatabase } from "./testing.ts";

describe("embedded Postgres lifetime", () => {
  it("closes and removes a non-persistent dataDir after Postgres died on its own", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const handle = await openDatabase({
      embedded: { dataDir, port: await freePort(), persistent: false },
    });
    const client = new pg.Client({ connectionString: handle.url });
    await client.connect();
    const { rows } = await client.query<{ pid: string }>(
      "select split_part(pg_read_file('postmaster.pid'), E'\\n', 1) as pid"
    );
    await client.end();
    const pid = Number(rows[0]!.pid);

    process.kill(pid, "SIGKILL");
    while (isAlive(pid)) await new Promise((r) => setTimeout(r, 50));

    await handle.close();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("lets the process exit promptly when Postgres fails to start", async () => {
    // PG_VERSION이 있어 initdb를 건너뛰지만 cluster가 아니므로 postgres가 바로 끝난다.
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    await fsp.writeFile(path.join(dataDir, "PG_VERSION"), "0\n");
    const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
    const script = `
      const { openDatabase, freePort } = await import(${JSON.stringify(clientModule)});
      const port = await freePort();
      await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port, persistent: true } })
        .then(() => console.log("started"), (error) => console.log("failed:", error.message));
    `;
    try {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      let output = "";
      let failedAt = 0;
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        failedAt ||= Date.now();
      });
      await once(child, "exit");

      // 왜 끝났는지 알 수 있어야 한다. 시스템마다 이유가 달라 Postgres가 남긴 말을 그대로 보인다.
      expect(output).toMatch(
        /failed: embedded Postgres exited before it was ready: \S+/
      );
      // embedded-postgres의 종료 hook이 멈추면 exit-hook이 5초 뒤에야 강제 종료한다.
      expect(Date.now() - failedAt).toBeLessThan(4_000);
    } finally {
      await removeCluster(dataDir);
    }
  }, 60_000);

  it.each([
    { end: "uncaught error", code: 1, signal: undefined },
    { end: "process.exit", code: 7, signal: undefined },
    {
      end: "a stop signal its program handles",
      code: 129,
      signal: "SIGHUP",
    },
  ] as const)(
    "stops Postgres so the next start works after $end",
    async ({ end, code, signal }) => {
      const dataDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "babojubot-pg-")
      );
      const clientModule = fileURLToPath(
        new URL("./client.ts", import.meta.url)
      );
      const finish = {
        "uncaught error": `throw new Error("boom");`,
        "process.exit": `process.exit(7);`,
        // 종료 신호는 프로그램(서버 진입점 등)이 받는다. 프로그램이 어떻게 끝나든 Postgres는 멈춘다.
        "a stop signal its program handles": `process.once("SIGHUP", () => process.exit(129)); setInterval(() => {}, 1000);`,
      }[end];
      const script = `
        const { openDatabase, freePort } = await import(${JSON.stringify(clientModule)});
        await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port: await freePort(), persistent: true } });
        console.log("started");
        ${finish}
      `;
      let pid = 0;
      try {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          { stdio: ["ignore", "pipe", "ignore"] }
        );
        const exited = once(child, "exit");
        await once(child.stdout!, "data");
        pid = Number(
          fs
            .readFileSync(path.join(dataDir, "postmaster.pid"), "utf8")
            .split("\n")[0]
        );
        if (signal) child.kill(signal);
        await exited;
        expect(child.exitCode).toBe(code);

        const deadline = Date.now() + 15_000;
        while (isAlive(pid) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
        expect(isAlive(pid)).toBe(false);

        const handle = await openDatabase({
          embedded: { dataDir, port: await freePort(), persistent: true },
        });
        await handle.close();
      } finally {
        if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
        await removeCluster(dataDir);
      }
    },
    60_000
  );
  // 프로세스가 끝나면 Postgres를 뒤따라 챙길 쪽이 없으므로, 그때 보내는 정지는 무엇도 기다리지 않는 즉시 정지여야 한다.
  // 빠른 정지는 연결 프로세스가 모두 끝나기를 기다리므로, 멈춘(SIGSTOP) 연결 프로세스 하나로 끝나지 않는 상황을 만든다.
  // 프로세스는 DB 정리의 어느 단계에서든 끝날 수 있다(서버 정리 시한 초과, 처리되지 않은 오류).
  it.each([
    {
      when: "before the database is closed",
      connect: `const client = new pg.Client({ connectionString: handle.url }); client.on("error", () => {}); await client.connect();`,
      close: ``,
    },
    {
      when: "while the database waits for a connection never returned to the pool",
      connect: `const client = await handle.db.$client.connect(); client.on("error", () => {});`,
      close: `void handle.close();`,
    },
    {
      when: "while Postgres is still stopping",
      connect: `const client = new pg.Client({ connectionString: handle.url }); client.on("error", () => {}); await client.connect();`,
      close: `void handle.close();`,
    },
  ])(
    "stops Postgres immediately when the process ends $when",
    async ({ connect, close }) => {
      const dataDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "babojubot-pg-")
      );
      const clientModule = fileURLToPath(
        new URL("./client.ts", import.meta.url)
      );
      const script = `
        const { openDatabase, freePort } = await import(${JSON.stringify(clientModule)});
        const { default: pg } = await import("pg");
        const handle = await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port: await freePort(), persistent: true } });
        ${connect}
        const { rows } = await client.query("select pg_backend_pid() as pid");
        console.log(rows[0].pid);
        process.stdin.once("data", () => {
          ${close}
          setTimeout(() => process.exit(1), 1000);
        });
      `;
      let postmaster = 0;
      let backend = 0;
      try {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          { stdio: ["pipe", "pipe", "inherit"] }
        );
        const exited = once(child, "exit");
        const [line] = await once(child.stdout!, "data");
        backend = Number(String(line).trim());
        postmaster = Number(
          fs
            .readFileSync(path.join(dataDir, "postmaster.pid"), "utf8")
            .split("\n")[0]
        );
        process.kill(backend, "SIGSTOP");
        child.stdin!.write("end\n");
        await exited;
        expect(child.exitCode).toBe(1);

        const deadline = Date.now() + 20_000;
        while (isAlive(postmaster) && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
        expect(isAlive(postmaster)).toBe(false);
      } finally {
        for (const pid of [backend, postmaster])
          if (pid && isAlive(pid)) {
            process.kill(pid, "SIGCONT");
            process.kill(pid, "SIGKILL");
          }
        await removeCluster(dataDir);
      }
    },
    60_000
  );

  // 종료 신호와 종료 순서는 프로그램이 정한다. DB를 불러오거나 열기만 해도 신호를 가로채 먼저 끝내면
  // 서버가 정리하는 동안 DB가 사라진다(외부 DB여도 프로세스가 바로 끝난다).
  it("leaves stop signals to the program that imports it and opens a database", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
    const script = `
      const events = ["SIGINT", "SIGTERM", "SIGHUP", "beforeExit", "message"];
      const count = () => Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
      const { openDatabase, freePort } = await import(${JSON.stringify(clientModule)});
      const imported = count();
      const handle = await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port: await freePort(), persistent: false } });
      const opened = count();
      await handle.close();
      console.log(JSON.stringify({ imported, opened }));
    `;
    try {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      let output = "";
      child.stdout!.on("data", (chunk) => (output += chunk));
      await once(child, "exit");
      const none = {
        SIGINT: 0,
        SIGTERM: 0,
        SIGHUP: 0,
        beforeExit: 0,
        message: 0,
      };
      expect(JSON.parse(output)).toEqual({ imported: none, opened: none });
    } finally {
      await removeCluster(dataDir);
    }
  }, 60_000);
});

// 서버가 정리 없이 끝나면(SIGKILL·IDE 강제 정지·OOM) Postgres가 남아 다음 시작이 dataDir 잠금으로 실패했다.
// 다음 시작은 기록된 주인이 죽었고 그 서버가 이 dataDir를 쓰는 것이 확인될 때만 남은 Postgres를 정상 정지한다.
describe("a Postgres left by a killed process", () => {
  it("is stopped normally by the next start, which keeps its data", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    let postmaster = 0;
    try {
      const { child } = await holdDatabase(`
        const handle = await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port: await db.freePort(), persistent: true } });
        await handle.db.$client.query("create table kept (value int); insert into kept values (7)");
        console.log("ready");
      `);
      postmaster = readPostmaster(dataDir);
      await killHard(child);
      expect(isAlive(postmaster)).toBe(true);

      const handle = await openDatabase({
        embedded: { dataDir, port: await freePort(), persistent: true },
      });
      try {
        expect(isAlive(postmaster)).toBe(false);
        const { rows } = await (
          handle.db as unknown as { $client: pg.Pool }
        ).$client.query("select value from kept");
        expect(rows).toEqual([{ value: 7 }]);
        // 정상 정지였으면 새 Postgres가 복구 과정 없이 시작한다.
        const log = fs.readFileSync(path.join(dataDir, "postgres.log"), "utf8");
        expect(log).toContain("database system was shut down");
        expect(log).not.toContain("not properly shut down");
      } finally {
        await handle.close();
      }
      expect(fs.existsSync(path.join(dataDir, "postmaster.pid"))).toBe(false);
      expect(fs.existsSync(`${dataDir}.owner.json`)).toBe(false);
    } finally {
      await stopPostgres(postmaster);
      await removeCluster(dataDir);
    }
  }, 60_000);

  it("is left alone while the process that opened it still runs", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    let postmaster = 0;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      ({ child } = await holdDatabase(`
        await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port: await db.freePort(), persistent: true } });
        console.log("ready");
      `));
      postmaster = readPostmaster(dataDir);
      await expect(
        openDatabase({
          embedded: { dataDir, port: await freePort(), persistent: true },
        })
      ).rejects.toThrow(`in use by a running process (pid ${child.pid})`);
      expect(isAlive(postmaster)).toBe(true);
    } finally {
      if (child) await killHard(child);
      await stopPostgres(postmaster);
      await removeCluster(dataDir);
    }
  }, 60_000);

  // 잠금 파일의 pid가 무관한 프로세스를 가리킬 수 있다(pid 재사용). 그 프로세스를 멈추지 않고 시작을 멈춘다.
  it.each([
    {
      owner: "a dead process",
      message: "could not be confirmed as its server",
    },
    { owner: "no record", message: "has no record of starting it" },
  ])(
    "does not stop a process it cannot confirm as its Postgres ($owner)",
    async ({ owner, message }) => {
      const dataDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "babojubot-pg-")
      );
      await (
        await openDatabase({
          embedded: { dataDir, port: await freePort(), persistent: true },
        })
      ).close();
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        }
      );
      try {
        fs.writeFileSync(
          path.join(dataDir, "postmaster.pid"),
          `${unrelated.pid}\n${dataDir}\n0\n${await freePort()}\n`
        );
        if (owner === "a dead process") {
          const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
          await once(gone, "exit");
          fs.writeFileSync(
            `${dataDir}.owner.json`,
            JSON.stringify({ pid: gone.pid, persistent: true })
          );
        }
        await expect(
          openDatabase({
            embedded: { dataDir, port: await freePort(), persistent: true },
          })
        ).rejects.toThrow(message);
        expect(isAlive(unrelated.pid!)).toBe(true);
      } finally {
        await killHard(unrelated);
        await removeCluster(dataDir);
      }
    },
    60_000
  );

  // 정상 정지는 연결 프로세스가 모두 끝나기를 기다린다. 멈춘(SIGSTOP) 연결 프로세스 하나로 끝나지 않는 상황을 만든다.
  it("halts the start with how to stop it when it does not stop in time", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    let postmaster = 0;
    let backend = 0;
    const client = { current: undefined as pg.Client | undefined };
    try {
      const { child, line } = await holdDatabase(`
        const handle = await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, port: await db.freePort(), persistent: true } });
        console.log(new URL(handle.url).port);
      `);
      postmaster = readPostmaster(dataDir);
      client.current = new pg.Client({
        connectionString: clusterUrl(Number(line), "postgres"),
      });
      client.current.on("error", () => {});
      await client.current.connect();
      const { rows } = await client.current.query<{ pid: number }>(
        "select pg_backend_pid() as pid"
      );
      backend = rows[0]!.pid;
      process.kill(backend, "SIGSTOP");
      await killHard(child);

      await expect(
        openDatabase({
          embedded: { dataDir, port: await freePort(), persistent: true },
        })
      ).rejects.toThrow(
        /did not stop in 10s\. Stop it with: .*pg_ctl.* stop -D /
      );
      expect(isAlive(postmaster)).toBe(true);
    } finally {
      if (backend && isAlive(backend)) process.kill(backend, "SIGCONT");
      await client.current?.end().catch(() => {});
      await stopPostgres(postmaster);
      await removeCluster(dataDir);
    }
  }, 60_000);

  it("is stopped and removed by the next temporary cluster when it was temporary", async () => {
    let postmaster = 0;
    let dataDir = "";
    let next: Awaited<ReturnType<typeof ephemeralCluster>> | undefined;
    try {
      const held = await holdDatabase(`
        const options = await db.ephemeralCluster();
        await db.openDatabase({ embedded: options });
        console.log(options.dataDir);
      `);
      dataDir = held.line;
      postmaster = readPostmaster(dataDir);
      await killHard(held.child);
      expect(isAlive(postmaster)).toBe(true);

      next = await ephemeralCluster();
      expect(isAlive(postmaster)).toBe(false);
      expect(fs.existsSync(dataDir)).toBe(false);
      expect(fs.existsSync(`${dataDir}.owner.json`)).toBe(false);
    } finally {
      await stopPostgres(postmaster);
      if (dataDir) await removeCluster(dataDir);
      if (next) await removeCluster(next.dataDir);
    }
  }, 60_000);
});

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 테스트가 만든 cluster 폴더와 그 옆의 주인 기록을 지운다. */
async function removeCluster(dataDir: string) {
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(`${dataDir}.owner.json`, { force: true });
}

function readPostmaster(dataDir: string) {
  return Number(
    fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0]
  );
}

/** 남은 postgres를 즉시 정지로 멈추고 끝날 때까지 기다린다. */
async function stopPostgres(pid: number) {
  if (!pid || !isAlive(pid)) return;
  process.kill(pid, "SIGQUIT");
  const deadline = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
}

/** DB를 열고 살아 있는 자식 프로세스. `line`은 자식이 처음 출력한 줄이다. `db`가 client.ts 모듈이다. */
async function holdDatabase(open: string) {
  const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
  const script = `
    const db = await import(${JSON.stringify(clientModule)});
    ${open}
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = await once(child.stdout!, "data");
  return { child, line: String(line).trim() };
}

/** 정리 없이 강제로 끝낸다(SIGKILL·IDE 강제 정지·OOM과 같은 상황). */
async function killHard(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

// 쓰는 중인 연결이 끊기면(Postgres 재시작·종료) 그 일만 실패하고 프로세스는 살아 있어야 한다.
// 서버 종료 때 Postgres가 먼저 멈추면 처리되지 않은 오류로 죽어 임시 DB 폴더를 지우지 못했다.
it("fails only the work on a connection cut while in use, without crashing the process", async () => {
  const database = await createTestDatabase();
  try {
    const work = database.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`
      );
      await withClient(database.url, (client) =>
        client.query("select pg_terminate_backend($1)", [rows[0]!.pid])
      );
      await new Promise((r) => setTimeout(r, 200));
      await tx.execute(sql`select 1`);
    });
    await expect(work).rejects.toThrow();
  } finally {
    await database.close();
  }
});
