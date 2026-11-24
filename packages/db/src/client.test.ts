import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clusterUrl,
  ephemeralCluster,
  openDatabase,
  processIdentity,
  startEmbeddedCluster,
  withClient,
} from "./client.ts";
import { candidatePort } from "./ports.ts";
import { psField } from "@babojubot/process";
import { createTestDatabase } from "./testing.ts";
import { removeFolder } from "@babojubot/process/remove-folder";
import {
  awaitedLater,
  folderCleanup,
  killUnlessGone,
  processAlive,
  withCleanup,
} from "@babojubot/process/test-cleanup";
import {
  attemptAll,
  attemptEach,
  combinedFailure,
  hasErrorCode,
  orIfMissing,
} from "@babojubot/contracts";
import { within } from "@babojubot/process/test-support";

/**
 * 붙잡을 단계(#286). 놓기 전까지 그 단계는 끝나지 않는다. `stop`은 다음 `pg_ctl stop` 호출, `remove`는 그 폴더의 다음 지우기다.
 * 붙잡지 않으면 실제 함수를 그대로 부른다.
 */
const holds = vi.hoisted(() => ({
  stop: undefined as
    { reached: () => void; released: Promise<void> } | undefined,
  remove: undefined as
    | { target: string; reached: () => void; released: Promise<void> }
    | undefined,
}));
vi.mock("@babojubot/process", async (original) => {
  const real = await original<typeof import("@babojubot/process")>();
  const runCommand = (async (...args: Parameters<typeof real.runCommand>) => {
    const hold = holds.stop;
    if (hold && args[1][0] === "stop") {
      holds.stop = undefined;
      hold.reached();
      await hold.released;
    }
    return real.runCommand(...args);
  }) as typeof real.runCommand;
  return { ...real, runCommand };
});
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const rm: typeof real.rm = async (target, options) => {
    const hold = holds.remove;
    if (hold && String(target) === hold.target) {
      holds.remove = undefined;
      hold.reached();
      await hold.released;
    }
    return real.rm(target, options);
  };
  return { ...real, rm, default: { ...real, rm } };
});

/** 다음 그 단계를 붙잡는다. `reached`는 그 단계에 닿았을 때, `release`는 놓는다(여러 번 불러도 된다). */
function holdNext(step: "stop" | "remove", target = "") {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  if (step === "stop") holds.stop = { reached: reach, released };
  else holds.remove = { target, reached: reach, released };
  onTestFinished(() => {
    holds[step] = undefined;
    release();
  });
  return { reached, release };
}

