// 이 시스템에서 기본 설정의 서버가 실제로 뜨는지 본다. 내장 DB 시작·migration·DB를 읽는 API 하나까지 확인한다.
// 서버가 정리 없이 끝나 내장 DB가 남으면 다음 시작이 그 DB를 정상 정지하고 다시 뜨는지, 닫을 때 정상 정지하는지도 본다.
// CI의 macOS·Windows 작업이 부른다. 상속 환경과 상관없이 임시 폴더·빈 port만 쓰고, 끝나면 DB가 실제로 멈춘 것을 기다린 뒤 폴더를 지운다.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// main.ts가 서버를 띄운 뒤 내는 완전한 한 줄. 내장 DB로 띄운 서버만 받는다.
// 예: `BaboJUBot server on http://127.0.0.1:PORT (embedded Postgres …, product folder …)`
const readyLinePattern =
  /^BaboJUBot server on (https?:\/\/[^\s)]+) \(embedded Postgres [^\r\n]*\)\r?\n/m;
const overallTimeoutMs = 180_000;
const fetchTimeoutMs = 2_000;
const cleanupTimeoutMs = 15_000;
const stopWaitMs = 10_000;

const httpPort = readPort("BOOT_CHECK_PORT");
const dbPort = readPort("BOOT_CHECK_DB_PORT");
const home = mkdtempSync(path.join(tmpdir(), "babojubot-boot-"));
const dataDir = path.join(home, "postgres");
const pidFile = path.join(dataDir, "postmaster.pid");
const log = path.join(dataDir, "postgres.log");

/**
 * 부모 환경의 실제 서비스 설정이 이 검사를 바꾸지 않게 서버 환경을 따로 만든다.
 * 외부 DB·임시 DB·HOST·시한·실제 프로바이더·가짜 프로바이더 설정은 지우고 알려진 값만 넣는다.
 */
function serverEnv() {
  const env = { ...process.env };
  for (const name of [
    "DATABASE_URL",
    "BABOJUBOT_EPHEMERAL_DB",
    "HOST",
    "EMBEDDED_POSTGRES_PORT",
    "BABOJUBOT_SHUTDOWN_TIMEOUT_MS",
    "BABOJUBOT_PROVIDERS",
    "BABOJUBOT_FAKE_PROVIDERS",
    "BABOJUBOT_FAKE_PROVIDER_SETTINGS",
    "BABOJUBOT_CODEX_MODE",
    "BABOJUBOT_DOCKER_COMMAND",
    "BABOJUBOT_CONTAINER_IMAGE",
    "BABOJUBOT_MODEL_DESTINATIONS",
  ])
    delete env[name];
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

  const deadline = Date.now() + overallTimeoutMs;
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
      if (Date.now() >= deadline)
        throw new Error(
          `${label}: server was not ready in ${overallTimeoutMs / 1000}s${outputTail(stdoutTail, stderrTail)}`
        );
      await delay(50);
    }

    let overview;
    while (overview === undefined) {
      if (spawnError)
        throw new Error(
          `${label}: could not start the server: ${spawnError.message}${outputTail(stdoutTail, stderrTail)}`
        );
      if (hasExited)
        throw new Error(
          `${label}: server exited before /api/overview answered (code ${exitInfo?.code}, signal ${exitInfo?.signal})${outputTail(stdoutTail, stderrTail)}`
        );
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `${label}: /api/overview did not answer in ${overallTimeoutMs / 1000}s${outputTail(stdoutTail, stderrTail)}`
        );
      try {
        const response = await fetch(`${readyUrl}/api/overview`, {
          signal: AbortSignal.timeout(
            Math.min(fetchTimeoutMs, Math.max(1, remaining))
          ),
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

/** 실패했을 때 남은 Postgres를 실제로 멈출 때까지 기다린다. 멈추지 않았는데 폴더를 지우지 않는다. */
async function stopLeftPostgres() {
  const running = readPostmaster();
  if (!running?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(running.pid)], {
        stdio: "ignore",
        timeout: cleanupTimeoutMs,
      });
    } catch (error) {
      if (isAlive(running.pid)) throw error;
    }
  } else {
    try {
      process.kill(running.pid, "SIGQUIT");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + cleanupTimeoutMs;
  while (isAlive(running.pid) && Date.now() < deadline) await delay(100);
  if (isAlive(running.pid))
    throw new Error(
      `leftover embedded Postgres (pid ${running.pid}) did not stop in ${cleanupTimeoutMs}ms`
    );
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

function outputTail(...texts) {
  const output = texts.filter(Boolean).join("\n").trim();
  return output ? `\n${output.slice(-4000)}` : "\n(no output)";
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let code = 0;
let failure;
try {
  await serveAndKill("first start");
  if (!existsSync(pidFile))
    throw new Error("the embedded Postgres did not outlive the killed server");
  await serveAndKill("start after a killed server");
  expectCleanStart("start after a killed server");
  // 서버 없이 열고 닫는다. 남은 DB를 다시 정상 정지하고 띄우며, 닫을 때도 정상 정지해야 한다.
  const running = readPostmaster();
  if (!running?.port)
    throw new Error(
      `could not read the embedded Postgres port from ${pidFile}`
    );
  const { openDatabase } = await import(
    pathToFileURL(path.resolve("packages/db/src/index.ts")).href
  );
  const handle = await openDatabase({
    embedded: { dataDir, port: running.port, persistent: true },
  });
  try {
    expectCleanStart("open after another killed server");
  } catch (error) {
    // 검사가 실패해도 연 handle은 닫는다. 닫기도 실패하면 원래 실패를 남긴다.
    await handle
      .close()
      .catch((closeError) =>
        console.error(
          `could not close the embedded Postgres after a failed check: ${closeError instanceof Error ? closeError.message : closeError}`
        )
      );
    throw error;
  }
  await handle.close();
  if (existsSync(pidFile))
    throw new Error("the embedded Postgres was still running after close");
  console.log("embedded Postgres stopped normally on close");
} catch (error) {
  code = 1;
  failure = error;
  console.log(error instanceof Error ? error.message : error);
}
try {
  await stopLeftPostgres();
  rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
} catch (error) {
  code = 1;
  const cleanup = error instanceof Error ? error.message : String(error);
  const original = failure
    ? `\noriginal failure: ${failure instanceof Error ? failure.message : failure}`
    : "";
  console.log(`cleanup failed: ${cleanup}${original}`);
}
process.exitCode = code;
