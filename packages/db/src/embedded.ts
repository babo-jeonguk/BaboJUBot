import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres, { getBinaries } from "embedded-postgres";
import pg from "pg";
import {
  attemptAll,
  attemptEach,
  combinedFailure,
  continueAfterFailure,
  failureCode,
  settled,
  hasErrorCode,
  orIfMissing,
  orIfProbeFailed,
  orIfUnreadable,
} from "@babojubot/contracts";
import { psField, runCommand } from "@babojubot/process";
import { candidatePort } from "./ports.ts";

/** 이 프로세스가 띄우고 멈추는 embedded Postgres. `persistent: false`면 디스크 확정 기록 없이 띄우고 정지 때 dataDir를 지운다. */
export type EmbeddedOptions = {
  dataDir: string;
  /** 듣는 port. 없으면 켤 때 빈 port를 골라 Postgres가 실제로 잡은 번호를 쓴다. */
  port?: number;
  persistent: boolean;
  /** 프로세스 종료 때 즉시 정지에 쓸 수 있는 시간(ms). 기본 `emergencyStopMs`. 0이면 보내지 않고 다음 시작에 맡긴다. */
  emergencyStopMs?: number;
};

/** embedded cluster의 DB 하나에 연결할 주소. */
export const clusterUrl = (port: number, database: string) =>
  `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;

/** 내장 Postgres의 실패 원인(#286). 진단은 문구 대신 이 code로 남긴다(`failureCode`). 문구는 사용자가 읽고 고치도록 그대로 둔다. */
export type EmbeddedFailureCode =
  | "EMBEDDED_SETTING_UNSUPPORTED"
  | "EMBEDDED_EXITED_BEFORE_READY"
  | "EMBEDDED_CREATE_FAILED"
  | "EMBEDDED_POSTGRES_UNKNOWN"
  | "EMBEDDED_POSTGRES_UNCONFIRMED"
  | "EMBEDDED_STOP_TIMEOUT"
  | "EMBEDDED_STATUS_UNKNOWN"
  | "EMBEDDED_PG_CTL_TIMEOUT"
  | "EMBEDDED_SOCKET_PATH_TOO_LONG"
  | "EMBEDDED_FOLDER_NOT_PRIVATE"
  | "EMBEDDED_NO_OWNER_FOLDER"
  | "EMBEDDED_OWNER_NO_ANSWER"
  | "EMBEDDED_OWNER_UNCHECKED"
  | "EMBEDDED_IN_USE"
  | "EMBEDDED_OWNER_CLOSE_FAILED"
  | "EMBEDDED_OWNERSHIP_CONTESTED";
export class EmbeddedPostgresFailure extends Error {
  override readonly name = "EmbeddedPostgresFailure";
  readonly code: EmbeddedFailureCode;
  constructor(
    code: EmbeddedFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
  }
}

// Postgres는 모든 OS에서 묶여 온 pg_ctl로 켜고 끈다(docs/research/embedded-postgres-lifecycle-references.md).
// - 켜기: pg_ctl은 POSIX에서 Postgres를 새 session으로 띄우고, Windows에서는 관리자 권한을 내려놓고 숨은 콘솔에서 띄운다.
//   그래서 터미널의 Ctrl+C·창 닫기가 Postgres에 바로 가지 않고, Windows 관리자 계정에서도 켜진다. Windows에서 pg_ctl에 출력
//   통로를 주면 Postgres가 그 통로를 물려받아 닫히지 않으므로 출력은 버리고 끝남 코드만 본다. 실패 이유는 Postgres 로그에서 읽는다.
// - 끄기: 정상 정지(fast)를 요청하고 끝날 때까지 기다린다. Windows도 Postgres 자체 신호로 정상 정지한다.
// - 임시 cluster: 멈출 때 지우므로 디스크 확정 기록(fsync)·commit 확정 대기·전체 page 기록을 끄고 띄운다(PostgreSQL 문서 「Non-Durable Settings」).
//   켜 두면 정지 때 밀린 기록을 확정하느라 디스크가 느린 곳(Windows CI의 OS 디스크)에서 몇 초씩 걸려 서버 정리 시한을 넘긴다.
// - 주인: dataDir 하나는 한 프로세스만 쓴다(`acquireOwner`). 만들기·남은 Postgres 정리·켜기·끄기·지우기는 주인만 한다. 주인이 살아
//   있는지는 기록한 번호가 아니라 주인이 듣는 연결로 본다(`ownerAlive`, #268).
// - 다음 시작: 강제로 끝난 프로세스가 남긴 Postgres는 기록된 주인이 죽었고 그 서버가 이 dataDir를 쓰는 것이 접속으로 확인될
//   때만 멈춘다. 잠금 파일(postmaster.pid)만으로는 무관한 프로세스와 구별할 수 없다.
// - port: 정한 port가 없으면 빈 port 후보로 켜고, 그 후보를 잡지 못했으면(그 사이 남이 잡았거나 그 port만 막힘) 다른 후보로 다시 켠다. 번호만 미리 받아 두면 다른 프로세스가 먼저 잡을 수 있다.
/** 임시 cluster의 Postgres 설정. 멈출 때 지우는 데이터라 디스크 확정 기록을 기다리지 않는다(위 「임시 cluster」). */
const temporarySettings = [
  "fsync=off",
  "synchronous_commit=off",
  "full_page_writes=off",
];
const startSeconds = 60;
// 정상 종료 때의 정지 시한. 서버 정리 시한(main.ts)이 먼저 지나면 프로세스 종료 때 즉시 정지가 따른다.
const stopSeconds = 30;
// 다음 시작 때 남은 Postgres를 멈추는 시한.
const leftoverStopSeconds = 10;
/** 프로세스 종료 때 즉시 정지에 쓰는 기본 최대 시간. 서버는 정리 시한에서 이 몫을 남긴다(apps/server/src/shutdown-budget.ts). */
export const emergencyStopMs = 1_500;
const temporaryPrefix = "babojubot-pg-";
const ownerSuffix = ".owner";
const logName = "postgres.log";

/**
 * 이 dataDir를 쓰는 프로세스. `handle`은 주인이 살아 있는 동안 듣는 연결의 자리(Unix 소켓 파일, Windows named pipe)다. 주인이 죽으면
 * OS가 그 연결을 닫는다. `pid`는 안내 문구에만 쓴다. `handle`이 없는 기록은 이 판 전에 쓴 예전 형식이다.
 */
type Owner = { pid: number; persistent: boolean; handle?: string };
/** 이 프로세스가 얻은 주인 세대와, 바로 전 세대의 죽은 주인. */
type Lease = { generation: number; previous: Owner | undefined };
/** 이 프로세스가 켠 postgres. `identity`는 OS가 매긴 프로세스 생성 신원이다(`processIdentity`). */
type Started = { pid: number; identity: string | undefined };

/**
 * 켠 embedded cluster. `port`는 Postgres가 실제로 듣는 port다. `stop`이 돌아오면 postgres는 끝났다.
 * `stopping`은 `stop`이 지금 하는 일이다(정리 시한이 지났을 때의 안내).
 */
export type EmbeddedCluster = {
  port: number;
  stop: () => Promise<void>;
  stopping: () => string;
};

/**
 * embedded cluster를 띄우고, Postgres가 실제로 듣는 port와 멈추는 함수를 돌려준다(`EmbeddedCluster`).
 * `settings`는 postgres 설정(`이름=값`)이다.
 */
export async function startEmbeddedCluster(
  {
    dataDir,
    port,
    persistent,
    emergencyStopMs: emergencyBudgetMs = emergencyStopMs,
  }: EmbeddedOptions,
  settings: string[] = []
): Promise<EmbeddedCluster> {
  // 설정은 pg_ctl을 거쳐 shell 명령줄에 들어가므로 따옴표가 필요 없는 값만 받는다.
  for (const setting of settings)
    if (!/^[A-Za-z_][A-Za-z0-9_.]*=[A-Za-z0-9_.:/-]+$/.test(setting))
      throw new EmbeddedPostgresFailure(
        "EMBEDDED_SETTING_UNSUPPORTED",
        `unsupported Postgres setting "${setting}"`
      );
  const { pg_ctl: pgCtl } = await getBinaries();
  const lease = await acquireOwner(dataDir, persistent);
  try {
    if (!fs.existsSync(path.join(dataDir, "PG_VERSION")))
      await initialise(dataDir);
    await stopLeftover(pgCtl, dataDir, persistent, lease.previous);
  } catch (error) {
    // 켜기 전이다. postgres가 없으면 임시 cluster는 통째로 지운다. 그 밖에는(영구 DB이거나 확인하지 못한 postgres가 있음)
    // 손대지 않고, 다음 시작이 같은 판단을 다시 할 수 있게 치운 죽은 주인을 되돌린다. 정리가 실패해도 원래 오류를 덮지 않는다.
    try {
      if (!persistent && !readPidFile(dataDir)) await removeTemporary(dataDir);
      else await releaseOwner(dataDir, lease, lease.previous);
    } catch (cleanupError) {
      console.error(
        `[db] cleaning up after a failed start failed (${failureCode(cleanupError)})`
      );
    }
    throw error;
  }

  // 프로그램이 `stop`을 마치지 못하고 끝나면(process.exit, 처리되지 않은 오류, 정리 시한 초과) postgres가 이 프로세스보다 오래
  // 살아 남는다. 그 뒤로는 postgres를 챙길 쪽이 없으므로 무엇도 기다리지 않는 즉시 정지를 보낸다(다음 시작이 복구).
  // `exit`에서는 동기 작업만 할 수 있다. 켜는 중에 끝나면 보내지 않는다. 그 postgres는 이 프로세스를 주인으로 기록하고 있어
  // 다음 시작이 멈춘다.
  let started: Started | undefined;
  let stopPhase = "not stopping";
  const stopOnExit = () => {
    if (started) stopNow(pgCtl, dataDir, started, emergencyBudgetMs);
  };
  // 비상 정지는 정지가 끝난 뒤에야 내려놓는다. 이 순서는 일부러 의존한다: Postgres가 멈춘 것을 확인하지 못하면(stopCluster가 던짐)
  // 비상 정지와 주인 자격(기록·주인 연결)을 그대로 둔다. 아직 돌 수 있는 Postgres의 주인이 살아 있어야 다른 프로세스가 그 폴더를
  // 가져가 같은 Postgres 위에 켜지 않는다. 멈춘 것을 확인한 뒤의 정리 단계끼리는 서로 독립이다(removeTemporary).
  const stop = async () => {
    stopPhase = "stopping Postgres";
    await stopCluster(
      pgCtl,
      dataDir,
      stopSeconds,
      !persistent,
      (mode) => (stopPhase = `stopping Postgres (${mode})`)
    );
    process.off("exit", stopOnExit);
    if (persistent) await releaseOwner(dataDir, lease);
    else {
      stopPhase = "removing its temporary folder";
      await removeTemporary(dataDir);
    }
    stopPhase = "stopped";
  };
  process.on("exit", stopOnExit);
  const log = path.join(dataDir, logName);
  // port를 고르는 경우(`port` 없음) 그 후보를 127.0.0.1에서 잡지 못했으면(남이 먼저 잡았거나 그 port만 막힘) 다른 후보로 다시 켠다. 그 밖의 실패는 다시 하지 않는다.
  const portAttempts = 5;
  try {
    for (let attempt = 1; ; attempt++) {
      const chosen = port ?? (await candidatePort());
      await continueAfterFailure(
        () => fsp.rm(log, { force: true }),
        (error) =>
          console.error(
            `[db] the previous Postgres log could not be removed; the new start writes after it (${failureCode(error)})`
          )
      );
      // 접속하는 주소(clusterUrl의 127.0.0.1)에서만 듣는다. localhost로 두면 127.0.0.1을 남이 잡았을 때 ::1에서만 듣고 성공으로 켜져, 접속이 그 port를 잡은 다른 프로그램으로 간다.
      const options = [
        "-p",
        String(chosen),
        "-c",
        "listen_addresses=127.0.0.1",
        "-c",
        "lc_messages=C",
        ...[...(persistent ? [] : temporarySettings), ...settings].flatMap(
          (setting) => ["-c", setting]
        ),
      ];
      const code = await run(
        pgCtl,
        [
          "start",
          "-D",
          dataDir,
          "-w",
          "-t",
          String(startSeconds),
          "-l",
          log,
          "-o",
          options.join(" "),
        ],
        startSeconds * 1000 + pgCtlMarginMs
      );
      if (code === 0) {
        // 이 dataDir의 주인은 이 프로세스뿐이므로 잠금 파일의 postgres는 방금 켠 것이다.
        const running = readPidFile(dataDir);
        if (running)
          started = {
            pid: running.pid,
            identity: processIdentity(running.pid),
          };
        return { port: chosen, stop, stopping: () => stopPhase };
      }
      const tail = await logTail(log);
      if (
        port === undefined &&
        attempt < portAttempts &&
        couldNotBindPort(tail) &&
        !(await isRunning(pgCtl, dataDir))
      )
        continue;
      throw new EmbeddedPostgresFailure(
        "EMBEDDED_EXITED_BEFORE_READY",
        `embedded Postgres exited before it was ready: ${tail}`
      );
    }
  } catch (error) {
    // 이 dataDir의 주인은 이 프로세스뿐이므로 여기서 도는 postgres는 이번에 켜다 만 것이다.
    await stop().catch((stopError: unknown) =>
      console.error(
        `[db] could not stop embedded Postgres after a failed start (${failureCode(stopError)})`
      )
    );
    throw error;
  }
}

/** 새 cluster를 만든다. 실패하면 initdb가 남긴 말을 보인다. */
async function initialise(dataDir: string) {
  let log = "";
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: (message) => {
      log = (log + String(message)).slice(-1000);
    },
    onError: (error) => console.error("[embedded-postgres]", error),
  });
  try {
    await cluster.initialise();
  } catch (error) {
    throw new EmbeddedPostgresFailure(
      "EMBEDDED_CREATE_FAILED",
      `could not create embedded Postgres in ${dataDir}: ${log.trim()}`,
      { cause: error }
    );
  }
}

/**
 * 강제로 끝난 프로세스가 남긴 postgres를 멈춘다. 잠금 파일만 남고 postgres가 없으면 Postgres가 시작하며 스스로 치운다.
 * `previous`는 이 dataDir를 쓰다 죽은 주인이다. 그 기록이 없거나 그 서버가 이 dataDir를 쓰는지 확인할 수 없으면 손대지 않고
 * 시작을 멈춘다. 시한 안에 멈추지 않으면 영구 DB는 끄는 방법을 알리고 시작을 멈추고, 임시 DB는 즉시 정지까지 한다.
 */
async function stopLeftover(
  pgCtl: string,
  dataDir: string,
  persistent: boolean,
  previous: Owner | undefined
) {
  const running = readPidFile(dataDir);
  if (!running || !(await isRunning(pgCtl, dataDir))) return;
  const manual = `Stop it with: ${stopCommand(pgCtl, dataDir)}`;
  if (!previous)
    throw new EmbeddedPostgresFailure(
      "EMBEDDED_POSTGRES_UNKNOWN",
      `Postgres (pid ${running.pid}) is already running in ${dataDir} and BaboJUBot has no record of starting it. ${manual}`
    );
  if (!(await servesDataDir(running.port, dataDir)))
    throw new EmbeddedPostgresFailure(
      "EMBEDDED_POSTGRES_UNCONFIRMED",
      `Postgres (pid ${running.pid}) holds ${dataDir} but could not be confirmed as its server. ${manual}`
    );
  console.warn(
    `[db] stopping embedded Postgres left running in ${dataDir} by an earlier process (pid ${previous.pid})`
  );
  await stopCluster(pgCtl, dataDir, leftoverStopSeconds, !persistent);
}

/**
 * 정상 정지를 기다린다. 시한 안에 멈추지 않으면 `escalate`일 때 즉시 정지까지 하고, 그래도 돌면 끄는 방법과 함께 실패한다.
 * 정지 방식을 바꿀 때마다 `onMode`로 알린다.
 */
async function stopCluster(
  pgCtl: string,
  dataDir: string,
  seconds: number,
  escalate: boolean,
  onMode: (mode: string) => void = () => {}
) {
  for (const mode of escalate ? ["fast", "immediate"] : ["fast"]) {
    if (!(await isRunning(pgCtl, dataDir))) return;
    onMode(mode);
    await run(
      pgCtl,
      ["stop", "-D", dataDir, "-m", mode, "-w", "-t", String(seconds)],
      seconds * 1000 + pgCtlMarginMs
    );
  }
  if (await isRunning(pgCtl, dataDir))
    throw new EmbeddedPostgresFailure(
      "EMBEDDED_STOP_TIMEOUT",
      `embedded Postgres in ${dataDir} did not stop in ${seconds}s. Stop it with: ${stopCommand(pgCtl, dataDir)}`
    );
}

/**
 * 기다리지 않는 즉시 정지. 프로세스 종료 때 동기로 부르며 `budgetMs` 안에 끝난다. 이 프로세스가 켠 postgres에만 보낸다:
 * 잠금 파일이 아직 그 pid를 가리키고, POSIX에서는 그 pid의 OS 생성 신원이 켤 때와 같을 때만이다(pid가 재사용됐으면 다르다).
 * Windows의 pg_ctl kill은 그 pid의 Postgres만 여는 신호 통로로 보내므로 Postgres가 아닌 프로세스에는 닿지 않는다.
 * 확인할 수 없거나 시간이 없거나 닿지 않으면 보내지 않고 다음 시작에 맡긴다(주인 기록이 이 프로세스를 가리킨다).
 */
function stopNow(
  pgCtl: string,
  dataDir: string,
  started: Started,
  budgetMs: number
) {
  if (budgetMs < 1) return;
  const deadline = Date.now() + budgetMs;
  if (readPidFile(dataDir)?.pid !== started.pid) return;
  if (
    process.platform !== "win32" &&
    (!started.identity ||
      processIdentity(started.pid, budgetMs) !== started.identity)
  )
    return;
  const left = deadline - Date.now();
  if (left < 1) return;
  const result = spawnSync(pgCtl, ["kill", "QUIT", String(started.pid)], {
    stdio: "ignore",
    timeout: left,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    console.warn(
      `[db] could not ask Postgres (pid ${started.pid}) to stop as this process exits (${result.error ? failureCode(result.error) : `exit ${result.status ?? result.signal}`})`
    );
}

/** 프로세스 신원을 읽지 못한 원인을 남긴다. 모르는 신원은 같은 프로세스로 보지 않는다(손대지 않는다). */
const unknownIdentity = (pid: number) => (error: unknown) =>
  console.warn(
    `[db] could not read the identity of process ${pid}; it is not taken as the same process (${failureCode(error)})`
  );

/**
 * OS가 매긴 프로세스 생성 신원. 같은 pid라도 나중에 시작한 다른 프로세스면 달라진다. Linux는 /proc의 시작 tick,
 * 그 밖의 POSIX는 ps의 시작 시각이다. Windows는 쓰지 않는다(`stopNow` 참고). 알 수 없으면 undefined.
 */
export function processIdentity(
  pid: number,
  timeoutMs = 5_000
): string | undefined {
  if (process.platform === "win32") return undefined;
  if (process.platform === "linux") {
    // 끝난 프로세스는 신원이 없다(답이다). 그 밖의 읽기 실패는 원인을 남기고 모르는 것으로 본다.
    const stat = orIfProbeFailed(
      () =>
        orIfMissing(
          () => fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
          hasErrorCode("ENOENT", "ESRCH"),
          undefined
        ),
      undefined,
      unknownIdentity(pid)
    );
    return stat?.split(") ").at(-1)!.split(" ")[19];
  }
  if (timeoutMs < 1) return undefined;
  return orIfProbeFailed(
    () => psField(pid, "lstart", timeoutMs),
    undefined,
    unknownIdentity(pid)
  );
}

/** pg_ctl status: 0이면 그 dataDir의 잠금 파일에 적힌 프로세스가 살아 있고, 3(돌지 않음)·4(dataDir 없음)면 아니다. 그 밖의 끝남은 확인하지 못한 것이므로 던진다. */
async function isRunning(pgCtl: string, dataDir: string) {
  const code = await run(pgCtl, ["status", "-D", dataDir], pgCtlQuickMs);
  if (code === 0) return true;
  if (code === 3 || code === 4) return false;
  throw new EmbeddedPostgresFailure(
    "EMBEDDED_STATUS_UNKNOWN",
    `pg_ctl status could not tell whether Postgres runs in ${dataDir} (exit ${code})`
  );
}

/** 그 port의 Postgres가 이 dataDir를 쓰는지 접속해 확인한다. 접속하지 못하면 확인하지 못한 것이다. */
async function servesDataDir(port: number, dataDir: string) {
  const client = new pg.Client({
    connectionString: clusterUrl(port, "postgres"),
    connectionTimeoutMillis: 5_000,
  });
  // 접속한 뒤 끊기는 오류도 이 확인의 실패다. 원인을 남긴다(접속·질의의 실패는 아래 확인이 남긴다).
  client.on("error", (error) =>
    console.warn(
      `[db] the data directory check connection failed (${failureCode(error)})`
    )
  );
  try {
    return await orIfProbeFailed(
      async () => {
        await client.connect();
        const { rows } = await client.query<{ data_directory: string }>(
          "show data_directory"
        );
        return samePath(rows[0]!.data_directory, dataDir);
      },
      false,
      (error) =>
        console.warn(
          `[db] could not ask Postgres on port ${port} which data directory it serves (${failureCode(error)})`
        )
    );
  } finally {
    await continueAfterFailure(
      () => client.end(),
      (error) =>
        console.error(
          `[db] closing the data directory check connection failed (${failureCode(error)})`
        )
    );
  }
}

function samePath(a: string, b: string) {
  return fs.realpathSync.native(a) === fs.realpathSync.native(b);
}

const stopCommand = (pgCtl: string, dataDir: string) =>
  `"${pgCtl}" stop -D "${dataDir}" -m fast`;

/** `pg_ctl`이 `-t`로 기다리는 시간에 더해, 이 프로세스가 `pg_ctl` 자체의 끝을 기다리는 여유. */
const pgCtlMarginMs = 15_000;
/** 기다림이 없는 `pg_ctl` 명령(`status`)의 시한. */
const pgCtlQuickMs = 15_000;

/**
 * `pg_ctl`을 끝까지 돌리고 끝남 코드만 받는다(출력은 버린다, 위 「켜기」 참고). `pg_ctl`은 띄운 Postgres 데몬이 자기보다 오래 살아야
 * 하므로 공용 실행의 트리 끄기를 쓰지 않는다. 대신 시한(`limitMs`)에 `pg_ctl`만 SIGKILL로 끝내고 끝을 보장하며, 시한에 닿았으면
 * 무엇을 기다렸는지와 함께 던진다(`runCommand`). `pg_ctl`의 `-t`에만 기대지 않는다.
 */
async function run(file: string, args: string[], limitMs: number) {
  const result = await runCommand(file, args, { limitMs, maxOutputBytes: 0 });
  if (result.killed)
    throw new EmbeddedPostgresFailure(
      "EMBEDDED_PG_CTL_TIMEOUT",
      `pg_ctl ${args[0]} did not finish within ${limitMs / 1000}s and was ended`
    );
  return result.code ?? 1;
}

async function logTail(log: string) {
  const text = await orIfMissing(
    () => fsp.readFile(log, "utf8"),
    hasErrorCode("ENOENT"),
    ""
  ).catch(
    (error: unknown) => `Postgres log could not be read (${failureCode(error)})`
  );
  return text.trim().slice(-1000) || "Postgres wrote no log";
}

/**
 * Postgres가 127.0.0.1의 그 port를 잡지 못해 끝났는지. 남이 먼저 잡았든(Address already in use) 그 port만 막혔든
 * (Permission denied 등) 다른 후보로 다시 켤 이유다. 이유 문구는 OS마다 달라 보지 않고 Postgres 자체 문구만 본다
 * (lc_messages=C로 켠다). port와 상관없는 bind 실패면 후보마다 같은 실패가 나 `portAttempts`번 뒤 그 로그로 실패한다.
 */
function couldNotBindPort(log: string) {
  return (
    log.includes('could not bind IPv4 address "127.0.0.1"') &&
    log.includes("could not create any TCP/IP sockets")
  );
}

/** 잠금 파일의 첫 줄은 postgres pid, 넷째 줄은 port다. */
function readPidFile(
  dataDir: string
): { pid: number; port: number } | undefined {
  const text = orIfMissing(
    () => fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8"),
    hasErrorCode("ENOENT"),
    undefined
  );
  if (text === undefined) return undefined;
  const [pid, , , port] = text.split("\n");
  return Number(pid) > 0 ? { pid: Number(pid), port: Number(port) } : undefined;
}

// 주인 기록: dataDir 옆 `<dataDir>.owner/` 폴더에 세대 번호 이름의 파일(`1`, `2`, …)을 둔다. 가장 큰 번호가 지금 기록이다.
// 주인이 되려면 지금 번호 + 1 파일을 만든다. 내용을 다 쓴 임시 파일을 hard link로 붙이므로 그 번호는 한 프로세스만 만들고,
// 읽는 쪽이 반쯤 쓴 기록을 보지 않는다. 남의 기록을 옮기거나 지우지 않으므로, 몇 프로세스가 같은 죽은 주인을 다투어도
// 다음 번호를 만든 하나만 주인이 된다. 내려놓을 때도 다음 번호에 내려놓음(또는 되돌릴 죽은 주인)을 남겨 번호는 줄지 않는다.
// 지난 번호는 주인이 지운다. 오래전에 읽은 번호로 그 지워진 자리를 만든 프로세스는 더 큰 번호를 보고 물러난다.
const ownerDir = (dataDir: string) => `${path.resolve(dataDir)}${ownerSuffix}`;

/**
 * 임시 cluster의 자원(dataDir와 주인 기록)을 함께 지운다. 임시 cluster를 지우는 모든 길이 이것을 쓴다. 주인 기록은 dataDir를
 * 지운 뒤에만 지운다: 다음 시작의 남은 cluster 정리(`removeTemporaryLeftovers`)가 주인 기록으로 남은 dataDir를 찾는다.
 */
async function removeTemporary(dataDir: string) {
  const dir = ownerDir(dataDir);
  await attemptAll(
    [
      // 주인 기록은 dataDir를 지운 뒤에만 지운다(dataDir 지우기가 실패하면 기록을 남겨 다음 시작이 남은 dataDir를 찾는다).
      async () => {
        await fsp.rm(dataDir, { recursive: true, force: true });
        await fsp.rm(dir, { recursive: true, force: true });
      },
      // 폴더 지우기와 무관하게 주인 연결은 닫는다. 이 함수는 Postgres가 멈췄거나 켜지 않은 뒤에만 불리므로 붙잡을 것이 없고, 남은
      // 폴더는 주인 없는 남은 cluster로 다음 시작의 정리(`removeTemporaryLeftovers`)가 가져가 지운다.
      () => dropConnection(dir),
    ],
    `the temporary cluster ${dataDir} could not be removed`
  );
}

function generations(dir: string): number[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 지금 기록. `owner`가 없으면 내려놓았거나 내용을 해석할 수 없는 기록이다. 읽기 오류는 던진다. */
function latest(dir: string): { generation: number; owner: Owner | undefined } {
  const generation = generations(dir).at(-1) ?? 0;
  return {
    generation,
    owner: generation
      ? readOwnerFile(path.join(dir, String(generation)))
      : undefined,
  };
}

/** 그 번호의 기록을 내용째 한 번에 만든다. 이미 있으면 false. */
function claim(dir: string, generation: number, record: object): boolean {
  const temp = path.join(dir, `.${process.pid}.${generation}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(record));
  try {
    fs.linkSync(temp, path.join(dir, String(generation)));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    removeQuietly(temp);
  }
}

