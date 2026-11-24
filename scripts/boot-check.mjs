// 이 시스템에서 기본 설정의 서버가 실제로 뜨는지 본다. 내장 DB 시작·migration·DB를 읽는 API 하나까지 확인한다.
// 서버가 정리 없이 끝나 내장 DB가 남으면 다음 시작이 그 DB를 정상 정지하고 다시 뜨는지, 닫을 때 정상 정지하는지도 본다.
// CI의 macOS·Windows 작업이 부른다. 상속 환경과 상관없이 임시 폴더·빈 port만 쓰고, 끝나면 DB가 실제로 멈춘 것을 기다린 뒤 폴더를 지운다.
// 멈춤(자기 시한·SIGTERM·SIGINT)은 진행 중인 단계를 끊지 않고 다음 단계 경계에서 받아 한 곳의 정리로 끝낸다(boot-check-flow.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchTree, prepareSupervisor } from "@babojubot/process";
import { processAlive } from "@babojubot/process/test-cleanup";
import {
  attemptAll,
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
} from "@babojubot/contracts";
import { runTimeoutMs, stopGraceMs } from "./boot-check-limits.mjs";
import { createStop, runBootCheckFlow } from "./boot-check-flow.mjs";
import { overviewFields } from "./boot-check-overview.ts";

// main.ts가 서버를 띄운 뒤 내는 완전한 한 줄. 내장 DB로 띄운 서버만 받는다.
// 예: `BaboJUBot server on http://127.0.0.1:PORT (embedded Postgres …, product folder …)`
const readyLinePattern =
  /^BaboJUBot server on (https?:\/\/[^\s)]+) \(embedded Postgres [^\r\n]*\)\r?\n/m;
const fetchTimeoutMs = 2_000;
const cleanupTimeoutMs = 15_000;
const stopWaitMs = 10_000;

const httpPort = readPort("BOOT_CHECK_PORT");
const dbPort = readPort("BOOT_CHECK_DB_PORT");
// 시험이 실행 시한을 줄일 때 쓴다(scripts/boot-check.test.mjs). 없으면 boot-check-limits.mjs의 값이다.
const runDeadlineMs = readTimeout("BOOT_CHECK_TIMEOUT_MS") ?? runTimeoutMs;
const home = mkdtempSync(path.join(tmpdir(), "babojubot-boot-"));
const dataDir = path.join(home, "postgres");
const pidFile = path.join(dataDir, "postmaster.pid");
const log = path.join(dataDir, "postgres.log");
console.log(`boot check folder: ${home}`);

/**
 * 부모 환경의 실제 서비스 설정이 이 검사를 바꾸지 않게 서버 환경을 따로 만든다.
 * 서버가 읽는 `BABOJUBOT_*` 설정과 DATABASE_URL·HOST·PORT·EMBEDDED_POSTGRES_PORT는 이름을 나열하지 않고 규칙으로 지우므로,
 * 서버에 설정이 늘어도 부모 환경이 새지 않는다. 알려진 값만 아래에서 넣는다.
 */
function serverEnv() {
  const env = { ...process.env };
  // Windows는 환경 변수 이름의 대소문자를 가리지 않으므로 대문자로 바꿔 비교한다.
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (
      upper.startsWith("BABOJUBOT_") ||
      ["DATABASE_URL", "HOST", "PORT", "EMBEDDED_POSTGRES_PORT"].includes(upper)
    )
      delete env[name];
  }
  return {
    ...env,
    BABOJUBOT_HOME: home,
    HOST: "127.0.0.1",
    PORT: String(httpPort),
    EMBEDDED_POSTGRES_PORT: String(dbPort),
    BABOJUBOT_PROVIDERS: "",
    BABOJUBOT_FAKE_PROVIDERS: "1",
    BABOJUBOT_FAKE_PROVIDER_SETTINGS: "{}",
  };
}

