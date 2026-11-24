import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { removeFolder } from "@babojubot/process/remove-folder";
import {
  awaitedLater,
  killUnlessGone,
  processAlive,
} from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";
import { attemptAll, attemptEach, combinedFailure } from "@babojubot/contracts";

// E2E가 직접 띄우고 멈추는 서버 프로세스. 공용 서버(e2e/global-setup.ts)와 테스트마다의 자기 서버(isolated-server.ts)가 같이 쓴다.
// - 제품 폴더와 임시 폴더(TMP)를 새 임시 폴더 하나 안에 만들어 넘긴다. 임시 내장 Postgres(BABOJUBOT_EPHEMERAL_DB)의 dataDir도
//   그 안에 생겨 서버가 남긴 것만 볼 수 있다.
// - 멈춤: IPC 채널로 띄우고 멈춤 메시지(apps/server/src/stop-request.ts의 `stopRequest`)를 보낸 뒤 종료 코드를 기다린다.
//   Windows에서는 신호로 정리를 맡길 수 없어(Node의 `kill(신호)`는 강제 종료) 모든 OS에서 이 길을 쓴다.
// - 성공은 멈추라고 한 뒤 종료 코드 0으로 끝나고, 서버가 띄운 내장 Postgres가 끝났고 그 dataDir를 서버가 지웠을 때다.
//   그 뒤에 임시 폴더를 지운다. 폴더를 지워 정리를 대신하지 않는다.
// - 멈추라고 하기 전에 서버가 끝났으면 종료 코드가 0이어도 실패다. 시한을 넘기면 강제로 끝내고 실패로 알린다.
//   실패하면 이 서버와, 잠금 파일이 이 서버의 임시 폴더에 남은 모든 Postgres를 끝내고, 준비 때 읽은 Postgres를 포함해
//   그들이 끝나기를 기다린 뒤 폴더를 지운다. 잠금 파일이 없는 Postgres는 이 서버의 것인지 확인할 수 없어 끝내지 않는다.
//   남은 프로세스를 확인하지 못했거나 그래도 살아 있는 프로세스가 있으면 폴더를 남기고 그 경로를 알린다.
//   실패가 여럿이면 모두 모아 알린다.

