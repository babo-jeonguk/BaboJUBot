import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres, { getBinaries } from "embedded-postgres";
import pg from "pg";
import { candidatePort } from "./ports.ts";

/** 이 프로세스가 띄우고 멈추는 embedded Postgres. `persistent: false`면 정지 때 dataDir를 지운다. */
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

// Postgres는 모든 OS에서 묶여 온 pg_ctl로 켜고 끈다(docs/research/embedded-postgres-lifecycle-references.md).
// - 켜기: pg_ctl은 POSIX에서 Postgres를 새 session으로 띄우고, Windows에서는 관리자 권한을 내려놓고 숨은 콘솔에서 띄운다.
//   그래서 터미널의 Ctrl+C·창 닫기가 Postgres에 바로 가지 않고, Windows 관리자 계정에서도 켜진다. Windows에서 pg_ctl에 출력
//   통로를 주면 Postgres가 그 통로를 물려받아 닫히지 않으므로 출력은 버리고 끝남 코드만 본다. 실패 이유는 Postgres 로그에서 읽는다.
// - 끄기: 정상 정지(fast)를 요청하고 끝날 때까지 기다린다. Windows도 Postgres 자체 신호로 정상 정지한다.
// - 주인: dataDir 하나는 한 프로세스만 쓴다(`acquireOwner`). 만들기·남은 Postgres 정리·켜기·끄기·지우기는 주인만 한다.
// - 다음 시작: 강제로 끝난 프로세스가 남긴 Postgres는 기록된 주인이 죽었고 그 서버가 이 dataDir를 쓰는 것이 접속으로 확인될
//   때만 멈춘다. 잠금 파일(postmaster.pid)만으로는 무관한 프로세스와 구별할 수 없다.
// - port: 정한 port가 없으면 빈 port 후보로 켜고, 그 사이 남이 잡았으면 다른 후보로 다시 켠다. 번호만 미리 받아 두면 다른 프로세스가 먼저 잡을 수 있다.
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

/** 이 dataDir를 쓰는 프로세스. */
type Owner = { pid: number; persistent: boolean };
/** 이 프로세스가 얻은 주인 세대와, 바로 전 세대의 죽은 주인. */
type Lease = { generation: number; previous: Owner | undefined };
/** 이 프로세스가 켠 postgres. `identity`는 OS가 매긴 프로세스 생성 신원이다(`processIdentity`). */
type Started = { pid: number; identity: string | undefined };