describe("embedded Postgres lifetime", () => {
  // 정리 시한이 지나면 서버가 DB를 닫다 어디서 멈췄는지 알린다(apps/server/src/shutdown.ts). 단계마다 그 단계를 붙잡아 둔 동안
  // 알리는 단계를 본다(#286): 연결 닫기는 빌려 둔 연결이, Postgres 정지는 `pg_ctl stop` 호출이, 임시 폴더 지우기는 그 폴더의 지우기가
  // 놓일 때까지 끝나지 않는다. 이벤트 루프 차례마다 표본으로 읽으면 짧은 단계는 놓치고, 본 단계도 그 단계에서 본 것인지 모른다.
  it("reports what closing is doing, from the connections to stopping Postgres", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    const handle = await openDatabase({
      embedded: { dataDir, persistent: false },
    });
    const stop = holdNext("stop");
    const remove = holdNext("remove", dataDir);
    // 닫기는 이 시험의 대상이다. 시험이 닫기 전에 실패해도 정리가 붙잡은 단계를 놓고 닫은 뒤에 폴더를 지운다(한 번만 닫는다).
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= handle.close());
    // 연결 하나를 트랜잭션으로 빌려 둔다. 놓을 때까지 연결 닫기(pool.end)는 끝나지 않는다.
    let giveBack!: () => void;
    const given = new Promise<void>((resolve) => (giveBack = resolve));
    let borrowedConnection!: () => void;
    const connectionBorrowed = new Promise<void>(
      (resolve) => (borrowedConnection = resolve)
    );
    cluster.own(() => {
      giveBack();
      stop.release();
      remove.release();
      return close();
    });
    expect(handle.progress()).toBe("open");
    const borrowed = awaitedLater(
      handle.db.transaction(async () => {
        borrowedConnection();
        await given;
      })
    );
    await within(connectionBorrowed, 30_000, "no connection was borrowed");
    const closed = awaitedLater(close());
    expect(handle.progress()).toBe("closing connections");
    giveBack();
    await borrowed;
    await within(stop.reached, 30_000, "closing did not stop Postgres");
    expect(handle.progress()).toBe("stopping Postgres (fast)");
    stop.release();
    await within(
      remove.reached,
      30_000,
      "closing did not remove its temporary folder"
    );
    expect(handle.progress()).toBe("removing its temporary folder");
    remove.release();
    await closed;
    expect(handle.progress()).toBe("closed");
  }, 60_000);

  // 임시 cluster는 멈출 때 지우므로 디스크에 확정 기록(fsync)을 기다릴 까닭이 없다. 기다리면 정지 때 밀린 기록을 확정하느라
  // 디스크가 느린 곳(Windows CI의 OS 디스크)에서 몇 초씩 걸려 서버 정리 시한을 넘긴다. 영구 DB는 확정 기록을 그대로 한다.
  it.each([
    { kind: "a temporary", persistent: false, setting: "off" },
    { kind: "a persistent", persistent: true, setting: "on" },
  ])(
    "turns durable disk writes $setting in $kind cluster",
    async ({ persistent, setting }) => {
      const dataDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "babojubot-pg-")
      );
      const cluster = folderCleanup(() => removeCluster(dataDir));
      onTestFinished(cluster.cleanUp);
      const handle = await openDatabase({
        embedded: { dataDir, persistent },
      });
      cluster.own(() => handle.close());
      const { rows } = await withClient(handle.url, (client) =>
        client.query<{ name: string; setting: string }>(
          "select name, setting from pg_settings where name in ('fsync', 'synchronous_commit', 'full_page_writes') order by name"
        )
      );
      expect(rows).toEqual([
        { name: "fsync", setting },
        { name: "full_page_writes", setting },
        { name: "synchronous_commit", setting },
      ]);
    },
    60_000
  );

  it("closes and removes a non-persistent dataDir after Postgres died on its own", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const seen: { postgres?: Postgres } = {};
    let closed = false;
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    const handle = await openDatabase({
      embedded: { dataDir, persistent: false },
    });
    // 시험이 닫지 못했을 때만 닫는다. Postgres가 먼저 죽어도 닫기는 성공해야 한다(이 시험이 보는 것). 실패하면 그 오류를 알린다.
    cluster.own(async () => {
      if (!closed) await handle.close();
    });
    cluster.own(() =>
      seen.postgres ? killPostgres(seen.postgres) : undefined
    );
    // 연결을 받은 서버에게 번호를 묻는다. 그 서버가 도는 동안 신원을 함께 잡는다.
    const started = identified(
      Number(
        await withClient(handle.url, async (client) => {
          const { rows } = await client.query<{ pid: string }>(
            "select split_part(pg_read_file('postmaster.pid'), E'\\n', 1) as pid"
          );
          return rows[0]!.pid;
        })
      )
    );
    seen.postgres = started;

    process.kill(started.pid, "SIGKILL");
    await expect
      .poll(() => stateOf(started), { timeout: 15_000, interval: 50 })
      .toBe("ended");

    await handle.close();
    closed = true;
    expect(fs.existsSync(dataDir)).toBe(false);
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
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    cluster.own(() => killHard(child));
    const exited = watchExit(child);
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    // `exit` 때 출력은 아직 열려 있을 수 있다. 출력의 끝은 따로 기다린 뒤 읽는다(#286).
    const outputEnded = awaitedLater(finished(child.stdout!));
    // 시작에 실패한 뒤 프로세스를 붙잡는 것이 없어 스스로(신호 없이 0으로) 끝난다. 붙잡혔다면 이 기다림이 실패한다.
    // 이 시험을 만들 때 가르던 것(embedded-postgres가 등록한 exit-hook이 멈춘 종료 hook을 5초 뒤에야 강제로 끝냄)은 그
    // 등록을 지운 pnpm 패치(patches/embedded-postgres@18.6.0-beta.19.patch)로 없어졌다. 걸린 시간은 재지 않는다(CODING_STANDARDS.md#시간).
    expect(await exited.within(30_000)).toEqual({ code: 0, signal: null });
    await within(outputEnded, 10_000, "the child's output did not end");

    // 왜 끝났는지 알 수 있어야 한다. 시스템마다 이유가 달라 Postgres가 남긴 말을 그대로 보인다.
    expect(output).toMatch(
      /failed: embedded Postgres exited before it was ready: \S+/
    );
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
        "uncaught error": `process.stdout.write("started\\n", () => { throw new Error("boom"); });`,
        "process.exit": `process.stdout.write("started\\n", () => process.exit(7));`,
        // 종료 신호는 프로그램(서버 진입점 등)이 받는다. 프로그램이 어떻게 끝나든 Postgres는 멈춘다.
        // 신호 handler를 먼저 설치한 뒤 알리므로, 준비를 본 쪽이 보내는 신호를 놓치지 않는다.
        "a stop signal its program handles": `process.once("SIGHUP", () => process.exit(129)); console.log("started"); setInterval(() => {}, 1000);`,
      }[end];
      // Postgres 번호와 그 신원은 자식이 알린다(그때 Postgres는 자식이 쥐고 있어 살아 있다). 자식은 알린 직후 끝나며 Postgres를
      // 멈추므로, 시험이 그 뒤에 잠금 파일을 읽거나 신원을 보면 이미 없을 수 있다.
      const script = `
        const { openDatabase, processIdentity } = await import(${JSON.stringify(clientModule)});
        const { readFileSync } = await import("node:fs");
        await openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
        const pid = Number(readFileSync(${JSON.stringify(path.join(dataDir, "postmaster.pid"))}, "utf8").split("\\n")[0]);
        console.log(pid + " " + processIdentity(pid));
        ${finish}
      `;
      const seen: { postgres?: Postgres } = {};
      const cluster = folderCleanup(() => removeCluster(dataDir));
      onTestFinished(cluster.cleanUp);
      cluster.own(async () => {
        const target = await postgresIn(dataDir, seen.postgres);
        if (target) await killPostgres(target);
      });
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      cluster.own(() => killHard(child));
      const exited = watchExit(child);
      const lines = lineReader(child);
      const [pid, identity] = (await lines.next()).split(" ");
      expect(Number(pid)).toBeGreaterThan(0);
      expect(identity).not.toBe("undefined");
      const started: Postgres = { pid: Number(pid), identity: identity! };
      seen.postgres = started;
      await lines.next();
      if (signal) child.kill(signal);
      await exited.within(30_000);
      expect(child.exitCode).toBe(code);

      await expect
        .poll(() => stateOf(started), { timeout: 15_000, interval: 50 })
        .toBe("ended");

      const handle = await openDatabase({
        embedded: { dataDir, persistent: true },
      });
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= handle.close());
      cluster.own(close);
      await close();
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
      const seen: { postmaster?: Postgres; backend?: Postgres } = {};
      const cluster = folderCleanup(() => removeCluster(dataDir));
      onTestFinished(cluster.cleanUp);
      cluster.own(async () => {
        const left = await postgresIn(dataDir, seen.postmaster);
        await killPostgres(
          ...[seen.backend, left].filter((target) => target !== undefined)
        );
      });
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["pipe", "pipe", "inherit"] }
      );
      cluster.own(() => killHard(child));
      child.stdin!.on("error", () => {});
      const exited = watchExit(child);
      const lines = lineReader(child);
      // 자식이 연결을 쥐고 기다리는 동안이라 둘 다 돈다. 그때 신원을 잡는다.
      const stopped = identified(Number((await lines.next()).trim()));
      seen.backend = stopped;
      const started = identified(readPostmaster(dataDir));
      seen.postmaster = started;
      process.kill(stopped.pid, "SIGSTOP");
      child.stdin!.write("end\n");
      await exited.within(30_000);
      expect(child.exitCode).toBe(1);

      await expect
        .poll(() => stateOf(started), { timeout: 20_000, interval: 50 })
        .toBe("ended");
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
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    cluster.own(() => killHard(child));
    const exited = watchExit(child);
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    // `exit` 때 출력은 아직 열려 있을 수 있다. 출력의 끝은 따로 기다린 뒤 읽는다(#286).
    const outputEnded = awaitedLater(finished(child.stdout!));
    await exited.within(30_000);
    await within(outputEnded, 10_000, "the child's output did not end");
    const none = {
      SIGINT: 0,
      SIGTERM: 0,
      SIGHUP: 0,
      beforeExit: 0,
      message: 0,
    };
    expect(JSON.parse(output)).toEqual({ imported: none, opened: none });
  }, 60_000);
});