/** apps/server/src/stop-request.ts의 `stopRequest`와 같은 모양. 서버 패키지 코드를 화면 시험에 들이지 않으려고 따로 적는다. */
const stopRequest = { type: "babojubot:stop" };
const readyTimeoutMs = 60_000;
/** 서버가 끝난 뒤 그 출력이 끝나기를 기다리는 상한(시작 줄이 늦게 닿을 수 있다). */
const readyOutputEndMs = 10_000;
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
  // 종료 관찰은 시작을 기다리기 전에 붙인다. 시작 전에 끝나도 놓치지 않는다. 시작 대기·멈추기·실패 정리가 늘 기다린다.
  const exited = awaitedLater(
    new Promise<Exit>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    })
  );
  // 채널 오류(끊긴 채널로 보내기 등)는 멈추기에서 실패로 알린다. 처리하지 않은 `error`로 실행기를 끝내지 않는다.
  child.on("error", () => {});

  let postgresPid = 0;

  /** 폴더를 지운다. 지우지 못하면 어느 폴더인지 담아 던진다. 실패는 부른 쪽이 `attemptEach`·`attemptAll`로 모은다. */
  async function removeTemp() {
    try {
      await removeFolder(folder);
    } catch (error) {
      throw new Error(`${label}의 폴더를 지우지 못했다: ${folder}`, {
        cause: error,
      });
    }
  }

  /**
   * 실패한 뒤 정리한다. 이 서버와, 이 서버의 임시 폴더에 잠금 파일을 남긴 모든 Postgres를 강제로 끝내고, 준비 때 읽은
   * Postgres까지 끝나기를 기다린다. 잠금 파일이 없는 pid는 이 서버의 Postgres인지 확인할 수 없어 끝내지 않고 기다리기만 한다.
   * 남은 프로세스가 있거나 남은 프로세스를 확인하지 못했으면 폴더를 남기고 그 사실을 `failures`에 더한다. 폴더를 지웠든
   * 남겼든 모은 실패를 모두 알린다. 각 단계는 `attempt`로 감싸 한 단계가 실패해도 다음 단계를 한다.
   */
  async function release(failures: unknown[]): Promise<never> {
    // `undefined`는 폴더가 없거나 읽을 수 없어 남은 Postgres를 확인하지 못했다는 뜻이다.
    let locked: number[] | undefined;
    failures.push(
      ...(await attemptEach([
        async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          // 끝나기를 시한 안에 확인하지 못하면 그 이유로 실패를 남긴다(아래 남은 프로세스 확인과 별도로).
          await within(
            exited.catch(() => undefined),
            killWaitMs,
            `${label} did not end after SIGKILL`
          );
        },
        async () => {
          locked = await lockedPostgresPids(temp);
        },
      ]))
    );
    // 이미 끝난 것(ESRCH)은 넘어가고, 보내지 못한 것은 실패로 남긴다.
    failures.push(
      ...(await attemptEach(
        (locked ?? []).map((pid) => () => {
          killUnlessGone(pid);
        })
      ))
    );
    // 준비 때 읽은 pid는 잠금 파일이 지워져도 이 서버의 Postgres다. 끝내지는 않고, 폴더를 지우기 전에 끝나기를 기다린다.
    // 대상마다 따로 기다려, 한 대상의 조회가 실패해도 나머지가 끝나기를 기다린다.
    const watched = [
      ...new Set([...(locked ?? []), ...(postgresPid ? [postgresPid] : [])]),
    ];
    failures.push(
      ...(await attemptEach(
        watched.map((pid) => () => gone(pid, postgresExitMs))
      ))
    );
    // 대상마다 따로 조회한다. 조회하지 못한 대상(권한·I/O 오류)은 끝났다고 보지 않고 `left`를 `undefined`로 둔다.
    let left: number[] | undefined = [];
    failures.push(
      ...(await attemptEach(
        [child.pid, ...watched].flatMap((pid) =>
          pid
            ? [
                async () => {
                  let running: boolean;
                  try {
                    running = await alive(pid);
                  } catch (error) {
                    left = undefined;
                    throw error;
                  }
                  if (running) left?.push(pid);
                },
              ]
            : []
        )
      ))
    );
    if (locked === undefined)
      failures.push(
        new Error(
          `남은 Postgres를 확인하지 못해 ${label}의 폴더를 지우지 않았다: ${folder}`
        )
      );
    else if (left === undefined)
      failures.push(
        new Error(
          `남은 프로세스를 확인하지 못해 ${label}의 폴더를 지우지 않았다: ${folder}`
        )
      );
    else if (left.length > 0)
      failures.push(
        new Error(
          `남은 프로세스(pid ${left.join(", ")})가 있어 ${label}의 폴더를 지우지 않았다: ${folder}`
        )
      );
    else failures.push(...(await attemptEach([removeTemp])));
    throw combinedFailure(failures, `${label} could not be cleaned up`);
  }

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
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
        return release([error]);
      }
      await attemptAll([removeTemp], `${label} could not be cleaned up`);
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
    // 시작하지 못한 서버에는 정상 정리를 맡기지 않고(stop()의 "멈추라고 하기 전에 끝났다"를 겹쳐 알리지도 않는다) 실패 정리로 끝낸다.
    // `release`는 언제나 던진다. 시작 실패를 먼저 두고 정리 실패를 함께 알린다.
    stopping ??= release([error]);
    throw await stopping;
  }
}

/** 시작 줄 기다리기가 자식에게서 쓰는 것만. */
export type ReadyChild = { readonly stdout: Readable | null };