/** 지난 기록 정리는 덤이다. Windows에서 다른 프로세스가 잠깐 읽는 중이면 지우지 못해도 더 작은 번호라 판단에 쓰이지 않는다. 그 실패는 기록에 남긴다. */
function removeQuietly(file: string) {
  continueAfterFailure(
    () => fs.rmSync(file, { force: true }),
    (error) =>
      console.error(
        `[db] an old owner record ${file} could not be removed; the larger number still decides (${failureCode(error)})`
      )
  );
}

/**
 * 주인 연결(#268). 번호(pid)는 주인이 죽은 뒤 다른 프로그램에 다시 주어지거나, 부모가 거두지 않은 채(좀비) 남아 신호 0에 "살아 있음"으로
 * 답할 수 있다. 그래서 주인은 주인인 동안 연결 하나를 듣고, 다른 프로세스는 그 연결에 닿는지로 주인이 살아 있는지 본다. 주인이 죽으면
 * OS가 연결을 닫는다. VS Code가 한 사용자 데이터 폴더를 한 프로세스만 쓰게 하는 방식과 같다(IPC 핸들을 듣고, 닿지 않으면 남은 것으로 본다).
 *
 * - 소켓 파일은 이 사용자 전용 폴더(`babojubot-<uid>`, 이 사용자 소유·0700·링크 아님, XDG Base Directory의 `XDG_RUNTIME_DIR` 요건과 같다)에만
 *   둔다. 주인마다 새 무작위 이름으로 들으므로 남은 파일이 다음 주인을 막지 않는다.
 * - 기록에서 읽은 자리는 연결만 해 본다. 지우지 않는다: 기록이 가리키는 파일을 남이 지우면, 그 경로가 다른 폴더나 다른 파일로 바뀌는
 *   틈을 막을 수 없다(PostgreSQL도 소켓 잠금 파일을 지울 때 소유권에 기대며 그 위험을 밝힌다). 주인이 죽어 남은 소켓은 이 사용자의
 *   프로세스가 자기 전용 폴더를 훑어 치운다.
 * - 소켓 경로 한도(Linux 107, macOS 103)는 완성 경로의 UTF-8 바이트로 잰다.
 */