/**
 * 서버를 띄워 그 서버가 알린 URL의 API가 답하면 서버 프로세스만 강제로 끝낸다(IDE 강제 정지·OOM과 같은 상황). 내장 DB는 따로 남는다.
 * 서버는 공용 실행으로 띄워, 남은 것은 마지막 정리가 그 트리째 끄고 확인한다.
 */
async function serveAndKill(label) {
  // 감독 실행기 없이는 띄우지 않는다(남긴 서버를 끌 수 없다). 준비하지 못하면 launchTree가 그 이유로 거절한다.
  await prepareSupervisor();
  const server = launchTree({
    command: [process.execPath],
    args: ["apps/server/src/main.ts"],
    cwd: process.cwd(),
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(server);
  let stdoutTail = "";
  let stderrTail = "";
  let pendingLine = "";
  let readyUrl;
  let exitInfo;
  let hasExited = false;
  let spawnError;
  // 시작 실패면 끝(exited)도 함께 온다. 기다림은 두 표시를 본다.
  void server.started.then((started) => {
    if (started.kind === "failed") spawnError = new Error(started.reason);
  });
  void server.exited.then((exit) => {
    hasExited = true;
    exitInfo = exit;
  });

  server.stdout?.setEncoding("utf8");
  server.stderr?.setEncoding("utf8");
  server.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    stdoutTail = (stdoutTail + text).slice(-4000);
    if (readyUrl) return;
    pendingLine += text;
    const match = readyLinePattern.exec(pendingLine);
    if (match) {
      readyUrl = match[1];
      return;
    }
    // 아직 완성되지 않은 줄만 남긴다. 완성된 줄은 준비 줄 판정에 이미 쓰였다.
    const lastNewline = pendingLine.lastIndexOf("\n");
    if (lastNewline !== -1) pendingLine = pendingLine.slice(lastNewline + 1);
    if (pendingLine.length > 4000) pendingLine = pendingLine.slice(-4000);
  });
  server.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4000);
  });

  // 준비를 기다리고, 그 성패와 상관없이 서버를 강제로 끝내고 그 끝을 확인한다. 둘 다 실패하면 둘 다 알린다.
  await attemptAll(
    [
      async () => {
        while (!readyUrl) {
          if (spawnError)
            throw new Error(
              `${label}: could not start the server: ${spawnError.message}${outputTail(stdoutTail, stderrTail)}`
            );
          if (hasExited)
            throw new Error(
              `${label}: server exited before it was ready (code ${exitInfo?.code}, signal ${exitInfo?.signal})${outputTail(stdoutTail, stderrTail)}`
            );
          await delay(50);
        }

        // 마지막 시도가 왜 답을 받지 못했는지. 시한에 닿아 멈출 때 원인으로 함께 알린다.
        let lastAttempt = "no attempt yet";
        for (;;) {
          // 멈춤 문구는 다른 단계와 같은 "단계: 이유"로 시작하고, 마지막 시도가 답을 받지 못한 원인을 뒤에 붙인다.
          if (stop.reason)
            throw new Error(
              `${label}: ${stop.reason} (last /api/overview attempt: ${lastAttempt})`
            );
          if (spawnError)
            throw new Error(
              `${label}: could not start the server: ${spawnError.message}${outputTail(stdoutTail, stderrTail)}`
            );
          if (hasExited)
            throw new Error(
              `${label}: server exited before /api/overview answered (code ${exitInfo?.code}, signal ${exitInfo?.signal})${outputTail(stdoutTail, stderrTail)}`
            );
          // 아직 듣지 않았거나 응답이 늦으면 답이 없는 것이다. 그 원인을 남기고 시한 안에서 다시 본다.
          const text = await continueAfterFailure(
            async () => {
              const response = await fetch(`${readyUrl}/api/overview`, {
                signal: AbortSignal.timeout(fetchTimeoutMs),
              });
              lastAttempt = `HTTP ${response.status}`;
              return response.ok ? await response.text() : undefined;
            },
            (error) => {
              lastAttempt = failureCode(
                error instanceof Error && error.cause !== undefined
                  ? error.cause
                  : error
              );
            }
          );
          if (text === undefined) {
            await delay(250);
            continue;
          }
          const fields = overviewFields(label, text);
          console.log(
            `${label}: server ready on ${process.platform}: ${fields} overview fields`
          );
          break;
        }
      },
      () => crashServer(server),
    ],
    `${label}: the server check failed`
  );
}