/**
 * 완전한 시작 줄(`BaboJUBot server on <url> (…)`)이 나올 때까지 기다려 그 주소를 돌려준다. 서버가 끝난(`exit`) 뒤에도 출력이 끝나기
 * (`end`) 전까지는 줄이 닿을 수 있어 계속 읽는다(CODING_STANDARDS.md, #288의 readyLine과 같은 기준). 출력이 줄 없이 끝나야 시작 전에
 * 끝난 것이다. 출력을 물려받은 자손이 출력을 쥐고 있으면 끝이 오지 않으므로, exit 뒤 출력의 끝은 `outputEndMs` 안에서 확인하고 넘기면
 * 끝을 확인하지 못했다고 실패한다(끝났다고 보지 않는다). 전체 시한(`readyTimeoutMs`)은 따로 둔다.
 */
export function waitForReadyLine(
  child: ReadyChild,
  exited: Promise<Exit>,
  stdout: () => string,
  label: string,
  output: () => string,
  {
    readyTimeoutMs: readyMs = readyTimeoutMs,
    outputEndMs = readyOutputEndMs,
  }: { readyTimeoutMs?: number; outputEndMs?: number } = {}
) {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let exit: Exit | undefined;
    let outputEnded = false;
    let outputEnd: ReturnType<typeof setTimeout> | undefined;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(outputEnd);
      child.stdout!.off("data", onData);
      child.stdout!.off("end", onEnd);
      done();
    };
    const onData = () => {
      const match = /^BaboJUBot server on (https?:\/\/\S+) \(.*\)\r?\n/m.exec(
        stdout()
      );
      if (match) finish(() => resolve(match[1]!));
    };
    /** 끝났고 출력도 줄 없이 끝났다. */
    const endedBeforeStart = (ended: Exit) =>
      finish(() =>
        reject(
          new Error(
            `${label}가 시작 전에 끝났다(code ${ended.code}, signal ${ended.signal}): ${output()}`
          )
        )
      );
    const onEnd = () => {
      outputEnded = true;
      // 출력이 끝보다 먼저 끝나면 끝(종료 코드)을 기다려 함께 알린다.
      if (exit) endedBeforeStart(exit);
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `${label}가 ${readyMs}ms 안에 시작하지 않았다: ${output()}`
            )
          )
        ),
      readyMs
    );
    child.stdout!.on("data", onData);
    child.stdout!.once("end", onEnd);
    // Promise 구독은 풀 수 없어(리스너와 달리 off가 없다) 대기가 끝난 뒤에도 불린다. 끝난 대기는 아무 자원도 새로 잡지 않는다.
    exited.then(
      (ended) => {
        if (settled) return;
        exit = ended;
        if (outputEnded) return endedBeforeStart(ended);
        outputEnd = setTimeout(
          () =>
            finish(() =>
              reject(
                new Error(
                  `${label}가 시작 줄 없이 끝났고(code ${ended.code}, signal ${ended.signal}) 출력이 ${outputEndMs}ms 안에 끝나지 않아 끝을 확인하지 못했다(출력을 물려받은 자손이 쥐고 있을 수 있다): ${output()}`
                )
              )
            ),
          outputEndMs
        );
      },
      (error: unknown) => finish(() => reject(error))
    );
    onData();
  });
}

/**
 * 멈춤 메시지로 정리를 맡기고 시한 안에 끝나기를 기다린다. 시한은 요청을 보내는 일부터 덮는다. 넘기면 강제로 끝내고 실패로 알린다.
 */
/** 멈추기가 자식에게서 쓰는 것만. */
export type StoppableChild = {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  send(message: unknown, callback: (error: Error | null) => void): boolean;
  kill(signal: NodeJS.Signals): boolean;
};