const handlePrefix = "babojubot-owner-";
const socketPathLimit: Partial<Record<NodeJS.Platform, number>> = {
  linux: 107,
  darwin: 103,
};
const ownerSocketName = /^babojubot-owner-[0-9a-f]{16}\.sock$/;
const ownerPipe = /^\\\\\.\\pipe\\babojubot-owner-[0-9a-f]{32}$/;
/** 이 프로세스가 주인으로 듣는 연결. 주인 기록 폴더 → 그 연결. */
const held = new Map<string, { handle: string; server: net.Server }>();
/** 이 프로세스가 남은 소켓을 이미 훑은 전용 폴더. */
const swept = new Set<string>();

/**
 * 이 사용자 전용 폴더에서 주인 연결을 듣는다. 후보(Linux의 `XDG_RUNTIME_DIR`, 임시 폴더, `/tmp`) 아래 `babojubot-<uid>` 가운데
 * 소켓 경로가 바이트 한도 안에 들고 실제로 들을 수 있는 첫 자리를 쓴다. 후보마다 사전 검사를 모두 한 뒤 그 자리에서 실제로 듣기까지가 그 후보의 시도다. 듣기가
 * 실패하면 그 원인을 남기고 다음 후보로 가며, 모두 실패하면 후보별 원인과 함께 던진다.
 */
