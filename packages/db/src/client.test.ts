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
  openDatabase,
  processIdentity,
  startEmbeddedCluster,
  withClient,
} from "./client.ts";
import { candidatePort } from "./ports.ts";
import { createTestDatabase } from "./testing.ts";

describe("embedded Postgres lifetime", () => {
  it("closes and removes a non-persistent dataDir after Postgres died on its own", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    let handle: Awaited<ReturnType<typeof openDatabase>> | undefined;
    let pid = 0;
    try {
      handle = await openDatabase({
        embedded: { dataDir, persistent: false },
      });
      const client = new pg.Client({ connectionString: handle.url });
      try {
        await client.connect();
        const { rows } = await client.query<{ pid: string }>(
          "select split_part(pg_read_file('postmaster.pid'), E'\\n', 1) as pid"
        );
        pid = Number(rows[0]!.pid);
      } finally {
        await client.end().catch(() => {});
      }

      process.kill(pid, "SIGKILL");
      const deadline = Date.now() + 15_000;
      while (isAlive(pid) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(isAlive(pid)).toBe(false);

      await handle.close();
      handle = undefined;
      expect(fs.existsSync(dataDir)).toBe(false);
    } finally {
      if (pid && isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
      await handle?.close().catch(() => {});
      await removeCluster(dataDir);
    }
  }, 60_000);

  it("lets the process exit promptly when Postgres fails to start", async () => {
    // PG_VERSION이 있어 initdb를 건너뛰지만 cluster가 아니므로 postgres가 바로 끝난다.
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    await fsp.writeFile(path.join(dataDir, "PG_VERSION"), "0\n");
    const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
    const script = `
      const { openDatabase } = await import(${JSON.stringify(clientModule)});
      await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } })
        .then(() => console.log("started"), (error) => console.log("failed:", error.message));
    `;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = exitOf(child, 30_000);
      let output = "";
      let failedAt = 0;
      child.stdout!.on("data", (chunk) => {
        output += chunk;
        failedAt ||= Date.now();
      });
      await exited;

      // 왜 끝났는지 알 수 있어야 한다. 시스템마다 이유가 달라 Postgres가 남긴 말을 그대로 보인다.
      expect(output).toMatch(
        /failed: embedded Postgres exited before it was ready: \S+/
      );
      // embedded-postgres의 종료 hook이 멈추면 exit-hook이 5초 뒤에야 강제 종료한다.
      expect(Date.now() - failedAt).toBeLessThan(4_000);
    } finally {
      if (child) await killHard(child);
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
        "uncaught error": `console.log("started"); throw new Error("boom");`,
        "process.exit": `console.log("started"); process.exit(7);`,
        // 종료 신호는 프로그램(서버 진입점 등)이 받는다. 프로그램이 어떻게 끝나든 Postgres는 멈춘다.
        // 신호 handler를 먼저 설치한 뒤 알리므로, 준비를 본 쪽이 보내는 신호를 놓치지 않는다.
        "a stop signal its program handles": `process.once("SIGHUP", () => process.exit(129)); console.log("started"); setInterval(() => {}, 1000);`,
      }[end];
      const script = `
        const { openDatabase } = await import(${JSON.stringify(clientModule)});
        await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
        ${finish}
      `;
      let pid = 0;
      let child: ReturnType<typeof spawn> | undefined;
      try {
        child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        const exited = exitOf(child, 30_000);
        const lines = lineReader(child);
        await lines.next();
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
          embedded: { dataDir, persistent: true },
        });
        await handle.close();
      } finally {
        if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
        if (child) await killHard(child);
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
        const { openDatabase } = await import(${JSON.stringify(clientModule)});
        const { default: pg } = await import("pg");
        const handle = await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
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
      let child: ReturnType<typeof spawn> | undefined;
      try {
        child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "inherit"],
        });
        child.stdin!.on("error", () => {});
        const exited = exitOf(child, 30_000);
        const lines = lineReader(child);
        backend = Number((await lines.next()).trim());
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
            try {
              process.kill(pid, "SIGCONT");
              process.kill(pid, "SIGKILL");
            } catch {
              // Between the check and the signal the process may be gone. Continue with the rest.
            }
          }
        if (child) await killHard(child);
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
      const { openDatabase } = await import(${JSON.stringify(clientModule)});
      const imported = count();
      const handle = await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: false } });
      const opened = count();
      await handle.close();
      console.log(JSON.stringify({ imported, opened }));
    `;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = exitOf(child, 30_000);
      let output = "";
      child.stdout!.on("data", (chunk) => (output += chunk));
      await exited;
      const none = {
        SIGINT: 0,
        SIGTERM: 0,
        SIGHUP: 0,
        beforeExit: 0,
        message: 0,
      };
      expect(JSON.parse(output)).toEqual({ imported: none, opened: none });
    } finally {
      if (child) await killHard(child);
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
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const held = await holdDatabase(`
        const handle = await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
        await handle.db.$client.query("create table kept (value int); insert into kept values (7)");
        console.log("ready");
      `);
      child = held.child;
      postmaster = readPostmaster(dataDir);
      await killHard(child);
      expect(isAlive(postmaster)).toBe(true);

      const handle = await openDatabase({
        embedded: { dataDir, persistent: true },
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
    } finally {
      if (child) await killHard(child);
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
        await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
        console.log("ready");
      `));
      postmaster = readPostmaster(dataDir);
      await expect(
        openDatabase({
          embedded: { dataDir, persistent: true },
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
          embedded: { dataDir, persistent: true },
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
          `${unrelated.pid}\n${dataDir}\n0\n${await candidatePort()}\n`
        );
        if (owner === "a dead process") {
          const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
          await exitOf(gone, 10_000);
          recordOwner(dataDir, { pid: gone.pid!, persistent: true });
        }
        await expect(
          openDatabase({
            embedded: { dataDir, persistent: true },
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
    let child: ReturnType<typeof spawn> | undefined;
    const client = { current: undefined as pg.Client | undefined };
    try {
      const held = await holdDatabase(`
        const handle = await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
        console.log(new URL(handle.url).port);
      `);
      child = held.child;
      postmaster = readPostmaster(dataDir);
      client.current = new pg.Client({
        connectionString: clusterUrl(Number(held.line), "postgres"),
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
          embedded: { dataDir, persistent: true },
        })
      ).rejects.toThrow(
        /did not stop in 10s\. Stop it with: .*pg_ctl.* stop -D /
      );
      expect(isAlive(postmaster)).toBe(true);
    } finally {
      if (backend && isAlive(backend)) {
        try {
          process.kill(backend, "SIGCONT");
        } catch {
          /* Between the check and the signal the process may be gone. */
        }
      }
      await client.current?.end().catch(() => {});
      if (child) await killHard(child);
      await stopPostgres(postmaster);
      await removeCluster(dataDir);
    }
  }, 60_000);

  it("is stopped and removed by the next temporary cluster when it was temporary", async () => {
    let postmaster = 0;
    let dataDir = "";
    let child: ReturnType<typeof spawn> | undefined;
    let next: Awaited<ReturnType<typeof ephemeralCluster>> | undefined;
    try {
      const held = await holdDatabase(`
        const options = await db.ephemeralCluster();
        await db.openDatabase({ embedded: options });
        console.log(options.dataDir);
      `);
      child = held.child;
      dataDir = held.line;
      postmaster = readPostmaster(dataDir);
      await killHard(child);
      expect(isAlive(postmaster)).toBe(true);

      next = await ephemeralCluster();
      expect(isAlive(postmaster)).toBe(false);
      expect(fs.existsSync(dataDir)).toBe(false);
      expect(fs.existsSync(`${dataDir}.owner`)).toBe(false);
    } finally {
      if (child) await killHard(child);
      await stopPostgres(postmaster);
      if (dataDir) await removeCluster(dataDir);
      if (next) await removeCluster(next.dataDir);
    }
  }, 60_000);

  // 같은 dataDir에 여러 프로세스가 동시에 시작하면 하나만 쓴다. 죽은 주인의 기록을 여럿이 동시에 넘겨받으려 해도 마찬가지다.
  // 진 쪽은 시작 실패를 정리하며 이긴 쪽의 Postgres를 멈추면 안 된다.
  it("lets only one of several processes starting at once use a data folder, even when they all take it over from a dead owner", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    // 새 폴더에서 셋이 동시에 cluster를 만들고 켜게 한다. 주인이 하나가 아니면 만들기·켜기를 함께 시도해 부딪힌다.
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await exitOf(gone, 10_000);
    recordOwner(dataDir, { pid: gone.pid!, persistent: true });
    const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
    const script = `
      const db = await import(${JSON.stringify(clientModule)});
      const handle = await db
        .openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } })
        .catch((error) => {
          console.log("failed: " + error.message);
          process.exit(0);
        });
      console.log("opened");
      process.stdin.once("data", async () => {
        const { rows } = await handle.db.$client.query("select 1 as one");
        console.log("query " + rows[0].one);
        await handle.close();
        process.exit(0);
      });
    `;
    const children = [0, 1, 2].map(() =>
      spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["pipe", "pipe", "inherit"],
      })
    );
    const exits = children.map((child) => exitOf(child, 30_000));
    const readers = children.map((child) => lineReader(child, 45_000));
    for (const child of children) child.stdin!.on("error", () => {});
    let postmaster = 0;
    try {
      const lines = await Promise.all(readers.map((reader) => reader.next()));
      expect(lines.filter((line) => line === "opened")).toHaveLength(1);
      const winnerIndex = lines.indexOf("opened");
      for (const [index, line] of lines.entries()) {
        if (index === winnerIndex) continue;
        expect(line).toContain("in use by a running process");
        await exits[index]!;
      }

      postmaster = readPostmaster(dataDir);
      const winner = children[winnerIndex]!;
      winner.stdin!.write("query\n");
      expect(await readers[winnerIndex]!.next()).toBe("query 1");
      await exits[winnerIndex]!;
      expect(winner.exitCode).toBe(0);
    } finally {
      for (const child of children) await killHard(child);
      await Promise.allSettled(exits);
      await stopPostgres(postmaster);
      await removeCluster(dataDir);
    }
  }, 60_000);

  // 프로세스 종료 때의 즉시 정지는 이 프로세스가 켠 Postgres에만 보낸다. 그 Postgres가 밖에서 끝나고 잠금 파일이
  // 다른 프로세스를 가리키게 되면(pid 재사용·교체) 그 프로세스에 신호를 보내면 안 된다.
  it("sends its exit-time stop only to the Postgres it started", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
    const script = `
      const db = await import(${JSON.stringify(clientModule)});
      await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
      console.log("ready");
      process.stdin.once("data", () => process.exit(1));
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        stdio: ["pipe", "pipe", "inherit"],
      }
    );
    child.stdin!.on("error", () => {});
    // Node는 SIGQUIT를 무시하므로 기본 동작으로 끝나는 프로세스를 쓴다.
    const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
    let postmaster = 0;
    try {
      const lines = lineReader(child);
      await lines.next();
      postmaster = readPostmaster(dataDir);
      process.kill(postmaster, "SIGKILL");
      const deadline = Date.now() + 10_000;
      while (isAlive(postmaster) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      fs.writeFileSync(
        path.join(dataDir, "postmaster.pid"),
        `${unrelated.pid}\n${dataDir}\n0\n0\n`
      );
      const exited = exitOf(child, 30_000);
      child.stdin!.write("end\n");
      await exited;
      await new Promise((r) => setTimeout(r, 500));
      expect(isAlive(unrelated.pid!)).toBe(true);
    } finally {
      await killHard(child);
      await killHard(unrelated);
      await stopPostgres(postmaster);
      await removeCluster(dataDir);
    }
  }, 60_000);

  // 같은 pid가 다른 프로세스에 다시 쓰이면 pid만으로는 켠 Postgres와 구별할 수 없다. 프로세스 종료 때의 즉시 정지는
  // OS가 매긴 생성 신원까지 같을 때만 보낸다. pid 재사용 자체는 만들 수 없으므로 그 판단의 재료를 확인한다:
  // 같은 프로세스는 같은 신원, 나중에 시작한 프로세스는 다른 신원, 끝난 프로세스는 신원이 없다.
  it("identifies a process by when the OS started it, so a reused pid does not look like its Postgres", async () => {
    const first = spawn("sleep", ["60"], { stdio: "ignore" });
    let second: ReturnType<typeof spawn> | undefined;
    try {
      const identity = processIdentity(first.pid!);
      expect(identity).toBeTruthy();
      expect(processIdentity(first.pid!)).toBe(identity);
      // ps의 시작 시각은 초 단위이므로 1초 넘게 뒤에 시작한다.
      await new Promise((r) => setTimeout(r, 1_100));
      second = spawn("sleep", ["60"], { stdio: "ignore" });
      expect(processIdentity(second.pid!)).toBeTruthy();
      expect(processIdentity(second.pid!)).not.toBe(identity);
      await killHard(first);
      expect(processIdentity(first.pid!)).toBeUndefined();
    } finally {
      await killHard(first);
      if (second) await killHard(second);
    }
  });

  // 임시 cluster는 dataDir와 주인 기록을 함께 가진다. 켜기 전에 실패하면(initdb 실패 등) 둘 다 남지 않아야 한다.
  it("removes a temporary cluster with its owner record when it cannot be created", async () => {
    const options = await ephemeralCluster();
    // 비어 있지 않은 폴더에는 initdb가 cluster를 만들지 않는다.
    fs.writeFileSync(path.join(options.dataDir, "unrelated"), "");
    try {
      await expect(startEmbeddedCluster(options)).rejects.toThrow(
        "could not create embedded Postgres"
      );
      expect(fs.existsSync(options.dataDir)).toBe(false);
      expect(fs.existsSync(`${options.dataDir}.owner`)).toBe(false);
    } finally {
      await removeCluster(options.dataDir);
    }
  }, 60_000);

  it("removes a temporary owner record left without its folder", async () => {
    const dataDir = path.join(
      os.tmpdir(),
      `babojubot-pg-left-${process.pid}-${Date.now()}`
    );
    fs.mkdirSync(`${dataDir}.owner`);
    fs.writeFileSync(
      path.join(`${dataDir}.owner`, "1"),
      JSON.stringify({ released: true })
    );
    let next: Awaited<ReturnType<typeof ephemeralCluster>> | undefined;
    try {
      next = await ephemeralCluster();
      expect(fs.existsSync(`${dataDir}.owner`)).toBe(false);
    } finally {
      await removeCluster(dataDir);
      if (next) await removeCluster(next.dataDir);
    }
  });

  // tmp는 다른 프로그램도 쓴다. 임시 주인 기록 이름을 한 링크가 tmp 밖 폴더를 가리켜도 그 폴더를 건드리면 안 된다.
  it("does not follow a link named like a temporary owner record", async () => {
    const outside = await fsp.mkdtemp(
      path.join(os.tmpdir(), "babojubot-outside-")
    );
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await exitOf(gone, 10_000);
    fs.writeFileSync(
      path.join(outside, "1"),
      JSON.stringify({ pid: gone.pid, persistent: false })
    );
    const link = path.join(
      os.tmpdir(),
      `babojubot-pg-link-${process.pid}-${Date.now()}.owner`
    );
    fs.symlinkSync(outside, link, "dir");
    let next: Awaited<ReturnType<typeof ephemeralCluster>> | undefined;
    try {
      next = await ephemeralCluster();
      expect(fs.readdirSync(outside)).toEqual(["1"]);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      if (next) await removeCluster(next.dataDir);
    }
  });
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
  await fsp.rm(`${dataDir}.owner`, { recursive: true, force: true });
}

/** 주인 기록을 그 프로세스가 지금 주인인 것으로 바꿔 둔다. */
function recordOwner(
  dataDir: string,
  owner: { pid: number; persistent: boolean }
) {
  const dir = `${dataDir}.owner`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "1"), JSON.stringify(owner));
}

function readPostmaster(dataDir: string) {
  return Number(
    fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0]
  );
}

/** 남은 postgres를 즉시 정지로 멈추고 끝날 때까지 기다린다. */
async function stopPostgres(pid: number) {
  if (!pid || !isAlive(pid)) return;
  try {
    process.kill(pid, "SIGQUIT");
  } catch {
    // Between the check and the signal the process may be gone.
    return;
  }
  const deadline = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* Already gone. */
    }
  }
}

type Spawned = ReturnType<typeof spawn>;

/** 자식의 stdout을 줄 단위로 나눠 둔다. 청크는 줄과 같지 않고, 자식이 끝나거나 시한이 지나면 실패한다. */
function lineReader(child: Spawned, timeoutMs = 45_000) {
  let buffer = "";
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let ended: Error | undefined;
  let exit = "no exit";
  const signal = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const onData = (chunk: Buffer | string) => {
    buffer += String(chunk);
    for (
      let index = buffer.indexOf("\n");
      index >= 0;
      index = buffer.indexOf("\n")
    ) {
      lines.push(buffer.slice(0, index).trim());
      buffer = buffer.slice(index + 1);
    }
    signal();
  };
  // 프로세스가 끝나도 stdout에는 아직 읽지 않은 줄이 남아 있을 수 있다. 스트림이 닫힌 뒤에만 포기한다.
  const onExit = (code: number | null, name: NodeJS.Signals | null) => {
    exit = `code ${code}, signal ${name}`;
    signal();
  };
  const onClose = () => {
    ended = new Error(`child ended before its next line (${exit}): ${buffer}`);
    signal();
  };
  const onError = (error: Error) => {
    ended = error;
    signal();
  };
  child.stdout!.on("data", onData);
  child.stdout!.once("close", onClose);
  child.once("exit", onExit);
  child.once("error", onError);
  return {
    async next(limit = timeoutMs) {
      const deadline = Date.now() + limit;
      while (true) {
        if (lines.length > 0) return lines.shift()!;
        if (ended) throw ended;
        const left = deadline - Date.now();
        if (left <= 0)
          throw new Error(
            `child did not print a line in ${limit}ms: ${buffer}`
          );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, left);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    },
  };
}

/** 자식이 끝날 때까지 기다리되, spawn 오류와 제한 시간도 실패로 돌려준다. */
function exitOf(child: Spawned, timeoutMs = 30_000) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      function cleanup() {
        if (timer) clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
      }
      function onExit(code: number | null, signal: NodeJS.Signals | null) {
        cleanup();
        resolve({ code, signal });
      }
      function onError(error: Error) {
        cleanup();
        reject(error);
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`child did not exit in ${timeoutMs}ms`));
      }, timeoutMs);
      child.once("exit", onExit);
      child.once("error", onError);
      if (child.exitCode !== null || child.signalCode !== null)
        onExit(child.exitCode, child.signalCode);
    }
  );
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
  try {
    const lines = lineReader(child);
    return { child, line: await lines.next() };
  } catch (error) {
    await killHard(child);
    throw error;
  }
}

/** 정리 없이 강제로 끝낸다(SIGKILL·IDE 강제 정지·OOM과 같은 상황). */
async function killHard(child: Spawned) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // spawn 자체가 실패하면 pid가 없고 exit도 오지 않는다.
  if (child.pid === undefined) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

// 종료 관찰은 spawn 직후에 붙이고, 끝나기를 기다리는 시한은 기다리기 시작할 때부터 센다.
// spawn부터 세면 오래 살아 있어야 하는 자식(경쟁에서 이긴 쪽)이 끝내라는 요청을 받기도 전에 시한이 지난다.
it("counts an exit deadline from when the wait starts, not from the spawn", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `console.log("ready"); process.stdin.once("data", () => process.exit(0));`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] }
  );
  child.stdin!.on("error", () => {});
  const exit = watchExit(child);
  try {
    await lineReader(child, 30_000).next();
    // 기다리는 시한(1초)보다 오래 산 뒤에 끝내라고 한다.
    await new Promise((r) => setTimeout(r, 1_500));
    child.stdin!.write("end\n");
    await expect(exit.within(1_000)).resolves.toEqual({
      code: 0,
      signal: null,
    });
  } finally {
    await killHard(child);
  }
}, 30_000);

// 끝나지 않는 자식을 기다리면 시한에서 그 자식을 밝혀 실패한다. 정리 단계의 기다림이 시험을 멈추지 않게 한다.
it("fails an exit wait at its deadline and names the child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exit = watchExit(child);
  try {
    await expect(exit.within(200)).rejects.toThrow(
      new RegExp(`child ${child.pid} did not exit in 200ms`)
    );
  } finally {
    await killHard(child);
  }
}, 30_000);

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