export async function stopChild(
  child: StoppableChild,
  exited: Promise<Exit>,
  label: string,
  output: () => string,
  limits: { exitWaitMs: number; killWaitMs: number } = {
    exitWaitMs,
    killWaitMs,
  }
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
  // 시한은 거절로 끝난다(공용 within). 시한을 이행으로 접으면 그 뒤 종료 관찰의 거절이 아무 데도 닿지 않는다(#286 항목 21).
  let stopped: "exited" | Error;
  try {
    stopped = await within(
      Promise.race([exited.then(() => "exited" as const), sendFailed]),
      limits.exitWaitMs,
      `${label} did not end after the stop request`
    );
  } catch (error) {
    // 시한 안에 끝나지 않았다. 그 실패를 먼저 만들어 두고, 강제로 끝내기와 그 끝 확인을 모두 시도한다. 끝 확인이 실패해도 첫 실패를
    // 잃지 않고 함께 알린다(CODING_STANDARDS.md#제품-코드, 독립 단계의 실패를 모아 던지기).
    const unstopped = new Error(
      `${label}가 멈춤 요청 뒤 ${limits.exitWaitMs}ms 안에 끝나지 않아 강제로 끝냈다: ${output()}`,
      { cause: error }
    );
    const failures = await attemptEach([
      () => child.kill("SIGKILL"),
      () =>
        within(exited, limits.killWaitMs, `${label} did not end after SIGKILL`),
    ]);
    throw combinedFailure(
      [unstopped, ...failures],
      `${label} could not be stopped`
    );
  }
  if (stopped instanceof Error) {
    // 확인과 보내기 사이에 서버가 끝나고 있었으면 채널이 닫혀 보내기가 실패한다. 그때도 멈추라고 하기 전에 끝난 것이다.
    let early: Exit;
    try {
      early = await within(
        exited,
        limits.killWaitMs,
        `${label} did not end after the stop request could not be sent`
      );
    } catch (error) {
      throw new Error(
        `${label}에 멈춤 요청을 보내지 못했다: ${stopped.message}: ${output()}`,
        { cause: error }
      );
    }
    throw new Error(
      `${label}가 멈추라고 하기 전에 끝났다(code ${early.code}, signal ${early.signal}): ${output()}`
    );
  }
  // 종료가 먼저 왔다. 이미 정해진 그 결과를 읽는다.
  const exit = await exited;
  if (exit.code !== 0)
    throw new Error(
      `${label}가 정리에 실패했다(code ${exit.code}, signal ${exit.signal}): ${output()}`
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
    const file = path.join(temp, entry, "postmaster.pid");
    let pid: number;
    try {
      pid = Number(readFileSync(file, "utf8").split(/\r?\n/)[0]);
    } catch (error) {
      // 잠금 파일이 없다: 정상 정지했거나 아직 쓰지 않았다. 읽지 못한 것은 남은 Postgres를 모르는 것이라 알린다.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw new Error(`잠금 파일을 읽지 못했다(${code}): ${file}`, {
        cause: error,
      });
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

/** 프로세스가 아직 있는가. "프로세스 없음"만 끝난 것으로 보고, 다른 조회 실패는 pid·원인과 함께 던진다. */
export const alive = processAlive;

/**
 * 프로세스가 `ms` 안에 사라지면 true, 아니면 false. 이 서버가 띄우지 않은 Postgres 후손은 종료를 알릴 수단이 없어 상태를 다시 확인한다.
 * 첫 확인은 바로 하고, 아직 살아 있을 때만 50ms 뒤 다시 확인한다. 어느 pid가 남았는지는 부른 쪽이 알린다. 조회가 실패하면 그 원인으로 거절한다.
 * Playwright 전역 준비·정리에서도 돌아 `expect.poll` 대신 상한을 직접 둔다.
 */
export function gone(pid: number, ms: number) {
  const deadline = Date.now() + ms;
  return new Promise<boolean>((resolve, reject) => {
    const check = () => {
      try {
        if (!alive(pid)) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(check, 50);
      } catch (error) {
        // 조회가 실패하면 끝났는지 모른다. 그 원인으로 실패한다.
        reject(error);
      }
    };
    check();
  });
}