async function listenInPrivateFolder(): Promise<{
  handle: string;
  server: net.Server;
}> {
  const limit = socketPathLimit[process.platform] ?? 103;
  const uid = process.getuid!();
  const sample = `${handlePrefix}${"0".repeat(16)}.sock`;
  const bases = [
    ...(process.platform !== "darwin" && process.env.XDG_RUNTIME_DIR
      ? [process.env.XDG_RUNTIME_DIR]
      : []),
    os.tmpdir(),
    "/tmp",
  ];
  let chosen: { handle: string; server: net.Server } | undefined;
  // 후보마다 따로 본다: 한 후보를 쓸 수 없으면(경로가 길다, 그 자리에 파일이 있다, 이 사용자 전용이 아니다, 이 사용자도 쓸 수
  // 없다) 그 이유를 남기고 다음 후보로 간다. 사전 검사를 통과해도 그 자리에서 듣기가 실패할 수 있어, 듣기까지가 그 후보의 시도다.
  // 모두 안 되면 후보별 이유를 함께 담아 거절한다.
  const failures = await attemptEach(
    [...new Set(bases)].map((base) => async () => {
      if (chosen !== undefined) return;
      const folder = path.join(base, `babojubot-${uid}`);
      if (Buffer.byteLength(path.join(folder, sample)) >= limit)
        throw new EmbeddedPostgresFailure(
          "EMBEDDED_SOCKET_PATH_TOO_LONG",
          `${folder}: a socket path there would be longer than ${limit} bytes`
        );
      fs.mkdirSync(folder, { mode: 0o700, recursive: true });
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
        throw new EmbeddedPostgresFailure(
          "EMBEDDED_FOLDER_NOT_PRIVATE",
          `${folder} is not a private folder of this user (owned by this user, mode 0700, not a link)`
        );
      // 소켓을 만들려면 이 사용자가 그 폴더에 쓰고 들어갈 수 있어야 한다(0500 같은 폴더는 남은 막혀도 이 사용자도 못 쓴다).
      fs.accessSync(folder, fs.constants.W_OK | fs.constants.X_OK);
      sweepStaleSockets(folder);
      const handle = path.join(
        folder,
        `${handlePrefix}${randomUUID().replaceAll("-", "").slice(0, 16)}.sock`
      );
      const server = await listenAt(handle);
      chosen = { handle, server };
    })
  );
  if (chosen !== undefined) return chosen;
  throw new EmbeddedPostgresFailure(
    "EMBEDDED_NO_OWNER_FOLDER",
    "no private folder for embedded Postgres owner connections",
    { cause: combinedFailure(failures, "every candidate folder failed") }
  );
}