/** 켠 embedded cluster. `port`는 Postgres가 실제로 듣는 port다. `stop`이 돌아오면 postgres는 끝났다. */
export type EmbeddedCluster = { port: number; stop: () => Promise<void> };

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
      throw new Error(`unsupported Postgres setting "${setting}"`);
  const { pg_ctl: pgCtl } = await getBinaries();
  const lease = acquireOwner(dataDir, persistent);
  try {
    if (!fs.existsSync(path.join(dataDir, "PG_VERSION")))
      await initialise(dataDir);
    await stopLeftover(pgCtl, dataDir, persistent, lease.previous);
  } catch (error) {
    // 켜기 전이다. postgres가 없으면 임시 cluster는 통째로 지운다. 그 밖에는(영구 DB이거나 확인하지 못한 postgres가 있음)
    // 손대지 않고, 다음 시작이 같은 판단을 다시 할 수 있게 치운 죽은 주인을 되돌린다.
    if (!persistent && !readPidFile(dataDir)) await removeTemporary(dataDir);
    else releaseOwner(dataDir, lease, lease.previous);
    throw error;
  }

  // 프로그램이 `stop`을 마치지 못하고 끝나면(process.exit, 처리되지 않은 오류, 정리 시한 초과) postgres가 이 프로세스보다 오래
  // 살아 남는다. 그 뒤로는 postgres를 챙길 쪽이 없으므로 무엇도 기다리지 않는 즉시 정지를 보낸다(다음 시작이 복구).
  // `exit`에서는 동기 작업만 할 수 있다. 켜는 중에 끝나면 보내지 않는다. 그 postgres는 이 프로세스를 주인으로 기록하고 있어
  // 다음 시작이 멈춘다.
  let started: Started | undefined;
  const stopOnExit = () => {
    if (started) stopNow(pgCtl, dataDir, started, emergencyBudgetMs);
  };
  // 비상 정지는 정지가 끝난 뒤에야 내려놓는다.
  const stop = async () => {
    await stopCluster(pgCtl, dataDir, stopSeconds, !persistent);
    process.off("exit", stopOnExit);
    if (persistent) releaseOwner(dataDir, lease);
    else await removeTemporary(dataDir);
  };
  process.on("exit", stopOnExit);
  const log = path.join(dataDir, logName);
  // port를 고르는 경우(`port` 없음) 고른 번호를 다른 프로세스가 먼저 잡았으면 다른 번호로 다시 켠다. 그 밖의 실패는 다시 하지 않는다.
  const portAttempts = 5;
  try {
    for (let attempt = 1; ; attempt++) {
      const chosen = port ?? (await candidatePort());
      await fsp.rm(log, { force: true }).catch(() => {});
      // 접속하는 주소(clusterUrl의 127.0.0.1)에서만 듣는다. localhost로 두면 127.0.0.1을 남이 잡았을 때 ::1에서만 듣고 성공으로 켜져, 접속이 그 port를 잡은 다른 프로그램으로 간다.
      const options = [
        "-p",
        String(chosen),
        "-c",
        "listen_addresses=127.0.0.1",
        "-c",
        "lc_messages=C",
        ...settings.flatMap((setting) => ["-c", setting]),
      ];
      const code = await run(pgCtl, [
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
      ]);
      if (code === 0) {
        // 이 dataDir의 주인은 이 프로세스뿐이므로 잠금 파일의 postgres는 방금 켠 것이다.
        const running = readPidFile(dataDir);
        if (running)
          started = {
            pid: running.pid,
            identity: processIdentity(running.pid),
          };
        return { port: chosen, stop };
      }
      const tail = await logTail(log);
      if (
        port === undefined &&
        attempt < portAttempts &&
        portTaken(tail) &&
        !(await isRunning(pgCtl, dataDir))
      )
        continue;
      throw new Error(`embedded Postgres exited before it was ready: ${tail}`);
    }
  } catch (error) {
    // 이 dataDir의 주인은 이 프로세스뿐이므로 여기서 도는 postgres는 이번에 켜다 만 것이다.
    await stop().catch((stopError: unknown) =>
      console.error(
        "[db] could not stop embedded Postgres after a failed start",
        stopError
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
    throw new Error(
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
    throw new Error(
      `Postgres (pid ${running.pid}) is already running in ${dataDir} and BaboJUBot has no record of starting it. ${manual}`
    );
  if (!(await servesDataDir(running.port, dataDir)))
    throw new Error(
      `Postgres (pid ${running.pid}) holds ${dataDir} but could not be confirmed as its server. ${manual}`
    );
  console.warn(
    `[db] stopping embedded Postgres left running in ${dataDir} by an earlier process (pid ${previous.pid})`
  );
  await stopCluster(pgCtl, dataDir, leftoverStopSeconds, !persistent);
}

/** 정상 정지를 기다린다. 시한 안에 멈추지 않으면 `escalate`일 때 즉시 정지까지 하고, 그래도 돌면 끄는 방법과 함께 실패한다. */
async function stopCluster(
  pgCtl: string,
  dataDir: string,
  seconds: number,
  escalate: boolean
) {
  for (const mode of escalate ? ["fast", "immediate"] : ["fast"]) {
    if (!(await isRunning(pgCtl, dataDir))) return;
    await run(pgCtl, [
      "stop",
      "-D",
      dataDir,
      "-m",
      mode,
      "-w",
      "-t",
      String(seconds),
    ]);
  }
  if (await isRunning(pgCtl, dataDir))
    throw new Error(
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
  spawnSync(pgCtl, ["kill", "QUIT", String(started.pid)], {
    stdio: "ignore",
    timeout: left,
    windowsHide: true,
  });
}

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
    try {
      return fs
        .readFileSync(`/proc/${pid}/stat`, "utf8")
        .split(") ")
        .at(-1)!
        .split(" ")[19];
    } catch {
      return undefined;
    }
  }
  if (timeoutMs < 1) return undefined;
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
  });
  const text = result.status === 0 ? result.stdout.trim() : "";
  return text || undefined;
}

/** pg_ctl status: 0이면 그 dataDir의 잠금 파일에 적힌 프로세스가 살아 있다. */
async function isRunning(pgCtl: string, dataDir: string) {
  return (await run(pgCtl, ["status", "-D", dataDir])) === 0;
}

