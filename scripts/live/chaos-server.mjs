// 실모델 장애 검사의 서버. 서버를 별도 자식 프로세스로 띄우고, SIGKILL로 끝내고, 같은 임시 홈·DB로 다시 띄운다.
// 이 파일을 설정 파일 경로와 함께 직접 실행하면 그 자식 프로세스가 된다(`node chaos-server.mjs <설정 파일>`).
// 자식은 제품 서버(startServer)를 루프백·자동 배정 포트로 띄우고, 실행 관문(chaos-budget.mjs gateConnection)으로 연결을 감싼다.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateConnection, writeSecretFile } from "./chaos-budget.mjs";
import { sharedVariables } from "../../packages/runtime/src/providers/process.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/** 서버 자식에 넘기는 환경. 네트워크·인증서·언어·임시 폴더와 PATH만 넘기고, 제품 설정·자격 증명은 넘기지 않는다. */
export function chaosEnvironment(env, home) {
  const picked = Object.fromEntries(
    ["PATH", ...sharedVariables].flatMap((name) =>
      env[name] === undefined ? [] : [[name, env[name]]]
    )
  );
  return { ...picked, HOME: home, BABOJUBOT_HOME: home };
}

/** 이 프로세스의 환경에서 허용 목록 밖의 값을 지운다(실제 호출 전 확인용). HOME은 둔다. 같은 객체를 돌려준다. */
export function scrubEnvironment(env) {
  const allowed = new Set(["PATH", "HOME", ...sharedVariables]);
  for (const name of Object.keys(env)) if (!allowed.has(name)) delete env[name];
  return env;
}

/**
 * 장면 하나의 서버 자원. `home`(임시 제품 홈)과 `harnessDir`(토큰·설정, 0700)는 부르는 쪽이 만든다.
 * 실행 기록·예산 파일은 장면을 건너 전체 한도를 세도록 부르는 쪽이 정한다(기본은 `harnessDir` 안).
 * - `connection`: `opencode`(실제) 또는 `fake-live`(자동 검사용 가짜. 실제처럼 예산·토큰 관문을 지난다)
 * - `database`: `ephemeral`(임시 DB) 또는 `persistent`(홈 아래 일회용 영속 내장 DB, 재시작 장면)
 */