/** 그 자리에서 주인 연결을 듣는 서버를 연다. 듣지 못하면 그 listen 오류를 그대로 던진다(자리가 이름에 담긴다). */
function listenAt(handle: string): Promise<net.Server> {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(handle, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * 이 사용자 전용 폴더에 남은 주인 소켓(주인이 강제로 끝나 남긴 파일)을 치운다. 프로세스마다 폴더당 한 번이다. 연결을 받는 소켓은
 * 살아 있는 주인의 것이라 둔다. 폴더는 이 사용자만 쓸 수 있어, 확인과 지우기 사이에 그 자리를 바꿀 수 있는 것은 이 사용자의 프로세스뿐이다.
 */
function sweepStaleSockets(folder: string) {
  if (swept.has(folder)) return;
  swept.add(folder);
  const names =
    continueAfterFailure(
      () => fs.readdirSync(folder),
      (error) =>
        console.error(
          `[db] stale owner connections in ${folder} could not be listed; they are harmless (${failureCode(error)})`
        )
    ) ?? [];
  // 남은 파일 치우기는 덤이라 주인 되기를 기다리게 하지 않는다. 확인하지 못한 소켓은 둔다.
  void (async () => {
    for (const name of names.filter((each) => ownerSocketName.test(each))) {
      const socket = path.join(folder, name);
      const answered = await continueAfterFailure(
        () => connectsTo(socket),
        (error) =>
          console.error(
            `[db] whether ${socket} still has an owner could not be checked; it is left (${failureCode(error)})`
          )
      );
      if (answered !== false) continue;
      continueAfterFailure(
        () => {
          if (fs.lstatSync(socket, { throwIfNoEntry: false })?.isSocket())
            fs.unlinkSync(socket);
        },
        (error) =>
          console.error(
            `[db] a stale owner connection ${socket} could not be removed; it is harmless (${failureCode(error)})`
          )
      );
    }
  })();
}

/** 이 주인 기록 폴더의 주인으로 연결 하나를 듣는다. 이 프로세스가 끝날 때까지 붙잡지 않는다(unref). 들은 자리를 돌려준다. */
async function holdConnection(dir: string) {
  let handle: string;
  let server: net.Server;
  if (process.platform === "win32") {
    const id = randomUUID().replaceAll("-", "");
    handle = `\\\\.\\pipe\\${handlePrefix}${id}`;
    server = await listenAt(handle);
  } else {
    ({ handle, server } = await listenInPrivateFolder());
  }
  server.unref();
  held.set(dir, { handle, server });
  return handle;
}

/**
 * 이 주인 기록 폴더의 주인 연결을 닫고, 닫힌 것을 확인한다(소켓 파일도 함께 지워진다). 쥐지 않았으면 아무것도 하지 않는다. 닫기가
 * 실패하면 그 원인과 함께 `EMBEDDED_OWNER_CLOSE_FAILED`로 던진다(#286). 닫기에 시간 상한을 두지 않는다(#288 리뷰 2회차 STD-3): 서버는
 * 받은 연결을 처리기에서 바로 끊으므로(`listenAt`의 `socket.destroy()`) 닫기의 끝이 상대에 달려 있지 않다. 상대가 자기 쪽을 쥐고
 * 있어도 끝나는 것은 embedded-owner.test.ts의 "releases its owner connection while another side keeps its end of a connection open"이
 * 본다.
 */
async function dropConnection(dir: string) {
  const connection = held.get(dir);
  if (!connection) return;
  held.delete(dir);
  await new Promise<void>((resolve, reject) =>
    connection.server.close((error) =>
      error
        ? reject(
            new EmbeddedPostgresFailure(
              "EMBEDDED_OWNER_CLOSE_FAILED",
              `the owner connection ${connection.handle} could not be closed`,
              { cause: error }
            )
          )
        : resolve()
    )
  );
}

/** 주인 연결에 닿는지 보는 상한. 같은 컴퓨터의 연결이라 곧 답한다. */
const ownerCheckMs = 5_000;

/**
 * 그 자리의 연결에 닿는가. 닿으면 true, 그 자리가 없거나(ENOENT) 듣는 쪽이 없으면(ECONNREFUSED) false다. 그 밖의 실패나 상한
 * 초과는 모르는 것이라 원인과 함께 거절한다. 연결만 해 보고 아무것도 지우지 않는다.
 */
function connectsTo(handle: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.connect(handle);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new EmbeddedPostgresFailure(
          "EMBEDDED_OWNER_NO_ANSWER",
          `the connection ${handle} did not answer within ${ownerCheckMs} ms`
        )
      );
    }, ownerCheckMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (hasErrorCode("ENOENT", "ECONNREFUSED")(error)) resolve(false);
      else reject(error);
    });
  });
}