/** 사고 재현: 서버 프로세스만 강제로 끝내고 그 끝을 상한 안에서 확인한다. 서버가 남긴 것(DB)은 남는다. */
async function crashServer(server) {
  server.killLeader();
  let timer;
  try {
    await Promise.race([
      server.exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `server ${server.pid} did not exit within ${stopWaitMs}ms after it was killed`
              )
            ),
          stopWaitMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 이번 Postgres가 정상 정지된 cluster에서 시작했는지. 강제로 끝난 cluster면 복구 과정을 거친다. */
function expectCleanStart(label) {
  const text = readFileSync(log, "utf8");
  if (
    text.includes("not properly shut down") ||
    !text.includes("database system was shut down")
  )
    throw new Error(
      `${label}: Postgres did not start from a normal stop\n${text.slice(-2000)}`
    );
  console.log(`${label}: Postgres started from a normal stop`);
}

/** postmaster.pid의 첫 줄 pid와 넷째 줄 port. DB를 다시 열 때 실제 port가 필요하다. */
function readPostmaster() {
  // Postgres가 멈추면 이 파일을 지운다. 없으면 떠 있지 않은 것이다.
  const text = orIfMissing(
    () => readFileSync(pidFile, "utf8"),
    hasErrorCode("ENOENT"),
    undefined
  );
  if (text === undefined) return undefined;
  const [pidLine, , , portLine] = text.split("\n");
  const pid = Number(pidLine);
  const port = Number(portLine);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    port: Number.isInteger(port) && port > 0 ? port : undefined,
  };
}

/**
 * 실패했을 때 남은 Postgres를 멈추고, 실제로 멈출 때까지 기다린다. 멈추지 않았는데 폴더를 지우지 않는다.
 * 제품처럼 Postgres의 pg_ctl로 즉시 정지한다. postmaster가 자기 자식까지 끝내므로, Windows에서 postmaster만 강제로 끝내
 * 자식이 남아 폴더와 출력을 잡는 일이 없다. pg_ctl은 그 폴더의 postmaster에만 보낸다.
 */
async function stopLeftPostgres() {
  const running = readPostmaster();
  if (!running?.pid || !processAlive(running.pid)) return;
  // 이미 멈췄거나 시한 안에 멈추지 않았으면 pg_ctl이 실패한다. 무엇이 실패했는지 남기고, 멈췄는지는 아래에서 확인한다.
  await continueAfterFailure(
    async () =>
      execFileSync(
        await pgCtl(),
        [
          "stop",
          "-D",
          dataDir,
          "-m",
          "immediate",
          "-w",
          "-t",
          String(cleanupTimeoutMs / 1000),
        ],
        {
          stdio: "ignore",
          timeout: cleanupTimeoutMs + 5_000,
          killSignal: "SIGKILL",
        }
      ),
    (error) =>
      console.log(
        `pg_ctl stop of Postgres ${running.pid} did not succeed (${failureCode(error)}); checking whether it stopped`
      )
  );
  const deadline = Date.now() + cleanupTimeoutMs;
  while (processAlive(running.pid) && Date.now() < deadline) await delay(100);
  if (processAlive(running.pid))
    throw new Error(
      `leftover embedded Postgres (pid ${running.pid}) did not stop in ${cleanupTimeoutMs}ms`
    );
}

/** 제품(packages/db)이 쓰는 내장 Postgres의 pg_ctl. 루트도 db와 같은 판(같은 patch)을 선언해 같은 설치 폴더를 받는다. */
async function pgCtl() {
  const { getBinaries } = await import("embedded-postgres");
  return (await getBinaries()).pg_ctl;
}

function readPort(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(
      `${name} must be a whole number from 0 to 65535, got "${value}"`
    );
  return port;
}

/** 밀리초 시한. 비었으면 undefined. 1~2147483647 정수가 아니면 시작하지 않는다. */
function readTimeout(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647)
    throw new Error(
      `${name} must be a whole number of milliseconds from 1 to 2147483647, got "${value}"`
    );
  return ms;
}

