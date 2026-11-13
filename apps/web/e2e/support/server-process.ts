import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// E2E가 직접 띄우고 멈추는 서버 프로세스. 공용 서버(e2e/global-setup.ts)와 테스트마다의 자기 서버(isolated-server.ts)가 같이 쓴다.
// - 제품 폴더와 임시 폴더(TMP)를 새 임시 폴더 하나 안에 만들어 넘긴다. 임시 내장 Postgres(BABOJUBOT_EPHEMERAL_DB)의 dataDir도
//   그 안에 생겨 서버가 남긴 것만 볼 수 있다.
// - 멈춤: IPC 채널로 띄우고 멈춤 메시지(apps/server/src/stop-request.ts의 `stopRequest`)를 보낸 뒤 종료 코드를 기다린다.
//   Windows에서는 신호로 정리를 맡길 수 없어(Node의 `kill(신호)`는 강제 종료) 모든 OS에서 이 길을 쓴다.
// - 성공은 멈추라고 한 뒤 종료 코드 0으로 끝나고, 서버가 띄운 내장 Postgres가 끝났고 그 dataDir를 서버가 지웠을 때다.
//   그 뒤에 임시 폴더를 지운다. 폴더를 지워 정리를 대신하지 않는다.
// - 멈추라고 하기 전에 서버가 끝났으면 종료 코드가 0이어도 실패다. 시한을 넘기면 강제로 끝내고 실패로 알린다.
//   실패하면 이 서버와, 잠금 파일이 이 서버의 임시 폴더에 남은 모든 Postgres를 끝내고 그들이 끝나기를 기다린 뒤 폴더를 지운다.
//   그래도 살아 있는 프로세스가 있으면 폴더를 남기고 그 경로를 알린다.

/** apps/server/src/stop-request.ts의 `stopRequest`와 같은 모양. 서버 패키지 코드를 화면 시험에 들이지 않으려고 따로 적는다. */
const stopRequest = { type: "babojubot:stop" };
const readyTimeoutMs = 60_000;
/** 서버의 정리 시한. 기다리는 쪽은 그보다 길게 기다려, 서버가 스스로 끝나며 내장 Postgres를 멈출 기회를 준다. */
export const serverShutdownMs = 10_000;
const exitWaitMs = serverShutdownMs + 5_000;
const killWaitMs = 5_000;
/**
 * 서버가 끝난 뒤 내장 Postgres 프로세스가 사라지기까지. pg_ctl의 정지 대기는 postmaster.pid가 지워지면 끝나는데, 그 뒤에도
 * 프로세스는 잠시 남아 있을 수 있다(Windows는 완전히 끝날 때까지 살아 있다고 답한다).
 */
const postgresExitMs = 5_000;

type Exit = { code: number | null; signal: string | null };

export type ServerProcess = {
  /** 시작 줄(`BaboJUBot server on <url> (…)`)의 주소. */
  url: string;
  pid: number;
  /** 서버가 띄운 임시 내장 Postgres의 프로세스 ID. */
  postgresPid: number;
  /** 제품 폴더와 임시 폴더를 담은 폴더. 멈춘 뒤에는 없다. */
  folder: string;
  child: ChildProcess;
  /** 멈추라고 하고 정리를 확인한다. 여러 번 불러도 같은 결과다. */
  stop: () => Promise<void>;
};

/**
 * 부모 셸과 공용 설정의 서버 설정이 이 서버에 새지 않게 지운다. 서버가 읽는 설정은 `BABOJUBOT_*`와 아래 이름이다.
 * Windows는 환경 변수 이름의 대소문자를 가리지 않으므로 대문자로 비교한다.
 */
const serverSettings = [
  "DATABASE_URL",
  "HOST",
  "PORT",
  "EMBEDDED_POSTGRES_PORT",
  "TMPDIR",
  "TEMP",
  "TMP",
];
function inheritedEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("BABOJUBOT_") || serverSettings.includes(upper))
      delete env[name];
  }
  return env;
}

/**
 * `entry`(서버 진입점)를 임시 내장 Postgres로 띄우고 시작 줄을 기다린다. `env`는 위에서 정한 것 말고 더 넘길 서버 설정이다.
 * 시작하지 못하면 띄운 것을 정리하고 던진다.
 */