/**
 * 기록한 주인이 지금 살아 있는가. 주인 연결에 닿으면 살아 있고, 닿지 않으면 죽었다. 확인하지 못하면 원인과 함께 던진다(손대지 않는다).
 * 예전 형식 기록(연결 없음)은 이 판 전에 쓴 것이라 번호로만 본다(`legacyOwnerAlive`).
 */
async function ownerAlive(dir: string, owner: Owner): Promise<boolean> {
  if (owner.handle === undefined) return legacyOwnerAlive(owner.pid);
  if (held.get(dir)?.handle === owner.handle) return true;
  try {
    return await connectsTo(owner.handle);
  } catch (error) {
    throw new EmbeddedPostgresFailure(
      "EMBEDDED_OWNER_UNCHECKED",
      `whether the owner of ${dir} runs could not be checked`,
      { cause: error }
    );
  }
}

/**
 * 예전 형식 기록(연결 없이 번호만 적음)의 주인이 살아 있는가. 다른 사용자의 프로세스면 EPERM이며 살아 있다. 번호가 재사용됐으면
 * 살아 있다고 보아 손대지 않는다(이전 판과 같은 판단). 이 판부터 쓰는 기록에는 연결이 있어 이 길을 지나지 않는다.
 */
function legacyOwnerAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 주인 기록 폴더마다 진행 중인 획득. 한 프로세스 안에서 같은 폴더의 획득은 앞 획득이 끝난 뒤에 한다. */
const acquiring = new Map<string, Promise<unknown>>();