function outputTail(...texts) {
  const output = texts.filter(Boolean).join("\n").trim();
  return output ? `\n${output.slice(-4000)}` : "\n(no output)";
}

/** 이 검사가 띄운 모든 서버 트리. 강제로 끝낸 서버가 남긴 것은 다음 시작이 정리하고, 마지막 정리가 트리째 끄고 확인한다. */
const servers = [];
const stop = createStop({
  graceMs: stopGraceMs,
  log: (message) => console.log(message),
  // 멈춤 시한 안에 흐름이 끝나지 않았다(단계 하나가 끝나지 않음). 떠 있는 서버만 끝내고 남았을 수 있는 것을 밝혀 실패한다.
  onGraceExpired: () => void killServerAndExit(),
});
/**
 * 멈춤 시한이 지났을 때: 띄운 서버 트리를 모두 끄고 끝난 것을 확인한 뒤 실패로 끝낸다. 확인하지 못한 트리는 그 이유를 밝힌다.
 */
async function killServerAndExit() {
  const results = await Promise.allSettled(servers.map((tree) => tree.stop()));
  for (const result of results)
    if (result.status === "rejected")
      console.log(
        `a server tree could not be confirmed stopped and may remain: ${result.reason instanceof Error ? result.reason.message : result.reason}`
      );
  // 비상 종료: 출력이 다 닿기를 기다리지 않는다(afterOutput을 쓰지 않는다). 멈춤 시한이 지나 자기 시한 + 유예 안에 끝나는 것을
  // 지키는 자리라, 표준 출력을 아무도 읽지 않을 때 출력을 기다리면 그 시한을 넘긴다.
  process.exit(1);
}

setTimeout(
  () => stop.request(`boot check did not finish in ${runDeadlineMs / 1000}s`),
  runDeadlineMs
).unref();
// 바깥에서 멈추라고 하면(CI 취소·Ctrl+C·감독자) 같은 멈춤으로 받는다. 진행 중인 단계를 마친 뒤 정리하고 끝난다.
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => stop.request(`stopped by ${signal}`));

const { code } = await runBootCheckFlow({
  stop,
  log: (message) => console.log(message),
  serve: serveAndKill,
  expectLeftover: () => {
    if (!existsSync(pidFile))
      throw new Error(
        "the embedded Postgres did not outlive the killed server"
      );
  },
  expectCleanStart,
  open: async () => {
    const running = readPostmaster();
    if (!running?.port)
      throw new Error(
        `could not read the embedded Postgres port from ${pidFile}`
      );
    const { openDatabase } = await import("@babojubot/db");
    return openDatabase({
      embedded: { dataDir, port: running.port, persistent: true },
    });
  },
  close: (handle) => handle.close(),
  expectClosed: () => {
    if (existsSync(pidFile))
      throw new Error("the embedded Postgres was still running after close");
    console.log("embedded Postgres stopped normally on close");
  },
  // 서로 독립인 끄기: 남은 DB를 pg_ctl로 멈추고, 띄운 서버 트리마다 끝난 것을 확인한다. 하나가 실패해도 나머지는 한다.
  stops: () => [stopLeftPostgres, ...servers.map((tree) => () => tree.stop())],
  // 끄기가 모두 성공한 뒤에만 부른다.
  removeFolder: () =>
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
});
process.exitCode = code;
