// 실제 boot-check를 돌려, 부모의 DB·HOST·시한·프로바이더 설정과 옛 기본 port가 검사에 새지 않는지, 자기 시한에서
// 멈춰도 띄운 서버·내장 Postgres·임시 폴더를 남기지 않는지 본다.
// boot-check는 자기가 띄운 것의 주인으로 스스로 정리한다. 이 파일은 감독자다: 임시 폴더 위치를 먼저 정해 넘기고 boot-check를
// 자기 프로세스 그룹으로 띄운다. boot-check가 자기 시한 + 멈춤 시한 안에 끝나지 않으면 멈춤 요청(SIGTERM) → 여유 →
// 그룹 강제 종료 → 그룹을 벗어난 Postgres 정지 → 폴더 삭제 → 남은 것 없음 확인 순서로 직접 치우고 실패한다.
// 프로세스 그룹과 ps는 POSIX 방식이다. 이 파일은 CI에서 Linux로 돈다.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTimeoutMs, stopGraceMs } from "./boot-check-limits.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldDefaultPort = 38417;
// boot-check는 자기 시한 + 멈춤 시한 안에 스스로 끝난다. 감독자는 그 위에 여유를 두고 기다린다.
const overrunMs = runTimeoutMs + stopGraceMs + 30_000;
const testTimeoutMs = overrunMs + stopGraceMs + 60_000;

test(
  "boot check ignores inherited database, host, shutdown, and provider settings",
  { timeout: testTimeoutMs },
  async () => {
    const listener = await occupyOldDefaultPort();
    try {
      const result = await supervise(["scripts/boot-check.mjs"], pollutedEnv());
      const output = describe(result);
      assert.equal(result.overrun, false, `boot check overran\n${output}`);
      assert.equal(result.code, 0, `boot check failed\n${output}`);
      assert.match(
        result.stdout,
        /start after a killed server: Postgres started from a normal stop/
      );
      assert.match(
        result.stdout,
        /open after another killed server: Postgres started from a normal stop/
      );
      assert.match(
        result.stdout,
        /embedded Postgres stopped normally on close/
      );
      assert.deepEqual(result.leftBehind, noLeftovers, output);
      if (listener) {
        assert.equal(
          listener.requests(),
          0,
          `boot check requested the unrelated listener on port ${oldDefaultPort}\n${output}`
        );
      }
    } finally {
      if (listener)
        await new Promise((resolve) => listener.server.close(resolve));
    }
  }
);

// 시한이 이미 지난 채로 띄우면 첫 서버가 뜬 뒤 다음 단계 경계에서 멈춘다. 그 서버와 서버가 켠 Postgres를 멈추고
// 폴더를 지운 뒤 실패로 끝난다(서버 시작은 끊지 않으므로 멈출 때 서버와 Postgres가 떠 있다).
test(
  "boot check stops at its own deadline and leaves nothing behind",
  { timeout: testTimeoutMs },
  async () => {
    const result = await supervise(["scripts/boot-check.mjs"], {
      ...pollutedEnv(),
      BOOT_CHECK_TIMEOUT_MS: "1",
    });
    const output = describe(result);
    assert.equal(result.overrun, false, `boot check overran\n${output}`);
    assert.equal(result.code, 1, `boot check did not fail\n${output}`);
    assert.match(
      result.stdout,
      /first start: boot check did not finish in 0\.001s/
    );
    assert.doesNotMatch(result.stdout, /cleanup failed|may remain/, output);
    assert.deepEqual(result.leftBehind, noLeftovers, output);
  }
);

// 감독자 자신의 시험: 멈춤 요청을 무시하고 멈춘 실행을 강제로 끝내고, 그룹을 벗어난 Postgres 몫의 프로세스까지 멈추고
// 폴더를 지운다. 실제 boot-check 대신 그렇게 멈추는 작은 스크립트를 쓴다.
test(
  "the supervisor kills a stuck run, stops a Postgres outside its group, and removes the folder",
  { timeout: 60_000 },
  async () => {
    const result = await supervise(
      ["scripts/test-fixtures/stuck-run.mjs"],
      process.env,
      { overrunMs: 1_000, graceMs: 500 }
    );
    const output = describe(result);
    const started = JSON.parse(result.stdout.trim().split("\n")[0]);
    assert.equal(result.overrun, true, output);
    assert.equal(isAlive(started.inGroup), false, output);
    assert.equal(isAlive(started.escaped), false, output);
    assert.notDeepEqual(result.leftBehind, noLeftovers, output);
    assert.deepEqual(result.leftAfterCleanup, noLeftovers, output);
  }
);

const noLeftovers = { folders: [], processes: [] };