export function chaosServer({
  home,
  harnessDir,
  connection,
  database,
  brief = null,
  ledgerFile = path.join(harnessDir, "ledger.jsonl"),
  budgetFile = path.join(harnessDir, "budget.json"),
}) {
  const files = {
    config: path.join(harnessDir, "server.json"),
    info: path.join(harnessDir, "server-info.json"),
    ledger: ledgerFile,
    budget: budgetFile,
    control: path.join(harnessDir, "control.json"),
    tokens: path.join(harnessDir, "tokens"),
  };
  let child;
  let exited;
  let info;
  let forced = false;
  let starts = 0;

  async function start(signal) {
    if (signal?.aborted) throw signal.reason;
    await mkdir(files.tokens, { recursive: true, mode: 0o700 });
    writeSecretFile(
      files.config,
      JSON.stringify({ home, connection, database, brief, files }),
      { replace: true }
    );
    rmSync(files.info, { force: true });
    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), files.config],
      {
        cwd: repoRoot,
        env: chaosEnvironment(process.env, home),
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    starts++;
    // 서버 출력은 증거에 남기지 않는다. 시작 실패를 알릴 때만 끝부분을 보인다.
    let tail = "";
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-3000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const current = child;
    exited = new Promise((resolve) =>
      current.once("exit", (code, signal) => resolve({ code, signal }))
    );
    let gone = false;
    void exited.then(() => {
      gone = true;
    });
    const deadline = Date.now() + 180_000;
    while (!existsSync(files.info)) {
      if (signal?.aborted) {
        await kill();
        throw signal.reason;
      }
      if (gone)
        throw startFailure("chaos server exited before it was ready", tail);
      if (Date.now() > deadline) {
        await kill();
        throw startFailure("chaos server was not ready in time", tail);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    info = JSON.parse(readFileSync(files.info, "utf8"));
    return info;
  }

  /** 서버 프로세스만 SIGKILL로 끝낸다. 내장 DB와 프로바이더 프로세스는 남는다(다음 시작이 정리). */
  async function kill() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    forced = true;
    child.kill("SIGKILL");
    await exited;
  }

  /** 정상 종료(SIGTERM). 진행 중인 실행은 제품이 취소·정리한다. 시한 안에 끝나지 않으면 SIGKILL한다. */
  async function stop(withinMs = 30_000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = new Promise((r) => setTimeout(() => r("timeout"), withinMs));
    if ((await Promise.race([exited, timer])) === "timeout") await kill();
  }

  /**
   * 마지막 정리. 서버를 멈추고, 강제로 끝낸 적이 있으면 남은 내장 DB와 프로바이더 프로세스를 제품 경로로 정리한 뒤 홈을 지운다.
   * 다른 작업의 프로세스는 건드리지 않는다(이 홈의 기록과 이 홈의 DB만 본다).
   */
  async function dispose() {
    await stop();
    const leftovers = {
      postgres: false,
      providerRecordsFound: 0,
      providerRecordsLeft: 0,
      homeKept: false,
    };
    const { openDatabase, openEphemeralDatabase } =
      await import("../../packages/db/src/index.ts");
    const { recoverProviderProcesses } =
      await import("../../packages/runtime/src/index.ts");
    const pgDir = path.join(home, "postgres");
    if (
      database === "persistent" &&
      existsSync(path.join(pgDir, "postmaster.pid"))
    ) {
      leftovers.postgres = true;
      // 남은 DB는 제품 경로로 열면 정상 정지하고 다시 띄운다. 닫으면 정상 정지한다.
      const handle = await openDatabase({
        embedded: { dataDir: pgDir, persistent: true },
      });
      await handle.close();
    }
    if (database === "ephemeral" && forced) {
      // 강제로 끝난 프로세스의 임시 DB는 다음 임시 DB를 열 때 제품이 정리한다.
      const handle = await openEphemeralDatabase();
      await handle.close();
    }
    leftovers.providerRecordsFound = processRecordPids(home).length;
    await recoverProviderProcesses(home);
    leftovers.providerRecordsLeft = processRecordPids(home).length;
    if (leftovers.providerRecordsLeft > 0) {
      // 우리 것인지 확인하지 못한 기록은 지우지 않는다. 사람이 정리할 수 있게 홈을 남긴다.
      leftovers.homeKept = true;
      console.error(
        `[chaos] ${leftovers.providerRecordsLeft} provider process record(s) could not be recovered; kept ${home} for manual cleanup`
      );
    } else {
      await rm(home, { recursive: true, force: true });
    }
    return leftovers;
  }

  return {
    files,
    start,
    kill,
    stop,
    dispose,
    /** 같은 홈·DB로 다시 띄운다. */
    restart: async () => {
      await stop();
      return start();
    },
    get info() {
      return info;
    },
    get pid() {
      return child?.pid;
    },
    get starts() {
      return starts;
    },
    get running() {
      return !!child && child.exitCode === null && child.signalCode === null;
    },
  };
}

/** 서버 출력은 증거에 넣지 않는다. 사람이 원인을 보도록 터미널에만 보이고, 오류에는 짧은 문구만 담는다. */
function startFailure(message, tail) {
  if (tail)
    console.error(`[chaos-server] ${message}; last server output:\n${tail}`);
  return new Error(message);
}

/** 이 홈에 남은 프로바이더 프로세스 기록의 PID(기록 파일 이름). 서버가 정리를 마치면 그 기록은 없어진다. */
export function processRecordPids(home) {
  const root = path.join(home, "providers");
  return readdir(root).flatMap((provider) =>
    readdir(path.join(root, provider, "processes"))
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => Number.parseInt(n, 10))
  );
}

function readdir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------- 자식 프로세스 ----------