/** 그 port의 Postgres가 이 dataDir를 쓰는지 접속해 확인한다. 접속하지 못하면 확인하지 못한 것이다. */
async function servesDataDir(port: number, dataDir: string) {
  const client = new pg.Client({
    connectionString: clusterUrl(port, "postgres"),
    connectionTimeoutMillis: 5_000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    const { rows } = await client.query<{ data_directory: string }>(
      "show data_directory"
    );
    return samePath(rows[0]!.data_directory, dataDir);
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function samePath(a: string, b: string) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return false;
  }
}

const stopCommand = (pgCtl: string, dataDir: string) =>
  `"${pgCtl}" stop -D "${dataDir}" -m fast`;

/** 출력은 버리고 끝남 코드만 받는다(위 「켜기」 참고). */
function run(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function logTail(log: string) {
  const text = await fsp.readFile(log, "utf8").catch(() => "");
  return text.trim().slice(-1000) || "Postgres wrote no log";
}

/** Postgres가 127.0.0.1의 그 port를 잡지 못해 끝났는지. 메시지는 Postgres 자체 문구다(lc_messages=C로 켠다). */
function portTaken(log: string) {
  return (
    log.includes('could not bind IPv4 address "127.0.0.1"') &&
    log.includes("could not create any TCP/IP sockets")
  );
}

/** 잠금 파일의 첫 줄은 postgres pid, 넷째 줄은 port다. */
function readPidFile(
  dataDir: string
): { pid: number; port: number } | undefined {
  try {
    const [pid, , , port] = fs
      .readFileSync(path.join(dataDir, "postmaster.pid"), "utf8")
      .split("\n");
    return Number(pid) > 0
      ? { pid: Number(pid), port: Number(port) }
      : undefined;
  } catch {
    return undefined;
  }
}

// 주인 기록: dataDir 옆 `<dataDir>.owner/` 폴더에 세대 번호 이름의 파일(`1`, `2`, …)을 둔다. 가장 큰 번호가 지금 기록이다.
// 주인이 되려면 지금 번호 + 1 파일을 만든다. 내용을 다 쓴 임시 파일을 hard link로 붙이므로 그 번호는 한 프로세스만 만들고,
// 읽는 쪽이 반쯤 쓴 기록을 보지 않는다. 남의 기록을 옮기거나 지우지 않으므로, 몇 프로세스가 같은 죽은 주인을 다투어도
// 다음 번호를 만든 하나만 주인이 된다. 내려놓을 때도 다음 번호에 내려놓음(또는 되돌릴 죽은 주인)을 남겨 번호는 줄지 않는다.
// 지난 번호는 주인이 지운다. 오래전에 읽은 번호로 그 지워진 자리를 만든 프로세스는 더 큰 번호를 보고 물러난다.
const ownerDir = (dataDir: string) => `${path.resolve(dataDir)}${ownerSuffix}`;

/** 임시 cluster의 자원(dataDir와 주인 기록)을 함께 지운다. 임시 cluster를 지우는 모든 길이 이것을 쓴다. */
async function removeTemporary(dataDir: string) {
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(ownerDir(dataDir), { recursive: true, force: true });
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

/** 지금 기록. `owner`가 없으면 내려놓았거나 읽을 수 없는 기록이다. */
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

/** 지난 기록 정리는 덤이다. Windows에서 다른 프로세스가 잠깐 읽는 중이면 지우지 못해도 더 작은 번호라 판단에 쓰이지 않는다. */
function removeQuietly(file: string) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 더 작은 번호로 남는다. */
  }
}

/**
 * 이 dataDir의 주인이 된다. 지금 기록의 주인이 살아 있으면 실패한다. 죽었거나 내려놓았으면 다음 번호를 만든다.
 * 돌려주는 `previous`는 바로 전 세대의 죽은 주인이다(남은 Postgres를 멈춰도 되는지 판단할 때 쓴다).
 */
function acquireOwner(dataDir: string, persistent: boolean): Lease {
  const dir = ownerDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    const { generation, owner } = latest(dir);
    if (owner && isAlive(owner.pid)) {
      // 임시 cluster는 ephemeralCluster가 만들 때 이 프로세스 이름으로 이미 기록했다.
      if (owner.pid === process.pid && !owner.persistent && !persistent)
        return { generation, previous: undefined };
      throw new Error(
        `embedded Postgres in ${dataDir} is in use by a running process (pid ${owner.pid}). Stop that process first. If no BaboJUBot process uses it, delete ${dir}.`
      );
    }
    const mine = generation + 1;
    const record: Owner = { pid: process.pid, persistent };
    if (!claim(dir, mine, record)) continue;
    if (latest(dir).generation !== mine) {
      removeQuietly(path.join(dir, String(mine)));
      continue;
    }
    for (const old of generations(dir))
      if (old < mine) removeQuietly(path.join(dir, String(old)));
    return { generation: mine, previous: owner };
  }
  throw new Error(`could not take ownership of ${dataDir}`);
}