/**
 * 이 dataDir의 주인이 된다. 지금 기록의 주인이 살아 있으면 실패한다. 죽었거나 내려놓았으면 주인 연결을 듣고, 그 자리를 담아 다음
 * 번호를 만든다. 돌려주는 `previous`는 바로 전 세대의 죽은 주인이다(남은 Postgres를 멈춰도 되는지 판단할 때 쓴다). 한 프로세스 안의
 * 같은 폴더 획득은 차례로 한다(앞 획득의 연결을 덮어 잃지 않게). 이번에 연 연결은 실패하면 닫는다. 이미 쥔 연결(ephemeralCluster가 먼저
 * 얻은 것)은 그대로 둔다.
 */
async function acquireOwner(
  dataDir: string,
  persistent: boolean
): Promise<Lease> {
  const dir = ownerDir(dataDir);
  const before = acquiring.get(dir) ?? Promise.resolve();
  // 앞 획득의 결과는 그 획득을 부른 쪽이 받는다. 여기서는 끝난 뒤에 이어 할 뿐이다.
  const turn = settled(before).then(() =>
    takeOwnership(dataDir, dir, persistent)
  );
  acquiring.set(dir, turn);
  try {
    return await turn;
  } finally {
    if (acquiring.get(dir) === turn) acquiring.delete(dir);
  }
}

async function takeOwnership(
  dataDir: string,
  dir: string,
  persistent: boolean
): Promise<Lease> {
  fs.mkdirSync(dir, { recursive: true });
  /** 이번 획득이 연 주인 연결. 실패하면 이것만 닫는다. */
  let opened = false;
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const { generation, owner } = latest(dir);
      if (owner && (await ownerAlive(dir, owner))) {
        // 임시 cluster는 ephemeralCluster가 만들 때 이 프로세스가 이미 주인이 되었다.
        if (
          owner.handle !== undefined &&
          held.get(dir)?.handle === owner.handle &&
          !owner.persistent &&
          !persistent
        )
          return { generation, previous: undefined };
        throw new EmbeddedPostgresFailure(
          "EMBEDDED_IN_USE",
          `embedded Postgres in ${dataDir} is in use by a running process (pid ${owner.pid}). Stop that process first. If no BaboJUBot process uses it, delete ${dir}.`
        );
      }
      let handle = held.get(dir)?.handle;
      if (handle === undefined) {
        handle = await holdConnection(dir);
        opened = true;
      }
      const mine = generation + 1;
      const record: Owner = { pid: process.pid, persistent, handle };
      if (!claim(dir, mine, record)) continue;
      if (latest(dir).generation !== mine) {
        removeQuietly(path.join(dir, String(mine)));
        continue;
      }
      for (const old of generations(dir))
        if (old < mine) removeQuietly(path.join(dir, String(old)));
      opened = false;
      return { generation: mine, previous: owner };
    }
    throw new EmbeddedPostgresFailure(
      "EMBEDDED_OWNERSHIP_CONTESTED",
      `could not take ownership of ${dataDir}`
    );
  } catch (error) {
    // 이번에 연 연결만 닫는다. 닫기가 실패해도 주인이 되지 못한 원래 실패를 덮지 않고, 닫기 실패는 원인 코드로 남긴다.
    if (opened)
      await dropConnection(dir).catch((closeError: unknown) =>
        console.error(
          `[db] the owner connection opened for ${dataDir} could not be closed after taking ownership failed (${failureCode(closeError)})`
        )
      );
    throw error;
  }
}

/**
 * 주인을 내려놓는다. 다음 번호에 내려놓음을 남기거나, 시작하지 못했을 때는 치운 죽은 주인을 되돌려 남긴다. 주인 연결도 닫고 닫힌 것을
 * 확인한다. 기록 남기기와 연결 닫기는 서로 독립이라 앞이 실패해도 뒤를 하고, 실패는 모아 던진다.
 */