export async function startServerProcess({
  entry,
  env,
  label,
}: {
  entry: string;
  env: Record<string, string>;
  label: string;
}): Promise<ServerProcess> {
  const folder = mkdtempSync(path.join(os.tmpdir(), "babojubot-e2e-"));
  const home = path.join(folder, "home");
  const temp = path.join(folder, "tmp");
  mkdirSync(home);
  mkdirSync(temp);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...inheritedEnv(),
      HOST: "127.0.0.1",
      PORT: "0",
      DATABASE_URL: "",
      BABOJUBOT_EPHEMERAL_DB: "1",
      BABOJUBOT_HOME: home,
      BABOJUBOT_SHUTDOWN_TIMEOUT_MS: String(serverShutdownMs),
      // Node는 POSIX에서 TMPDIR, Windows에서 TEMP·TMP를 읽는다.
      TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const output = () =>
    `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
  // 종료 관찰은 시작을 기다리기 전에 붙인다. 시작 전에 끝나도 놓치지 않는다.
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  void exited.catch(() => {});
  // 채널 오류(끊긴 채널로 보내기 등)는 멈추기에서 실패로 알린다. 처리하지 않은 `error`로 실행기를 끝내지 않는다.
  child.on("error", () => {});

  let postgresPid = 0;
  /**
   * 실패한 뒤 이 서버가 띄운 프로세스를 강제로 끝내고, 아직 살아 있는 pid를 모아 돌려준다. 이 서버와, 이 서버의 임시 폴더에
   * 잠금 파일을 남긴 모든 Postgres가 대상이다. 끝나기를 기다린 뒤에도 살아 있는 것만 남긴다.
   */
  async function cleanUpAfterFailure() {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await within(
      exited.catch(() => undefined),
      killWaitMs
    );
    const pids = lockedPostgresPids(temp);
    for (const pid of pids) {
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
      await gone(pid, postgresExitMs);
    }
    const left: number[] = [];
    if (child.pid && alive(child.pid)) left.push(child.pid);
    for (const pid of pids) if (alive(pid)) left.push(pid);
    return left;
  }

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      let failure: unknown;
      try {
        await stopChild(child, exited, label, output);
        const left = temporaryPostgresEntries(temp);
        if (postgresPid && !(await gone(postgresPid, postgresExitMs)))
          throw new Error(
            `${label}가 끝났지만 내장 Postgres(pid ${postgresPid})가 남았다: ${output()}`
          );
        if (left.length > 0)
          throw new Error(
            `${label}가 끝났지만 임시 내장 Postgres 폴더가 남았다(${left.join(", ")}): ${output()}`
          );
      } catch (error) {
        const left = await cleanUpAfterFailure();
        if (left.length > 0)
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} — 남은 프로세스(pid ${left.join(", ")})가 있어 폴더를 지우지 않았다: ${folder}`,
            { cause: error }
          );
        failure = error;
      }
      try {
        rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    })());

  try {
    const url = await waitForReadyLine(
      child,
      exited,
      () => stdout,
      label,
      output
    );
    postgresPid = readPostgresPid(temp);
    return { url, pid: child.pid!, postgresPid, folder, child, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/** 완전한 시작 줄(`BaboJUBot server on <url> (…)`)이 나올 때까지 기다려 그 주소를 돌려준다. */
function waitForReadyLine(
  child: ChildProcess,
  exited: Promise<Exit>,
  stdout: () => string,
  label: string,
  output: () => string
) {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      done();
    };
    const onData = () => {
      const match = /^BaboJUBot server on (https?:\/\/\S+) \(.*\)\r?\n/m.exec(
        stdout()
      );
      if (match) finish(() => resolve(match[1]!));
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `${label}가 ${readyTimeoutMs}ms 안에 시작하지 않았다: ${output()}`
            )
          )
        ),
      readyTimeoutMs
    );
    child.stdout!.on("data", onData);
    exited.then(
      ({ code, signal }) =>
        finish(() =>
          reject(
            new Error(
              `${label}가 시작 전에 끝났다(code ${code}, signal ${signal}): ${output()}`
            )
          )
        ),
      (error: unknown) => finish(() => reject(error))
    );
    onData();
  });
}

/**
 * 멈춤 메시지로 정리를 맡기고 시한 안에 끝나기를 기다린다. 시한은 요청을 보내는 일부터 덮는다. 넘기면 강제로 끝내고 실패로 알린다.
 */
