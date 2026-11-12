// 이 시스템에서 기본 설정의 서버가 실제로 뜨는지 본다. 내장 DB 시작·migration·DB를 읽는 API 하나까지 확인한다.
// 서버가 정리 없이 끝나 내장 DB가 남으면 다음 시작이 그 DB를 정상 정지하고 다시 뜨는지, 닫을 때 정상 정지하는지도 본다.
// CI의 macOS·Windows 작업이 부른다. 상속 환경과 상관없이 임시 폴더·빈 port만 쓰고, 끝나면 DB가 실제로 멈춘 것을 기다린 뒤 폴더를 지운다.
// 멈춤(자기 시한·SIGTERM·SIGINT)은 진행 중인 단계를 끊지 않고 다음 단계 경계에서 받아 한 곳의 정리로 끝낸다(boot-check-flow.mjs).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runTimeoutMs, stopGraceMs } from "./boot-check-limits.mjs";
import { createStop, runBootCheckFlow } from "./boot-check-flow.mjs";

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

/** 서버를 띄워 그 서버가 알린 URL의 API가 답하면 서버 프로세스만 강제로 끝낸다(IDE 강제 정지·OOM과 같은 상황). 내장 DB는 따로 남는다. */
async function serveAndKill(label) {
  const server = spawn(process.execPath, ["apps/server/src/main.ts"], {
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutTail = "";
  let stderrTail = "";
  let pendingLine = "";
  let readyUrl;
  let exitInfo;
  let hasExited = false;
  let spawnError;
  // 한 번만 오는 사건을 놓치지 않게 spawn 직후에 붙인다. error가 나면 exit가 오지 않아도 기다림을 끝낸다.
  const exited = new Promise((resolve) => {
    server.once("exit", (code, signal) => {
      hasExited = true;
      exitInfo = { code, signal };
      resolve();
    });
    server.once("error", (error) => {
      spawnError = error;
      resolve();
    });
  });
  current = {
    label,
    server,
    output: () => outputTail(stdoutTail, stderrTail),
  };
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

  let failure;
  try {
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

    let overview;
    while (overview === undefined) {
      stop.throwIfStopped(label);
      if (spawnError)
        throw new Error(
          `${label}: could not start the server: ${spawnError.message}${outputTail(stdoutTail, stderrTail)}`
        );
      if (hasExited)
        throw new Error(
          `${label}: server exited before /api/overview answered (code ${exitInfo?.code}, signal ${exitInfo?.signal})${outputTail(stdoutTail, stderrTail)}`
        );
      try {
        const response = await fetch(`${readyUrl}/api/overview`, {
          signal: AbortSignal.timeout(fetchTimeoutMs),
        });
        if (response.ok) overview = await response.json();
      } catch {
        /* 아직 듣지 않았거나 응답이 늦다. 시한 안에서 다시 본다. */
      }
      if (overview === undefined) await delay(250);
    }
    console.log(
      `${label}: server ready on ${process.platform}: ${Object.keys(overview).length} overview fields`
    );
  } catch (error) {
    failure = error;
  }
  try {
    await stopServer(server, exited, () => hasExited);
  } catch (stopError) {
    if (failure) {
      console.error(
        `${label}: could not confirm the server stopped: ${stopError instanceof Error ? stopError.message : stopError}`
      );
    } else {
      throw stopError;
    }
  }
  current = undefined;
  if (failure) throw failure;
}

/** 이 스크립트가 띄운 서버만 끝낸다. 이미 끝났으면 그 종료를 기다린다. */
async function stopServer(server, exited, hasExited) {
  if (!hasExited() && server.pid !== undefined) {
    try {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/F", "/PID", String(server.pid)], {
          stdio: "ignore",
          timeout: stopWaitMs,
        });
      else server.kill("SIGKILL");
    } catch {
      // 강제 종료 명령이 실패하면 이 프로세스의 자식 종료로 한 번 더 시도한다.
      try {
        server.kill("SIGKILL");
      } catch {
        /* 그 사이 끝났다. 아래에서 종료를 기다린다. */
      }
    }
  }
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `server did not exit within ${stopWaitMs}ms after SIGKILL`
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
  if (!existsSync(pidFile)) return undefined;
  const [pidLine, , , portLine] = readFileSync(pidFile, "utf8").split("\n");
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
  if (!running?.pid || !isAlive(running.pid)) return;
  try {
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
      { stdio: "ignore", timeout: cleanupTimeoutMs + 5_000 }
    );
  } catch {
    /* 이미 멈췄거나 시한 안에 멈추지 않았다. 아래에서 확인한다. */
  }
  const deadline = Date.now() + cleanupTimeoutMs;
  while (isAlive(running.pid) && Date.now() < deadline) await delay(100);
  if (isAlive(running.pid))
    throw new Error(
      `leftover embedded Postgres (pid ${running.pid}) did not stop in ${cleanupTimeoutMs}ms`
    );
}

/** 제품(packages/db)이 쓰는 내장 Postgres의 pg_ctl. */
async function pgCtl() {
  const require = createRequire(path.resolve("packages/db/package.json"));
  const { getBinaries } = await import(
    pathToFileURL(require.resolve("embedded-postgres")).href
  );
  return (await getBinaries()).pg_ctl;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 지금 떠 있는 서버. 멈춤 시한이 지나 강제로 끝낼 때만 쓴다. */
let current;
const stop = createStop({
  graceMs: stopGraceMs,
  log: (message) => console.log(message),
  // 멈춤 시한 안에 흐름이 끝나지 않았다(단계 하나가 끝나지 않음). 떠 있는 서버만 끝내고 남았을 수 있는 것을 밝혀 실패한다.
  onGraceExpired: () => {
    console.log(
      `${stop.reason}: cleanup did not finish in ${stopGraceMs / 1000}s; the server, Postgres, and ${home} may remain${current ? current.output() : ""}`
    );
    try {
      current?.server.kill("SIGKILL");
    } catch {
      /* 이미 끝났다. */
    }
    process.exit(1);
  },
});
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
    const { openDatabase } = await import(
      pathToFileURL(path.resolve("packages/db/src/index.ts")).href
    );
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
  cleanUp: async () => {
    await stopLeftPostgres();
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  },
});
process.exitCode = code;
