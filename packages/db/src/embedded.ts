import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres, { getBinaries } from "embedded-postgres";
import pg from "pg";

/** 이 프로세스가 띄우고 멈추는 embedded Postgres. `persistent: false`면 정지 때 dataDir를 지운다. */
export type EmbeddedOptions = {
  dataDir: string;
  port: number;
  persistent: boolean;
};

/** embedded cluster의 DB 하나에 연결할 주소. */
export const clusterUrl = (port: number, database: string) =>
  `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;

// Postgres는 모든 OS에서 묶여 온 pg_ctl로 켜고 끈다(docs/research/embedded-postgres-lifecycle-references.md).
// - 켜기: pg_ctl은 POSIX에서 Postgres를 새 session으로 띄우고, Windows에서는 관리자 권한을 내려놓고 숨은 콘솔에서 띄운다.
//   그래서 터미널의 Ctrl+C·창 닫기가 Postgres에 바로 가지 않고, Windows 관리자 계정에서도 켜진다. Windows에서 pg_ctl에 출력
//   통로를 주면 Postgres가 그 통로를 물려받아 닫히지 않으므로 출력은 버리고 끝남 코드만 본다. 실패 이유는 Postgres 로그에서 읽는다.
// - 끄기: 정상 정지(fast)를 요청하고 끝날 때까지 기다린다. Windows도 Postgres 자체 신호로 정상 정지한다.
// - 주인: dataDir 하나는 한 프로세스만 쓴다. 주인 기록(`<dataDir>.owner.json`)을 한 번에 하나만 만들 수 있게 만들어 그 권리로 삼고,
//   만들기·남은 Postgres 정리·켜기·끄기·지우기는 그 기록을 가진 프로세스만 한다.
// - 다음 시작: 강제로 끝난 프로세스가 남긴 Postgres는 기록된 주인이 죽었고 그 서버가 이 dataDir를 쓰는 것이 접속으로 확인될
//   때만 멈춘다. 잠금 파일(postmaster.pid)만으로는 무관한 프로세스와 구별할 수 없다.
const startSeconds = 60;
// 정상 종료 때의 정지 시한. 서버 정리 시한(main.ts)이 먼저 지나면 프로세스 종료 때 즉시 정지가 따른다.
const stopSeconds = 30;
// 다음 시작 때 남은 Postgres를 멈추는 시한.
const leftoverStopSeconds = 10;
/** 프로세스 종료 때 즉시 정지에 쓰는 최대 시간. 서버는 정리 시한에서 이만큼 남기고 끝낸다(main.ts). */
export const emergencyStopMs = 1_500;
const temporaryPrefix = "babojubot-pg-";
const ownerSuffix = ".owner.json";
const logName = "postgres.log";

/** 이 dataDir를 쓰는 프로세스. */
type Owner = { pid: number; persistent: boolean };

/**
 * embedded cluster를 띄우고 멈추는 함수를 돌려준다. `stop`이 돌아오면 postgres는 끝났다.
 * `settings`는 postgres 설정(`이름=값`)이다.
 */
export async function startEmbeddedCluster(
  { dataDir, port, persistent }: EmbeddedOptions,
  settings: string[] = []
): Promise<() => Promise<void>> {
  // 설정은 pg_ctl을 거쳐 shell 명령줄에 들어가므로 따옴표가 필요 없는 값만 받는다.
  for (const setting of settings)
    if (!/^[A-Za-z_][A-Za-z0-9_.]*=[A-Za-z0-9_.:/-]+$/.test(setting))
      throw new Error(`unsupported Postgres setting "${setting}"`);
  const { pg_ctl: pgCtl } = await getBinaries();
  const { previous } = acquireOwner(dataDir, persistent);
  try {
    if (!fs.existsSync(path.join(dataDir, "PG_VERSION")))
      await initialise(dataDir);
    await stopLeftover(pgCtl, dataDir, persistent, previous);
  } catch (error) {
    if (!persistent && !readPidFile(dataDir))
      await fsp.rm(dataDir, { recursive: true, force: true });
    restoreOwner(dataDir, previous);
    throw error;
  }

  // 프로그램이 `stop`을 마치지 못하고 끝나면(process.exit, 처리되지 않은 오류, 정리 시한 초과) postgres가 이 프로세스보다 오래
  // 살아 남는다. 그 뒤로는 postgres를 챙길 쪽이 없으므로 무엇도 기다리지 않는 즉시 정지를 보낸다(다음 시작이 복구).
  // `exit`에서는 동기 작업만 할 수 있다. 신호는 이 프로세스가 켠 postgres에만 보낸다: 켤 때 기억한 pid를 잠금 파일이 아직 가리킬
  // 때만이다. 켜는 중에 끝나면 보내지 않는다. 그 postgres는 이 프로세스를 주인으로 기록하고 있어 다음 시작이 멈춘다.
  let started: number | undefined;
  const stopOnExit = () => {
    if (started && readPidFile(dataDir)?.pid === started)
      stopNow(pgCtl, started);
  };
  // 비상 정지는 정지가 끝난 뒤에야 내려놓는다.
  const stop = async () => {
    await stopCluster(pgCtl, dataDir, stopSeconds, !persistent);
    process.off("exit", stopOnExit);
    if (!persistent) await fsp.rm(dataDir, { recursive: true, force: true });
    releaseOwner(dataDir);
  };
  process.on("exit", stopOnExit);
  const log = path.join(dataDir, logName);
  try {
    await fsp.rm(log, { force: true }).catch(() => {});
    const options = [
      "-p",
      String(port),
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
    if (code !== 0)
      throw new Error(
        `embedded Postgres exited before it was ready: ${await logTail(log)}`
      );
    started = readPidFile(dataDir)?.pid;
    return stop;
  } catch (error) {
    // 이 dataDir를 가진 것은 이 프로세스뿐이므로 여기서 도는 postgres는 이번에 켜다 만 것이다.
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
 * 기다리지 않는 즉시 정지. 프로세스 종료 때 동기로 부르며 `emergencyStopMs` 안에 끝난다.
 * Windows의 pg_ctl kill은 그 pid의 Postgres만 여는 신호 통로로 보내므로 Postgres가 아닌 프로세스에는 닿지 않는다.
 * 닿지 않으면 강제 종료하지 않고 다음 시작에 맡긴다.
 */
function stopNow(pgCtl: string, pid: number) {
  spawnSync(pgCtl, ["kill", "QUIT", String(pid)], {
    stdio: "ignore",
    timeout: emergencyStopMs,
    windowsHide: true,
  });
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

const ownerFile = (dataDir: string) => `${path.resolve(dataDir)}${ownerSuffix}`;

/**
 * 이 dataDir를 쓸 권리를 얻는다. 주인 기록은 내용을 다 쓴 임시 파일을 hard link로 붙여 만든다. 이미 있으면 실패하므로
 * 두 프로세스가 동시에 얻지 못하고, 읽는 쪽이 반쯤 쓴 기록을 보지 않는다. 기록된 주인이 살아 있으면 실패한다.
 * 죽은 주인의 기록은 자기 이름으로 옮겨(rename은 한 프로세스만 성공) 치운다. 옮긴 기록이 그새 살아 있는 주인이 만든
 * 것이면 되돌린다. 돌려주는 `previous`는 치운 죽은 주인이다(남은 Postgres를 멈춰도 되는지 판단할 때 쓴다).
 * 세 프로세스 이상이 같은 순간에 같은 기록을 다투는 경우는 다루지 않는다.
 */
function acquireOwner(
  dataDir: string,
  persistent: boolean
): { previous: Owner | undefined } {
  const file = ownerFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = `${file}.${process.pid}.new`;
  const owner: Owner = { pid: process.pid, persistent };
  fs.writeFileSync(mine, JSON.stringify(owner));
  let previous: Owner | undefined;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.linkSync(mine, file);
        return { previous };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const current = readOwnerFile(file);
      if (current && isAlive(current.pid)) {
        // 임시 cluster는 ephemeralCluster가 만들 때 이 프로세스 이름으로 이미 기록했다.
        if (current.pid === process.pid && !current.persistent && !persistent)
          return { previous };
        throw new Error(
          `embedded Postgres in ${dataDir} is in use by a running process (pid ${current.pid}). Stop that process first. If no BaboJUBot process uses it, delete ${file}.`
        );
      }
      const stale = `${file}.${process.pid}.stale`;
      try {
        fs.renameSync(file, stale);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = readOwnerFile(stale);
      if (moved && isAlive(moved.pid)) {
        // 그새 다른 프로세스가 얻은 기록을 옮겼다. 되돌리고 다시 본다.
        try {
          fs.linkSync(stale, file);
        } catch {
          /* 그새 또 다른 기록이 생겼다. 다음 반복이 그 기록을 본다. */
        }
      } else if (moved) previous = moved;
      fs.rmSync(stale, { force: true });
    }
    throw new Error(`could not take ownership of ${dataDir}`);
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

/** 이 프로세스의 주인 기록을 지운다. 다른 프로세스의 기록이면 둔다. */
function releaseOwner(dataDir: string) {
  const file = ownerFile(dataDir);
  if (readOwnerFile(file)?.pid === process.pid)
    fs.rmSync(file, { force: true });
}

/** 시작하지 못했을 때, 치운 죽은 주인의 기록을 되돌린다. 다음 시작이 같은 판단을 다시 할 수 있게 한다. */
function restoreOwner(dataDir: string, previous: Owner | undefined) {
  const file = ownerFile(dataDir);
  if (readOwnerFile(file)?.pid !== process.pid) return;
  if (previous) fs.writeFileSync(file, JSON.stringify(previous));
  else fs.rmSync(file, { force: true });
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

/** 임시 dataDir와 빈 port. 정지 때 dataDir를 지우며, port를 못 구하면 바로 지운다. 먼저 강제로 끝난 프로세스가 남긴 임시 cluster를 치운다. */
export async function ephemeralCluster(): Promise<EmbeddedOptions> {
  await removeTemporaryLeftovers();
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  try {
    acquireOwner(dataDir, false);
    return { dataDir, port: await freePort(), persistent: false };
  } catch (error) {
    await fsp.rm(dataDir, { recursive: true, force: true });
    releaseOwner(dataDir);
    throw error;
  }
}

/**
 * 강제로 끝난 프로세스가 남긴 임시 cluster를 멈추고 지운다. 주인 기록(`*.owner.json`)이 있는 것만 보며, 그 dataDir의 주인이
 * 되어야 손댄다(주인이 살아 있거나 다른 프로세스가 먼저 치우는 중이면 둔다). 그 Postgres가 그 dataDir를 쓰는지 확인할 수 없으면
 * 둔다. 실패는 알리기만 하고 새 cluster는 그대로 띄운다.
 */
async function removeTemporaryLeftovers() {
  const tmp = os.tmpdir();
  const names = await fsp.readdir(tmp).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(temporaryPrefix) || !name.endsWith(ownerSuffix))
      continue;
    const dataDir = path.join(tmp, name.slice(0, -ownerSuffix.length));
    const recorded = readOwnerFile(ownerFile(dataDir));
    if (!recorded || recorded.persistent || isAlive(recorded.pid)) continue;
    let previous: Owner | undefined;
    try {
      ({ previous } = acquireOwner(dataDir, false));
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
          restoreOwner(dataDir, previous);
          continue;
        }
        await stopCluster(pgCtl, dataDir, leftoverStopSeconds, true);
      }
      await fsp.rm(dataDir, { recursive: true, force: true });
      releaseOwner(dataDir);
    } catch (error) {
      console.warn(
        `[db] could not remove temporary Postgres left in ${dataDir}:`,
        error instanceof Error ? error.message : error
      );
      restoreOwner(dataDir, previous);
    }
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