// 서버가 정리 없이 끝나면(SIGKILL·IDE 강제 정지·OOM) Postgres가 남아 다음 시작이 dataDir 잠금으로 실패했다.
// 다음 시작은 기록된 주인이 죽었고 그 서버가 이 dataDir를 쓰는 것이 확인될 때만 남은 Postgres를 정상 정지한다.
describe("a Postgres left by a killed process", () => {
  it("is stopped normally by the next start, which keeps its data", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const seen: { postgres?: Postgres } = {};
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    cluster.own(async () =>
      stopPostgres(await postgresIn(dataDir, seen.postgres))
    );
    const { child } = await holdDatabase(`
      const handle = await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
      await handle.db.$client.query("create table kept (value int); insert into kept values (7)");
      console.log("ready");
    `);
    cluster.own(() => killHard(child));
    const postgres = identified(readPostmaster(dataDir));
    seen.postgres = postgres;
    const postmaster = postgres.pid;
    await killHard(child);
    expect(isAlive(postmaster)).toBe(true);

    // 다음 시작이 연 DB는 정지 기록을 보려고 시험 중간에 닫는다.
    await withCleanup(async (defer) => {
      const handle = await openDatabase({
        embedded: { dataDir, persistent: true },
      });
      defer(() => handle.close());
      expect(isAlive(postmaster)).toBe(false);
      const { rows } = await handle.db.execute(sql`select value from kept`);
      expect(rows).toEqual([{ value: 7 }]);
      // 정상 정지였으면 새 Postgres가 복구 과정 없이 시작한다.
      const log = fs.readFileSync(path.join(dataDir, "postgres.log"), "utf8");
      expect(log).toContain("database system was shut down");
      expect(log).not.toContain("not properly shut down");
    });
    expect(fs.existsSync(path.join(dataDir, "postmaster.pid"))).toBe(false);
  }, 60_000);

  it("is left alone while the process that opened it still runs", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const seen: { postgres?: Postgres } = {};
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    cluster.own(async () =>
      stopPostgres(await postgresIn(dataDir, seen.postgres))
    );
    const { child } = await holdDatabase(`
      await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
      console.log("ready");
    `);
    cluster.own(() => killHard(child));
    const postgres = identified(readPostmaster(dataDir));
    seen.postgres = postgres;
    const postmaster = postgres.pid;
    await expect(
      openDatabase({
        embedded: { dataDir, persistent: true },
      })
    ).rejects.toMatchObject({
      code: "EMBEDDED_IN_USE",
      message: expect.stringContaining(
        `in use by a running process (pid ${child.pid})`
      ),
    });
    expect(isAlive(postmaster)).toBe(true);
  }, 60_000);

  // #288 리뷰 2회차 STD-2와 같은 모양: 자식이 Postgres를 띄운 뒤 준비 줄 전에 죽으면(SIGKILL이라 종료 hook도 돌지 않음), 시험은 그
  // Postgres의 번호를 받지 못한다. 정리는 그래도 그 Postgres를 끄고 나서 폴더를 지운다.
  it("stops the Postgres a child started when the child dies before its ready line", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    cluster.own(async () => stopPostgres(await postgresIn(dataDir, undefined)));
    await expect(
      holdDatabase(`
        await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
        process.kill(process.pid, "SIGKILL");
      `)
    ).rejects.toThrow(/child ended before its next line/);
    const started = identified(readPostmaster(dataDir));
    await cluster.cleanUp();
    expect(stateOf(started)).toBe("ended");
  }, 60_000);

  // #288 parent 점검(번호 신원): Postgres가 이미 죽고 잠금 파일만 남은 뒤 그 번호를 무관한 프로그램이 받았으면, 정리는 그 번호로
  // 신호하지 않고 확인하지 못한 이유로 실패한다. 잠금 파일의 번호만 믿으면 남의 프로그램에 신호한다.
  it("does not signal the pid of a lock file left behind when an unrelated program has that pid", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    onTestFinished(() => removeCluster(dataDir));
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    onTestFinished(() => killHard(unrelated));
    // 듣는 쪽이 없는 port를 적은 남은 잠금 파일. 번호는 지금 도는 무관한 프로그램의 것이다.
    fs.writeFileSync(
      path.join(dataDir, "postmaster.pid"),
      `${unrelated.pid}\n${dataDir}\n0\n${await candidatePort()}\n`
    );
    const kill = process.kill.bind(process);
    const sent: [number, string | number | undefined][] = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      sent.push([pid, signal]);
      return kill(pid, signal);
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const stopping: unknown = await (async () =>
      stopPostgres(await postgresIn(dataDir, undefined)))().then(
      () => new Error("the cleanup passed without confirming the Postgres"),
      (error: unknown) => error
    );
    expect(
      sent.filter(([pid, signal]) => pid === unrelated.pid && signal !== 0)
    ).toEqual([]);
    expect(stopping).toMatchObject({
      message: expect.stringContaining("could not be confirmed"),
    });
  }, 60_000);

  // 주인이 살아 있는지는 기록한 번호가 아니라 주인이 쥔 연결로 본다(#268). 번호는 주인이 죽은 뒤 다른 프로그램에 다시 주어지거나,
  // 거두지 않은 채(좀비) 남아 "살아 있음"으로 보일 수 있다. 연결은 주인이 죽으면 OS가 닫는다. 기록한 번호의 프로그램이 돌아도
  // 연결이 없으면 주인이 죽은 것이다. 주인 기록과 연결은 제품이 만든다(#286 항목 11): 그 기록으로 주인이 살아 있는 동안은 거부되고,
  // 같은 기록을 둔 채 주인이 죽은 뒤에야 넘겨받는다. 손으로 쓴 기록이면 해석기가 그 기록을 버려도 같은 결과라 인과를 보지 못한다.
  it("takes over a folder whose recorded owner no longer holds its connection, even when its process id belongs to a running program", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const seen: { postgres?: Postgres } = {};
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    cluster.own(async () =>
      stopPostgres(await postgresIn(dataDir, seen.postgres))
    );
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    cluster.own(() => killHard(unrelated));
    const { child: owner } = await holdDatabase(`
      await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
      console.log("ready");
    `);
    cluster.own(() => killHard(owner));
    const postgres = identified(readPostmaster(dataDir));
    seen.postgres = postgres;
    const owners = `${dataDir}.owner`;
    const [generation, ...others] = fs.readdirSync(owners);
    expect(others).toEqual([]);
    const recordFile = path.join(owners, generation!);
    const record: unknown = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    expect(record).toEqual({
      pid: owner.pid,
      persistent: true,
      handle: expect.any(String),
    });

    // 주인이 살아 있는 동안은 그 기록으로 거부된다.
    await expect(
      openDatabase({ embedded: { dataDir, persistent: true } })
    ).rejects.toMatchObject({
      code: "EMBEDDED_IN_USE",
      message: expect.stringContaining(
        `in use by a running process (pid ${owner.pid})`
      ),
    });

    // 주인이 죽어 연결이 닫히고, 기록한 번호는 다른 프로그램에 다시 주어졌다(번호 재사용은 OS가 정해 시험이 일으킬 수 없어, 같은
    // 기록의 번호만 지금 도는 무관한 프로그램의 번호로 바꾼다). 주인 연결의 자리는 제품이 쓴 그대로다.
    await killHard(owner);
    fs.writeFileSync(
      recordFile,
      JSON.stringify({ ...(record as object), pid: unrelated.pid })
    );
    await withCleanup(async (defer) => {
      const handle = await openDatabase({
        embedded: { dataDir, persistent: true },
      });
      defer(() => handle.close());
      const { rows } = await handle.db.execute(sql`select 1 as one`);
      expect(rows).toEqual([{ one: 1 }]);
    });
    expect(isAlive(unrelated.pid!)).toBe(true);
  }, 60_000);

  // 주인 연결의 소켓 경로는 OS 한도(Linux 107, macOS 103) 안이어야 한다. 임시 폴더를 깊게 바꿔도(boot-check처럼) 이 사용자 전용
  // 폴더로 옮겨 시작한다. Windows는 named pipe라 경로 한도가 없다.
  it.skipIf(process.platform === "win32")(
    "keeps its owner connection under the socket path limit when the temporary folder has a long path",
    async () => {
      const dataDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "babojubot-pg-")
      );
      const long = await fsp.mkdtemp(
        path.join(os.tmpdir(), `babojubot-long-${"x".repeat(90)}-`)
      );
      const cluster = folderCleanup(() =>
        attemptAll([() => removeCluster(dataDir), () => removeFolder(long)])
      );
      onTestFinished(cluster.cleanUp);
      vi.stubEnv("TMPDIR", long);
      vi.stubEnv("XDG_RUNTIME_DIR", "");
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      await withCleanup(async (defer) => {
        const handle = await openDatabase({
          embedded: { dataDir, persistent: true },
        });
        defer(() => handle.close());
        const { rows } = await handle.db.execute(sql`select 1 as one`);
        expect(rows).toEqual([{ one: 1 }]);
      });
    },
    60_000
  );

  // 잠금 파일의 pid가 무관한 프로세스를 가리킬 수 있다(pid 재사용). 그 프로세스를 멈추지 않고 시작을 멈춘다.
  it.each([
    {
      owner: "a dead process",
      message: "could not be confirmed as its server",
      code: "EMBEDDED_POSTGRES_UNCONFIRMED",
    },
    {
      owner: "no record",
      message: "has no record of starting it",
      code: "EMBEDDED_POSTGRES_UNKNOWN",
    },
  ])(
    "does not stop a process it cannot confirm as its Postgres ($owner)",
    async ({ owner, message, code }) => {
      const dataDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "babojubot-pg-")
      );
      const cluster = folderCleanup(() => removeCluster(dataDir));
      onTestFinished(cluster.cleanUp);
      const opened = await openDatabase({
        embedded: { dataDir, persistent: true },
      });
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= opened.close());
      cluster.own(close);
      await close();
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        }
      );
      cluster.own(() => killHard(unrelated));
      fs.writeFileSync(
        path.join(dataDir, "postmaster.pid"),
        `${unrelated.pid}\n${dataDir}\n0\n${await candidatePort()}\n`
      );
      if (owner === "a dead process") {
        const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        await watchExit(gone).within(10_000);
        await recordOwner(dataDir, { pid: gone.pid!, persistent: true });
      }
      await expect(
        openDatabase({
          embedded: { dataDir, persistent: true },
        })
      ).rejects.toMatchObject({
        code,
        message: expect.stringContaining(message),
      });
      expect(isAlive(unrelated.pid!)).toBe(true);
    },
    60_000
  );

  // 정상 정지는 연결 프로세스가 모두 끝나기를 기다린다. 멈춘(SIGSTOP) 연결 프로세스 하나로 끝나지 않는 상황을 만든다.
  it("halts the start with how to stop it when it does not stop in time", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    const seen: { postgres?: Postgres } = {};
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    cluster.own(async () =>
      stopPostgres(await postgresIn(dataDir, seen.postgres))
    );
    const held = await holdDatabase(`
        const handle = await db.openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } });
        console.log(new URL(handle.url).port);
      `);
    cluster.own(() => killHard(held.child));
    const postgres = identified(readPostmaster(dataDir));
    seen.postgres = postgres;
    const postmaster = postgres.pid;
    const client = new pg.Client({
      connectionString: clusterUrl(Number(held.line), "postgres"),
    });
    client.on("error", () => {});
    await client.connect();
    // pg의 end는 연결이 이미 끊겼으면 바로 이행하고, 아니면 연결의 끝을 기다린다. 그 끝을 상한 안에서 확인한다.
    cluster.own(() =>
      within(client.end(), 10_000, "the test's Postgres client did not close")
    );
    const { rows } = await client.query<{ pid: number }>(
      "select pg_backend_pid() as pid"
    );
    // 연결이 열려 있어 그 backend는 돈다. 그때 신원을 잡는다.
    const backend = identified(rows[0]!.pid);
    process.kill(backend.pid, "SIGSTOP");
    // 멈춘 연결 프로세스를 먼저 풀어야 Postgres가 정지한다. 같은 신원으로 돌 때만 그 번호로 신호한다.
    cluster.own(() => {
      if (stateOf(backend) === "running")
        killUnlessGone(backend.pid, "SIGCONT");
    });
    await killHard(held.child);

    await expect(
      openDatabase({
        embedded: { dataDir, persistent: true },
      })
    ).rejects.toMatchObject({
      code: "EMBEDDED_STOP_TIMEOUT",
      message: expect.stringMatching(
        /did not stop in 10s\. Stop it with: .*pg_ctl.* stop -D /
      ),
    });
    expect(isAlive(postmaster)).toBe(true);
  }, 60_000);

  it("is stopped and removed by the next temporary cluster when it was temporary", async () => {
    // 자식과 이 시험의 임시 폴더를 이 시험 소유 폴더로 둔다. 자식은 임시 cluster의 자리를 준비 줄로 알리므로, 그 줄 전에 실패해도
    // 정리가 이 폴더 안의 임시 cluster마다 켜진 Postgres를 찾아 끈다(#288 리뷰 2회차 STD-2와 같은 모양).
    const base = await fsp.mkdtemp(
      path.join(os.tmpdir(), "babojubot-ephemeral-")
    );
    for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, base);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const seen: { postgres?: Postgres } = {};
    let dataDir = "";
    const cluster = folderCleanup(() => removeFolder(base));
    onTestFinished(cluster.cleanUp);
    cluster.own(() =>
      attemptAll(
        fs
          .readdirSync(base)
          .filter((name) => name.startsWith("babojubot-pg-"))
          .map((name) => path.join(base, name))
          .map(
            (folder) => async () =>
              stopPostgres(
                await postgresIn(
                  folder,
                  folder === dataDir ? seen.postgres : undefined
                )
              )
          )
      )
    );
    const held = await holdDatabase(`
      const options = await db.ephemeralCluster();
      await db.openDatabase({ embedded: options });
      console.log(options.dataDir);
    `);
    cluster.own(() => killHard(held.child));
    dataDir = held.line;
    const postgres = identified(readPostmaster(dataDir));
    seen.postgres = postgres;
    const postmaster = postgres.pid;
    await killHard(held.child);
    expect(isAlive(postmaster)).toBe(true);

    const next = await ephemeralCluster();
    onTestFinished(() => removeCluster(next.dataDir));
    expect(isAlive(postmaster)).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(`${dataDir}.owner`)).toBe(false);
  }, 60_000);

  // 같은 dataDir에 여러 프로세스가 동시에 시작하면 하나만 쓴다. 죽은 주인의 기록을 여럿이 동시에 넘겨받으려 해도 마찬가지다.
  // 진 쪽은 시작 실패를 정리하며 이긴 쪽의 Postgres를 멈추면 안 된다.
  it("lets only one of several processes starting at once use a data folder, even when they all take it over from a dead owner", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "babojubot-pg-"));
    // 새 폴더에서 셋이 동시에 cluster를 만들고 켜게 한다. 주인이 하나가 아니면 만들기·켜기를 함께 시도해 부딪힌다.
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await watchExit(gone).within(10_000);
    await recordOwner(dataDir, { pid: gone.pid!, persistent: true });
    const clientModule = fileURLToPath(new URL("./client.ts", import.meta.url));
    const script = `
      const db = await import(${JSON.stringify(clientModule)});
      const handle = await db
        .openDatabase({ embedded: { dataDir: ${JSON.stringify(dataDir)}, persistent: true } })
        .catch((error) => {
          process.stdout.write("failed: " + error.message + "\\n", () => process.exit(0));
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
    const exits = children.map(watchExit);
    const readers = children.map((child) => lineReader(child, 45_000));
    for (const child of children) child.stdin!.on("error", () => {});
    const seen: { postgres?: Postgres } = {};
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    cluster.own(async () =>
      stopPostgres(await postgresIn(dataDir, seen.postgres))
    );
    cluster.own(() =>
      attemptAll(children.map((child) => () => killHard(child)))
    );
    const lines = await Promise.all(readers.map((reader) => reader.next()));
    expect(lines.filter((line) => line === "opened")).toHaveLength(1);
    const winnerIndex = lines.indexOf("opened");
    for (const [index, line] of lines.entries()) {
      if (index === winnerIndex) continue;
      expect(line).toContain("in use by a running process");
      await exits[index]!.within(30_000);
    }

    const postgres = identified(readPostmaster(dataDir));
    seen.postgres = postgres;
    const winner = children[winnerIndex]!;
    winner.stdin!.write("query\n");
    expect(await readers[winnerIndex]!.next()).toBe("query 1");
    await exits[winnerIndex]!.within(30_000);
    expect(winner.exitCode).toBe(0);
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
    const seen: { postgres?: Postgres } = {};
    const cluster = folderCleanup(() => removeCluster(dataDir));
    onTestFinished(cluster.cleanUp);
    cluster.own(async () =>
      stopPostgres(await postgresIn(dataDir, seen.postgres))
    );
    cluster.own(() => killHard(unrelated));
    cluster.own(() => killHard(child));
    const lines = lineReader(child);
    await lines.next();
    const postgres = identified(readPostmaster(dataDir));
    seen.postgres = postgres;
    const postmaster = postgres.pid;
    process.kill(postmaster, "SIGKILL");
    await expect
      .poll(() => isAlive(postmaster), { timeout: 10_000, interval: 50 })
      .toBe(false);
    fs.writeFileSync(
      path.join(dataDir, "postmaster.pid"),
      `${unrelated.pid}\n${dataDir}\n0\n0\n`
    );
    const exited = watchExit(child);
    child.stdin!.write("end\n");
    await exited.within(30_000);
    // 즉시 정지는 프로세스가 끝나기 전에(exit에서 동기로) 보낸다. 끝난 뒤 시험이 보낸 SIGTERM으로 끝났으면 그 전에 받은 신호가 없다.
    const unrelatedExit = watchExit(unrelated);
    unrelated.kill("SIGTERM");
    expect(await unrelatedExit.within(10_000)).toEqual({
      code: null,
      signal: "SIGTERM",
    });
  }, 60_000);

  // 같은 pid가 다른 프로세스에 다시 쓰이면 pid만으로는 켠 Postgres와 구별할 수 없다. 프로세스 종료 때의 즉시 정지는
  // OS가 매긴 생성 신원까지 같을 때만 보낸다. pid 재사용 자체는 만들 수 없으므로 그 판단의 재료를 확인한다:
  // 같은 프로세스는 같은 신원, 나중에 시작한 프로세스는 다른 신원, 끝난 프로세스는 신원이 없다.
  it("identifies a process by when the OS started it, so a reused pid does not look like its Postgres", async () => {
    const first = spawn("sleep", ["60"], { stdio: "ignore" });
    onTestFinished(() => killHard(first));
    const identity = processIdentity(first.pid!);
    expect(identity).toBeTruthy();
    expect(processIdentity(first.pid!)).toBe(identity);
    // ps의 시작 시각은 초 단위이므로 벽시계가 다음 초로 넘어간 뒤에 시작한다.
    const startedIn = Math.floor(Date.now() / 1000);
    await vi.waitUntil(() => Math.floor(Date.now() / 1000) > startedIn, {
      timeout: 2_000,
      interval: 20,
    });
    const second = spawn("sleep", ["60"], { stdio: "ignore" });
    onTestFinished(() => killHard(second));
    expect(processIdentity(second.pid!)).toBeTruthy();
    expect(processIdentity(second.pid!)).not.toBe(identity);
    await killHard(first);
    expect(processIdentity(first.pid!)).toBeUndefined();
  });

  // 임시 cluster는 dataDir와 주인 기록을 함께 가진다. 켜기 전에 실패하면(initdb 실패 등) 둘 다 남지 않아야 한다.
  it("removes a temporary cluster with its owner record when it cannot be created", async () => {
    const options = await ephemeralCluster();
    // 비어 있지 않은 폴더에는 initdb가 cluster를 만들지 않는다.
    onTestFinished(() => removeCluster(options.dataDir));
    fs.writeFileSync(path.join(options.dataDir, "unrelated"), "");
    await expect(startEmbeddedCluster(options)).rejects.toThrow(
      "could not create embedded Postgres"
    );
    expect(fs.existsSync(options.dataDir)).toBe(false);
    expect(fs.existsSync(`${options.dataDir}.owner`)).toBe(false);
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
    onTestFinished(() => removeCluster(dataDir));
    const next = await ephemeralCluster();
    onTestFinished(() => removeCluster(next.dataDir));
    expect(fs.existsSync(`${dataDir}.owner`)).toBe(false);
  });

  // tmp는 다른 프로그램도 쓴다. 임시 주인 기록 이름을 한 링크가 tmp 밖 폴더를 가리켜도 그 폴더를 건드리면 안 된다.
  it("does not follow a link named like a temporary owner record", async () => {
    const outside = await fsp.mkdtemp(
      path.join(os.tmpdir(), "babojubot-outside-")
    );
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await watchExit(gone).within(10_000);
    fs.writeFileSync(
      path.join(outside, "1"),
      JSON.stringify({ pid: gone.pid, persistent: false })
    );
    const link = path.join(
      os.tmpdir(),
      `babojubot-pg-link-${process.pid}-${Date.now()}.owner`
    );
    fs.symlinkSync(outside, link, "dir");
    onTestFinished(() =>
      attemptAll([
        () => fs.rmSync(link, { force: true }),
        () => removeFolder(outside),
      ])
    );
    const next = await ephemeralCluster();
    onTestFinished(() => removeCluster(next.dataDir));
    expect(fs.readdirSync(outside)).toEqual(["1"]);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

const isAlive = processAlive;

/** 테스트가 만든 cluster 폴더와 그 옆의 주인 기록을 지운다. */
async function removeCluster(dataDir: string) {
  await attemptAll([
    () => removeFolder(dataDir),
    () => removeFolder(`${dataDir}.owner`),
  ]);
}

/** 주인 기록을 그 프로세스가 지금 주인인 것으로 바꿔 둔다. */
async function recordOwner(
  dataDir: string,
  owner: { pid: number; persistent: boolean; handle?: string }
) {
  const dir = `${dataDir}.owner`;
  await removeFolder(dir);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "1"), JSON.stringify(owner));
}

function readPostmaster(dataDir: string) {
  return Number(
    fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0]
  );
}

/**
 * 시험이 끌 Postgres 프로세스: 번호와 그 번호를 받은 때(살아 있을 때) 본 OS 생성 신원(`processIdentity`, 제품의 즉시 정지가 번호
 * 재사용을 가리는 데 쓰는 신원). 정리는 신호 직전에 같은 신원인지 다시 보고, 같을 때만 그 번호로 신호한다. 번호만 보관해 두면 그
 * 프로세스가 끝난 뒤 같은 번호를 받은 다른 프로그램에 신호한다(#288 parent 점검, #287 리뷰 2회차 STD-4와 같은 모양).
 */
type Postgres = { pid: number; identity: string };

/** 지금 살아 있는 그 번호의 프로세스를 신원과 함께 잡는다. 신원을 읽지 못하면 던진다. */
function identified(pid: number): Postgres {
  const identity = processIdentity(pid);
  if (identity === undefined)
    throw new Error(`process ${pid} could not be identified while it ran`);
  return { pid, identity };
}

/**
 * 그 Postgres가 지금도 같은 프로세스로 도는가. 신원이 같으면 돈다. 번호의 프로세스가 없거나(ESRCH) 신원이 다르면(번호를 다른
 * 프로그램이 받음) 끝났다. 살아 있는데 신원을 읽지 못하면 모르는 것이라 던진다(끝남으로 접지 않는다).
 */
function stateOf(target: Postgres): "running" | "ended" {
  const identity = processIdentity(target.pid);
  if (identity === target.identity) return "running";
  if (identity !== undefined || !isAlive(target.pid)) return "ended";
  throw new Error(
    `whether Postgres ${target.pid} still runs could not be told`
  );
}

/**
 * 시험이 번호를 받지 못한 채 남은 그 폴더의 Postgres(#288 리뷰 2회차 STD-2와 같은 모양: 자식이 Postgres를 띄운 뒤 준비 줄 전에 실패).
 * 잠금 파일이 없으면(ENOENT) 켜진 Postgres가 없다. 있으면 그 포트의 서버에 연결해, 이 폴더를 쓰는지와 연결을 받은 backend의 부모를
 * 묻는다. 연결이 열려 있는 동안 그 부모(postmaster)는 살아 있으므로 그때 번호와 신원을 잡는다. 연결하지 못하거나 이 폴더의 서버가
 * 아니면 신호하지 않고 그 이유로 던진다(잠금 파일의 번호만 믿지 않는다: 서버가 죽은 뒤 그 번호를 다른 프로그램이 받았을 수 있다).
 */
async function runningPostgresIn(
  dataDir: string
): Promise<Postgres | undefined> {
  const lock = orIfMissing(
    () => fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8"),
    hasErrorCode("ENOENT"),
    undefined
  );
  if (lock === undefined) return undefined;
  const [, , , port] = lock.split("\n");
  try {
    return await withClient(
      clusterUrl(Number(port), "postgres"),
      async (client) => {
        const { rows } = await client.query<{ dir: string; pid: number }>(
          "select current_setting('data_directory') as dir, pg_backend_pid() as pid"
        );
        const { dir, pid } = rows[0]!;
        if (fs.realpathSync(dir) !== fs.realpathSync(dataDir))
          throw new Error(`the server on port ${port} serves ${dir}`);
        const parent = Number(psField(pid, "ppid", 5_000));
        if (!(parent > 1))
          throw new Error(`the parent of backend ${pid} could not be read`);
        return identified(parent);
      }
    );
  } catch (error) {
    throw new Error(
      `a Postgres may still run in ${dataDir}, but it could not be confirmed, so it was not signalled`,
      { cause: error }
    );
  }
}

/** 이미 잡았으면 그것, 아니면 그 폴더에 남은 것(`runningPostgresIn`). */
async function postgresIn(dataDir: string, known: Postgres | undefined) {
  return known ?? (await runningPostgresIn(dataDir));
}

// 남은 Postgres를 끄는 정리는 한 대상의 신호가 실패해도 다른 대상에 신호를 보내고 끝나기를 기다린 뒤, 그 실패를 함께 알린다
// (#248 리뷰 SPEC-1). 대상은 신원과 함께 잡은 것이고, 신호 직전의 신원 확인은 `/proc`·ps로 하므로 신호 거부와 따로 돈다.
it("signals every leftover Postgres even when one of them refuses its signal", async () => {
  const sleeper = () =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
  const refused = sleeper();
  const other = sleeper();
  onTestFinished(() =>
    attemptAll([() => killHard(refused), () => killHard(other)])
  );
  const otherExit = watchExit(other);
  const targets = [identified(refused.pid!), identified(other.pid!)];
  // `refused`에 대한 신호는 권한 거부로 실패한다. 다른 대상의 신호는 그대로 보낸다.
  const kill = process.kill.bind(process);
  const sent: [number, string | number | undefined][] = [];
  const failure = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    sent.push([pid, signal]);
    if (pid === refused.pid) throw failure;
    return kill(pid, signal);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  const outcome = await killPostgres(...targets).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(sent).toContainEqual([other.pid, "SIGKILL"]);
  expect(await otherExit.within(10_000)).toEqual({
    code: null,
    signal: "SIGKILL",
  });
  // 보내지 못한 첫 신호와, 그 대상이 시한 안에 끝나지 않은 것을 함께 알린다.
  const first = process.platform === "win32" ? "SIGKILL" : "SIGCONT";
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(
    (outcome as AggregateError).errors.map((error: Error) => [
      error.message,
      error.cause,
    ])
  ).toEqual([
    [`프로세스 ${refused.pid}에 ${first}을 보내지 못했다`, failure],
    [
      `Postgres ${refused.pid} did not end after SIGKILL; its folder is kept`,
      undefined,
    ],
  ]);
});

/** 남은 postgres를 즉시 정지로 멈추고 끝날 때까지 기다린다. 신호는 같은 신원으로 도는 것을 본 직후에만 보낸다. */
async function stopPostgres(target: Postgres | undefined) {
  if (target === undefined || stateOf(target) === "ended") return;
  // 이미 끝났으면(ESRCH) 할 일이 없다. 그 밖의 실패는 pid와 함께 알린다.
  if (!killUnlessGone(target.pid, "SIGQUIT")) return;
  // 시한 안에 끝나지 않으면 아래 강제 정지로 넘어간다. 끝은 신원으로 본다.
  await vi
    .waitUntil(() => stateOf(target) === "ended", {
      timeout: 10_000,
      interval: 50,
    })
    .catch(() => {});
  await killPostgres(target);
}

/**
 * 남은 Postgres를 강제로 끝내고 사라진 것을 확인한다. 모두에게 신호를 먼저 보낸 뒤 하나씩 기다린다. 시한 안에 끝나지 않으면 실패하므로,
 * 뒤따르는 폴더 삭제는 일어나지 않고 폴더가 남는다(쓰는 중인 폴더를 지워 원인을 가리지 않는다).
 * 대상마다 따로 시도한다. 한 대상의 신호나 조회가 실패해도 다른 대상에 보내고 기다린 뒤 그 실패를 함께 알린다. 신호는 같은 신원으로
 * 도는 것을 본 직후에만 보내고, 끝은 신원으로 본다(`stateOf`).
 */
async function killPostgres(...targets: Postgres[]) {
  await attemptAll([
    ...targets.map((target) => () => {
      if (stateOf(target) === "ended") return;
      // 멈춰 둔(SIGSTOP) 프로세스도 끝나게 한다. 이미 끝났으면(ESRCH) 넘어간다.
      if (
        process.platform !== "win32" &&
        !killUnlessGone(target.pid, "SIGCONT")
      )
        return;
      killUnlessGone(target.pid);
    }),
    ...targets.map((target) => async () => {
      // 시한이 지났으면 남은 것으로, 조회가 실패했으면 다시 물어 그 원인으로 알린다.
      await vi
        .waitUntil(() => stateOf(target) === "ended", {
          timeout: 10_000,
          interval: 50,
        })
        .catch(() => {
          if (stateOf(target) === "running")
            throw new Error(
              `Postgres ${target.pid} did not end after SIGKILL; its folder is kept`
            );
        });
    }),
  ]);
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

type Exit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * spawn 직후에 붙여 한 번만 오는 exit/error를 놓치지 않는다. 시한은 `within`으로 기다리기 시작할 때부터 센다.
 * spawn부터 세면 오래 살아 있어야 하는 자식이 끝내라는 요청을 받기도 전에 시한이 지난다.
 */
function watchExit(child: Spawned) {
  const exited = awaitedLater(
    new Promise<Exit>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    })
  );
  return {
    async within(timeoutMs: number): Promise<Exit> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `child ${child.pid} did not exit in ${timeoutMs}ms (exit code ${child.exitCode}, signal ${child.signalCode})`
                  )
                ),
              timeoutMs
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
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
    throw combinedFailure(
      [error, ...(await attemptEach([() => killHard(child)]))],
      "the child did not open the database and stopping it failed",
      { cause: error }
    );
  }
}

/** 정리 없이 강제로 끝낸다(SIGKILL·IDE 강제 정지·OOM과 같은 상황). */
async function killHard(child: Spawned) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // spawn 자체가 실패하면 pid가 없고 exit도 오지 않는다.
  if (child.pid === undefined) return;
  const exited = watchExit(child);
  child.kill("SIGKILL");
  await exited.within(10_000);
}

// 종료 관찰은 spawn 직후에 붙이고, 끝나기를 기다리는 시한은 기다리기 시작할 때부터 센다.
// spawn부터 세면 오래 살아 있어야 하는 자식(경쟁에서 이긴 쪽)이 끝내라는 요청을 받기도 전에 시한이 지난다.
it("counts an exit deadline from when the wait starts, not from the spawn", async () => {
  // 시한 타이머를 가짜로 바꿔 시간을 시험이 옮긴다. 시한을 spawn(관찰 시작)부터 셌다면 아래에서 3초를 옮길 때 이미 지난다.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
  // 가짜 타이머를 먼저 되돌린다. 끝나기를 기다리는 시한은 실제 타이머로 잰다.
  onTestFinished(async () => {
    vi.useRealTimers();
    await killHard(child);
  });
  await lineReader(child, 30_000).next();
  // 기다리는 시한(2.5초)보다 오래 산 뒤에 끝내라고 한다.
  vi.advanceTimersByTime(3_000);
  child.stdin!.write("end\n");
  await expect(exit.within(2_500)).resolves.toEqual({
    code: 0,
    signal: null,
  });
}, 30_000);

// 끝나지 않는 자식을 기다리면 시한에서 그 자식을 밝혀 실패한다. 정리 단계의 기다림이 시험을 멈추지 않게 한다.
it("fails an exit wait at its deadline and names the child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exit = watchExit(child);
  onTestFinished(() => killHard(child));
  await expect(exit.within(200)).rejects.toThrow(
    new RegExp(`child ${child.pid} did not exit in 200ms`)
  );
}, 30_000);

// 쓰는 중인 연결이 끊기면(Postgres 재시작·종료) 그 일만 실패하고 프로세스는 살아 있어야 한다.
// 서버 종료 때 Postgres가 먼저 멈추면 처리되지 않은 오류로 죽어 임시 DB 폴더를 지우지 못했다.
it("fails only the work on a connection cut while in use, without crashing the process", async () => {
  const database = await createTestDatabase();
  onTestFinished(() => database.close());
  const work = database.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ pid: number }>(
      sql`select pg_backend_pid() as pid`
    );
    await withClient(database.url, (client) =>
      client.query("select pg_terminate_backend($1)", [rows[0]!.pid])
    );
    // 끊은 backend가 끝날 때까지 기다린 뒤 같은 연결로 쓴다.
    await expect
      .poll(
        () =>
          withClient(database.url, async (client) => {
            const { rowCount } = await client.query(
              "select 1 from pg_stat_activity where pid = $1",
              [rows[0]!.pid]
            );
            return rowCount;
          }),
        { timeout: 15_000, interval: 20 }
      )
      .toBe(0);
    await tx.execute(sql`select 1`);
  });
  await expect(work).rejects.toThrow();
});