/** 부모 셸에 남은 실제 서비스 설정을 흉내 낸다. boot-check는 이것을 서버에 넘기지 않아야 한다. */
function pollutedEnv() {
  const env = {
    ...process.env,
    DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/unused",
    BABOJUBOT_EPHEMERAL_DB: "1",
    HOST: "not a host",
    BABOJUBOT_SHUTDOWN_TIMEOUT_MS: "soon",
    BABOJUBOT_PROVIDERS: "unknown-provider",
    BABOJUBOT_MODEL_DESTINATIONS: "not json",
  };
  delete env.BOOT_CHECK_PORT;
  delete env.BOOT_CHECK_DB_PORT;
  delete env.BOOT_CHECK_TIMEOUT_MS;
  return env;
}

/** 옛 기본 HTTP port(38417)에 응답하는 무관한 listener를 둔다. 이미 누가 쓰고 있으면 그대로 둔다. */
async function occupyOldDefaultPort() {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(oldDefaultPort, "127.0.0.1", resolve);
    });
    return { server, requests: () => requests };
  } catch (error) {
    if (error?.code === "EADDRINUSE") return undefined;
    throw error;
  }
}

/**
 * 스크립트를 감독하며 돌린다. 임시 폴더(`TMPDIR` 등)를 이 감독자의 폴더로 정해 넘기고, 자기 프로세스 그룹으로 띄운다.
 * `leftBehind`는 스크립트가 끝난 직후 그 폴더에 남은 것, `leftAfterCleanup`은 감독자가 치운 뒤에 남은 것이다.
 */
async function supervise(
  args,
  env,
  { overrunMs: limit = overrunMs, graceMs = stopGraceMs } = {}
) {
  const scope = await mkdtemp(path.join(tmpdir(), "boot-check-supervised-"));
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, TMPDIR: scope, TMP: scope, TEMP: scope },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  // close는 stdout/stderr를 끝까지 읽은 뒤 온다. spawn 직후에 붙여 한 번만 오는 사건을 놓치지 않는다.
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) =>
      resolve({ code: null, signal: null, error })
    );
  });
  let exit = await within(closed, limit);
  const overrun = !exit;
  if (!exit) {
    signalGroup(child, "SIGTERM");
    exit = await within(closed, graceMs);
  }
  if (!exit) {
    signalGroup(child, "SIGKILL");
    exit = await within(closed, 10_000);
  }
  const leftBehind = leftovers(scope);
  // 정상으로 끝났어도 그룹에 남은 자식과 그룹을 벗어난 Postgres는 감독자가 치운다.
  signalGroup(child, "SIGKILL");
  await stopPostmasters(scope);
  await waitUntil(() => processesUsing(scope).length === 0, 10_000);
  await rm(scope, { recursive: true, force: true, maxRetries: 5 });
  const leftAfterCleanup = {
    folders: existsSync(scope) ? readdirSync(scope) : [],
    processes: processesUsing(scope),
  };
  return {
    ...(exit ?? { code: null, signal: null }),
    stdout,
    stderr,
    overrun,
    leftBehind,
    leftAfterCleanup,
  };
}

function leftovers(scope) {
  return {
    folders: existsSync(scope) ? readdirSync(scope) : [],
    processes: processesUsing(scope),
  };
}

/** 프로세스 그룹 전체에 신호를 보낸다. 그룹이 이미 없으면 넘어간다. Windows는 프로세스 트리를 끝낸다. */
function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL")
        execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          stdio: "ignore",
        });
      else child.kill(signal);
    } else process.kill(-child.pid, signal);
  } catch {
    /* 이미 끝났다. */
  }
}

/** 폴더 안의 postmaster.pid가 가리키는 프로세스를 멈춘다. pg_ctl이 띄운 Postgres는 자기 세션을 만들어 그룹을 벗어난다. */
async function stopPostmasters(scope) {
  for (const file of findFiles(scope, "postmaster.pid")) {
    const pid = Number(readFileSync(file, "utf8").split("\n")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGQUIT");
    } catch {
      /* 그 사이 끝났다. */
    }
    if (!(await waitUntil(() => !isAlive(pid), 10_000))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 그 사이 끝났다. */
      }
      await waitUntil(() => !isAlive(pid), 10_000);
    }
  }
}

function findFiles(dir, name) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * 명령줄에 그 폴더가 있는 프로세스(그 폴더의 postmaster 등). POSIX에서 폴더를 지워도 쓰던 프로세스는 남으므로 따로 본다.
 * Windows에서는 쓰는 중인 폴더를 지울 수 없어 폴더가 지워졌는지로 충분하다.
 */
function processesUsing(folder) {
  if (process.platform === "win32") return [];
  return execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(folder))
    .map((line) => line.trim());
}

function describe(result) {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(check, ms) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