/**
 * 자동 검사용 가짜 실제 연결. 모델을 부르지 않는다. 받은 메시지에 `busy.mjs <초>`가 있으면 그 시간 동안(취소되면 그때까지) 일하며
 * 그동안 끼워 넣기를 받는다. 받은 세션이 있으면 같은 세션을 이어 간다.
 */
function fakeLiveAdapter(defaultFakeCapabilities) {
  const steerable = new Set();
  return {
    capabilities: { ...defaultFakeCapabilities, steer: true },
    loginCommand: null,
    checkReadiness: async () => ({ status: "ready", reason: null }),
    async steer(message) {
      return steerable.has(message.runId) ? "accepted" : "rejected";
    },
    async execute(request, { signal }) {
      const seconds = Math.max(
        0,
        ...request.wakeReasons
          .filter((reason) => reason.kind === "owner_message")
          .map((reason) =>
            Number(/busy\.mjs (\d+)/.exec(reason.body)?.[1] ?? 0)
          )
      );
      const result = (stopReason) => ({
        stopReason,
        error: null,
        summary: null,
        usage: null,
        nextSession: {
          id:
            typeof request.previousSession?.id === "string"
              ? request.previousSession.id
              : `fake-live-${randomUUID()}`,
        },
      });
      steerable.add(request.identity.runId);
      try {
        const cancelled = await new Promise((resolve) => {
          if (signal.aborted) return resolve(true);
          const timer = setTimeout(() => resolve(false), seconds * 1000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true }
          );
        });
        return result(cancelled ? "cancelled" : "completed");
      } finally {
        steerable.delete(request.identity.runId);
      }
    },
  };
}

async function runChild(configFile) {
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const { home, files } = config;
  const runtime = await import("../../packages/runtime/src/index.ts");
  const db = await import("../../packages/db/src/index.ts");
  const { startServer } = await import("../../apps/server/src/index.ts");
  const handle =
    config.database === "persistent"
      ? await db.openDatabase({
          embedded: { dataDir: path.join(home, "postgres"), persistent: true },
        })
      : await db.openEphemeralDatabase();
  const gate = {
    ledgerFile: files.ledger,
    budgetFile: files.budget,
    tokenDir: files.tokens,
    controlFile: files.control,
    brief: config.brief,
  };
  const live =
    config.connection === "opencode"
      ? runtime.createOpenCodeProvider({ dataDir: home })
      : runtime.createFakeProvider({
          id: "fake-live",
          label: "가짜 실제 연결",
          adapter: fakeLiveAdapter(runtime.defaultFakeCapabilities),
        });
  // 가짜 연결(`fake`)은 조직을 만들 때와 프로바이더 변경 검사에 쓴다. 예산을 쓰지 않지만 실행 기록에는 남긴다.
  const providers = [
    ...runtime
      .createFakeProviders(1)
      .map((c) => gateConnection(c, { ...gate, live: false, brief: null })),
    gateConnection(live, { ...gate, live: true }),
  ];
  let server;
  try {
    server = await startServer({
      db: handle.db,
      dataDir: home,
      port: 0,
      host: "127.0.0.1",
      providers,
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
  let stopping;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      stopping ??= (async () => {
        let failed = false;
        await server.close().catch(() => (failed = true));
        await handle.close().catch(() => (failed = true));
        process.exit(failed ? 1 : 0);
      })();
    });
  writeSecretFile(
    files.info,
    JSON.stringify({
      url: server.url,
      dbUrl: handle.url,
      pid: process.pid,
      liveProviderId: live.id,
    }),
    { replace: true }
  );
  console.log(`chaos server ready (pid ${process.pid})`);
}

if (import.meta.main) {
  const configFile = process.argv[2];
  if (!configFile) {
    console.error("Usage: node scripts/live/chaos-server.mjs <config file>");
    process.exit(2);
  }
  await runChild(configFile).catch((error) => {
    console.error("[chaos-server] start failed", error?.message ?? error);
    process.exit(1);
  });
}