/** 주인을 내려놓는다. 다음 번호에 내려놓음을 남기거나, 시작하지 못했을 때는 치운 죽은 주인을 되돌려 남긴다. */
function releaseOwner(dataDir: string, lease: Lease, restore?: Owner) {
  const dir = ownerDir(dataDir);
  if (claim(dir, lease.generation + 1, restore ?? { released: true }))
    removeQuietly(path.join(dir, String(lease.generation)));
}

function readOwnerFile(file: string): Owner | undefined {
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(owner?.pid) &&
      typeof owner?.persistent === "boolean"
      ? { pid: owner.pid, persistent: owner.persistent }
      : undefined;
  } catch {
    return undefined;
  }
}

/** 다른 사용자의 프로세스면 EPERM이며 살아 있다. pid가 재사용됐으면 살아 있다고 보아 손대지 않는다. */
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 임시 dataDir. port는 켤 때 고른다(`startEmbeddedCluster`). 정지 때 dataDir를 지운다. 먼저 강제로 끝난 프로세스가 남긴 임시 cluster를 치운다. */
export async function ephemeralCluster(): Promise<EmbeddedOptions> {
  await removeTemporaryLeftovers();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  try {
    acquireOwner(dataDir, false);
    return { dataDir, persistent: false };
  } catch (error) {
    await removeTemporary(dataDir);
    throw error;
  }
}

/**
 * 강제로 끝난 프로세스가 남긴 임시 cluster를 멈추고 지운다. 주인 기록(`*.owner/`)이 있는 것만 보며, 그 dataDir의 주인이
 * 되어야 손댄다(주인이 살아 있거나 다른 프로세스가 먼저 치우는 중이면 둔다). 그 Postgres가 그 dataDir를 쓰는지 확인할 수 없으면
 * 둔다. 실패는 알리기만 하고 새 cluster는 그대로 띄운다.
 * tmp는 다른 프로그램도 쓰므로 이름만 믿지 않는다. 주인 기록과 dataDir는 tmp 바로 아래의 실제 폴더여야 하며 링크는 따라가지 않는다.
 */
async function removeTemporaryLeftovers() {
  const tmp = os.tmpdir();
  const entries = await fsp
    .readdir(tmp, { withFileTypes: true })
    .catch(() => [] as fs.Dirent[]);
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(temporaryPrefix) ||
      !entry.name.endsWith(ownerSuffix)
    )
      continue;
    const dataDir = path.join(tmp, entry.name.slice(0, -ownerSuffix.length));
    const folder = fs.lstatSync(dataDir, { throwIfNoEntry: false });
    if (folder && !folder.isDirectory()) continue;
    const { owner } = latest(ownerDir(dataDir));
    // 죽은 임시 주인의 것, 또는 주인 없이(내려놓았거나 읽을 수 없음) 기록만 남고 dataDir가 없는 것만 치운다.
    if (owner ? owner.persistent || isAlive(owner.pid) : folder !== undefined)
      continue;
    let lease: Lease;
    try {
      lease = acquireOwner(dataDir, false);
    } catch {
      continue;
    }
    try {
      const { pg_ctl: pgCtl } = await getBinaries();
      const running = readPidFile(dataDir);
      if (running && (await isRunning(pgCtl, dataDir))) {
        if (!(await servesDataDir(running.port, dataDir))) {
          console.warn(
            `[db] left temporary Postgres in ${dataDir}: could not confirm it serves that folder`
          );
          releaseOwner(dataDir, lease, lease.previous);
          continue;
        }
        await stopCluster(pgCtl, dataDir, leftoverStopSeconds, true);
      }
      await removeTemporary(dataDir);
    } catch (error) {
      console.warn(
        `[db] could not remove temporary Postgres left in ${dataDir}:`,
        error instanceof Error ? error.message : error
      );
      releaseOwner(dataDir, lease, lease.previous);
    }
  }
}