async function releaseOwner(dataDir: string, lease: Lease, restore?: Owner) {
  const dir = ownerDir(dataDir);
  await attemptAll(
    [
      () => {
        if (claim(dir, lease.generation + 1, restore ?? { released: true }))
          removeQuietly(path.join(dir, String(lease.generation)));
      },
      () => dropConnection(dir),
    ],
    `the owner of ${dataDir} could not be released`
  );
}

function readOwnerFile(file: string): Owner | undefined {
  // 세대가 넘어가며 지워진 기록은 없는 것이다(acquireOwner가 다시 본다). 그 밖의 읽기 오류는 던진다.
  const text = orIfMissing(
    () => fs.readFileSync(file, "utf8"),
    hasErrorCode("ENOENT"),
    undefined
  );
  if (text === undefined) return undefined;
  const owner = orIfUnreadable((): unknown => JSON.parse(text), undefined);
  if (typeof owner !== "object" || owner === null || Array.isArray(owner))
    return undefined;
  if (!("pid" in owner) || !("persistent" in owner)) return undefined;
  const { pid, persistent } = owner;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    typeof persistent !== "boolean"
  )
    return undefined;
  if (!("handle" in owner)) return { pid, persistent };
  // 주인 연결이 있는 기록은 이 판이 쓴 모양이어야 한다. 아니면 해석할 수 없는 기록이다.
  const { handle } = owner;
  return typeof handle === "string" &&
    (process.platform === "win32"
      ? ownerPipe.test(handle)
      : path.isAbsolute(handle) && ownerSocketName.test(path.basename(handle)))
    ? { pid, persistent, handle }
    : undefined;
}

/** 임시 dataDir. port는 켤 때 고른다(`startEmbeddedCluster`). 정지 때 dataDir를 지운다. 먼저 강제로 끝난 프로세스가 남긴 임시 cluster를 치운다. */
export async function ephemeralCluster(): Promise<EmbeddedOptions> {
  await removeTemporaryLeftovers();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  try {
    await acquireOwner(dataDir, false);
    return { dataDir, persistent: false };
  } catch (error) {
    await removeTemporary(dataDir).catch((removeError: unknown) =>
      console.error(
        `[db] removing the temporary folder after a failed start failed (${failureCode(removeError)})`
      )
    );
    throw error;
  }
}

/**
 * 강제로 끝난 프로세스가 남긴 임시 cluster를 멈추고 지운다. 주인 기록(`*.owner/`)이 있는 것만 보며, 그 dataDir의 주인이
 * 되어야 손댄다(주인이 살아 있거나 다른 프로세스가 먼저 치우는 중이면 둔다). 그 Postgres가 그 dataDir를 쓰는지 확인할 수 없으면
 * 둔다. 실패는 알리기만 하고 새 cluster는 그대로 띄운다. 살피지 못한 항목은 손대지 않고 남긴다.
 * tmp는 다른 프로그램도 쓰므로 이름만 믿지 않는다. 주인 기록과 dataDir는 tmp 바로 아래의 실제 폴더여야 하며 링크는 따라가지 않는다.
 */
async function removeTemporaryLeftovers() {
  const tmp = os.tmpdir();
  const entries =
    (await continueAfterFailure(
      () =>
        orIfMissing(
          () => fsp.readdir(tmp, { withFileTypes: true }),
          hasErrorCode("ENOENT"),
          [] as fs.Dirent[]
        ),
      (error) =>
        console.error(
          `[db] the temporary folder could not be listed; leftover temporary clusters are not cleaned at this start (${failureCode(error)})`
        )
    )) ?? [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(temporaryPrefix) ||
      !entry.name.endsWith(ownerSuffix)
    )
      continue;
    const dataDir = path.join(tmp, entry.name.slice(0, -ownerSuffix.length));
    // 남은 cluster 하나를 살피지 못하면 그것만 기록하고 건너뛴다. 주인 자리를 가져가거나 지우지 않는다.
    const inspected = continueAfterFailure(
      () => ({
        folder: fs.lstatSync(dataDir, { throwIfNoEntry: false }),
        owner: latest(ownerDir(dataDir)).owner,
      }),
      (error) =>
        console.error(
          `[db] the leftover temporary cluster ${dataDir} could not be inspected; it is left (${failureCode(error)})`
        )
    );
    if (!inspected) continue;
    const { folder, owner } = inspected;
    if (folder && !folder.isDirectory()) continue;
    // 죽은 임시 주인의 것, 또는 주인 없이(내려놓았거나 내용을 해석할 수 없음) 기록만 남고 dataDir가 없는 것만 치운다.
    if (owner ? owner.persistent : folder !== undefined) continue;
    // 주인이 살아 있으면 둔다. 살아 있는지 모르면(연결 확인 실패) 기록만 하고 둔다.
    if (owner) {
      const alive = await continueAfterFailure(
        () => ownerAlive(ownerDir(dataDir), owner),
        (error) =>
          console.error(
            `[db] whether the owner of the leftover temporary cluster ${dataDir} runs could not be checked; it is left (${failureCode(error)})`
          )
      );
      if (alive !== false) continue;
    }
    const lease = await continueAfterFailure(
      () => acquireOwner(dataDir, false),
      (error) =>
        console.error(
          `[db] the leftover temporary cluster ${dataDir} could not be taken over; it is left (${failureCode(error)})`
        )
    );
    if (!lease) continue;
    // 남은 것 치우기는 덤이다. 내려놓기가 실패해도 원인 코드를 남기고 다음 항목으로 간다.
    const release = () =>
      continueAfterFailure(
        () => releaseOwner(dataDir, lease, lease.previous),
        (error) =>
          console.error(
            `[db] the leftover temporary cluster ${dataDir} could not be released; it is left (${failureCode(error)})`
          )
      );
    try {
      const { pg_ctl: pgCtl } = await getBinaries();
      const running = readPidFile(dataDir);
      if (running && (await isRunning(pgCtl, dataDir))) {
        if (!(await servesDataDir(running.port, dataDir))) {
          console.warn(
            `[db] left temporary Postgres in ${dataDir}: could not confirm it serves that folder`
          );
          await release();
          continue;
        }
        await stopCluster(pgCtl, dataDir, leftoverStopSeconds, true);
      }
      await removeTemporary(dataDir);
    } catch (error) {
      console.warn(
        `[db] could not remove temporary Postgres left in ${dataDir} (${failureCode(error)})`
      );
      await release();
    }
  }
}