async function stopChild(
  child: ChildProcess,
  exited: Promise<Exit>,
  label: string,
  output: () => string
) {
  // 서버는 멈추라고 할 때까지 살아 있어야 한다. 그 전에 끝났으면 종료 코드가 0이어도 이상이다.
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(
      `${label}가 멈추라고 하기 전에 끝났다(code ${child.exitCode}, signal ${child.signalCode}): ${output()}`
    );
  // 보내기가 성공하면 이 약속은 끝나지 않는다. 서버가 채널을 읽지 않으면 보내기 콜백도 오지 않으므로, 시한이 보내기와 종료를 함께 덮는다.
  const sendFailed = new Promise<Error>((resolve) =>
    child.send(stopRequest, (error) => {
      if (error) resolve(error);
    })
  );
  const outcome = await within(
    Promise.race<{ exit: Exit } | { error: Error }>([
      exited.then((exit) => ({ exit })),
      sendFailed.then((error) => ({ error })),
    ]),
    exitWaitMs
  );
  if (outcome && "error" in outcome) {
    // 확인과 보내기 사이에 서버가 끝나고 있었으면 채널이 닫혀 보내기가 실패한다. 그때도 멈추라고 하기 전에 끝난 것이다.
    const early = await within(exited, killWaitMs);
    if (early)
      throw new Error(
        `${label}가 멈추라고 하기 전에 끝났다(code ${early.code}, signal ${early.signal}): ${output()}`
      );
    throw new Error(
      `${label}에 멈춤 요청을 보내지 못했다: ${outcome.error.message}: ${output()}`
    );
  }
  if (outcome) {
    if (outcome.exit.code !== 0)
      throw new Error(
        `${label}가 정리에 실패했다(code ${outcome.exit.code}, signal ${outcome.exit.signal}): ${output()}`
      );
    return;
  }
  child.kill("SIGKILL");
  await within(exited, killWaitMs);
  throw new Error(
    `${label}가 멈춤 요청 뒤 ${exitWaitMs}ms 안에 끝나지 않아 강제로 끝냈다: ${output()}`
  );
}

/** 임시 내장 Postgres가 임시 폴더에 남기는 항목(dataDir와 그 주인 기록 `.owner`). */
function temporaryPostgresEntries(temp: string) {
  return readdirSync(temp).filter((name) => name.startsWith("babojubot-pg-"));
}

/**
 * 이 서버의 임시 폴더에 잠금 파일(postmaster.pid)이 남은 Postgres 프로세스 ID들. Postgres는 정상 정지할 때 postmaster.pid를
 * 지우므로, 잠금 파일이 이 서버의 임시 폴더에 남아 있으면 그 Postgres는 이 서버가 띄운 것이다. 이미 정상 정지한 Postgres는
 * pid가 다시 쓰였어도 대상이 되지 않는다.
 */
function lockedPostgresPids(temp: string) {
  const pids: number[] = [];
  for (const entry of temporaryPostgresEntries(temp)) {
    if (entry.endsWith(".owner")) continue;
    let pid: number;
    try {
      pid = Number(
        readFileSync(path.join(temp, entry, "postmaster.pid"), "utf8").split(
          /\r?\n/
        )[0]
      );
    } catch {
      /* 잠금 파일이 없거나 읽을 수 없다: 정상 정지했거나 아직 쓰지 않았다. */
      continue;
    }
    if (pid > 0) pids.push(pid);
  }
  return pids;
}

/** 준비된 서버가 띄운 임시 내장 Postgres의 프로세스 ID(임시 폴더의 잠금 파일). */
function readPostgresPid(temp: string) {
  const dirs = temporaryPostgresEntries(temp).filter(
    (name) => !name.endsWith(".owner")
  );
  if (dirs.length !== 1)
    throw new Error(
      `임시 내장 Postgres 폴더가 하나가 아니다: ${dirs.join(", ")}`
    );
  const pids = lockedPostgresPids(temp);
  const pid = pids[0];
  if (pids.length !== 1 || pid === undefined)
    throw new Error(`내장 Postgres의 pid를 읽지 못했다: ${pid}`);
  return pid;
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 프로세스가 `ms` 안에 사라지면 true. 사라지기를 짧은 간격으로 확인한다. */
async function gone(pid: number, ms: number) {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function within<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
