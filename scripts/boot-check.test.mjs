// 실제 boot-check를 돌려, 부모의 DB·HOST·시한·프로바이더 설정과 옛 기본 port가 검사에 새지 않는지, 자기 시한에서
// 멈춰도 띄운 서버·내장 Postgres·임시 폴더를 남기지 않는지 본다.
// boot-check는 자기가 띄운 것의 주인으로 스스로 정리한다. 이 파일은 감독자다: 임시 폴더 위치를 먼저 정해 넘기고 boot-check를
// 띄운다. boot-check가 자기 시한 + 멈춤 시한 안에 끝나지 않으면 강제로 끝내고(POSIX: 그룹에 SIGTERM → 여유 → SIGKILL,
// Windows: 살아 있는 부모부터 트리 강제 종료) 그룹을 벗어난 Postgres 정지 → 폴더 삭제 → 남은 것 없음 확인 순서로 직접 치운다.
// 실제 boot-check 시험은 Linux·macOS·Windows CI에서 돈다. Windows에서만 다른 정리 분기(taskkill·쓰는 중인 파일)와
// 대소문자를 가리지 않는 환경 변수를 그곳에서 확인한다.
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
  {
    timeout: 60_000,
    // 그룹을 벗어난 자식을 pid 파일과 명령줄로 찾아 끝내는 POSIX 경로의 시험이다. Windows 감독자는 그런 Postgres를 끄지 않고
    // 남은 것으로 드러낸다(명령줄로 우리 것인지 확인할 수 없다).
    skip:
      process.platform === "win32" &&
      "POSIX process groups only; on Windows the supervisor reports a Postgres outside the tree instead of stopping it",
  },
  async () => {
    // 폴더 안의 오래된 pid 파일이 가리키는, 이 폴더와 무관한 프로세스(pid 재사용). 감독자는 이것을 끝내면 안 된다.
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    try {
      const result = await supervise(
        ["scripts/test-fixtures/stuck-run.mjs"],
        { ...process.env, UNRELATED_PID: String(unrelated.pid) },
        { overrunMs: 1_000, graceMs: 500 }
      );
      const output = describe(result);
      const started = JSON.parse(result.stdout.trim().split("\n")[0]);
      assert.equal(result.overrun, true, output);
      assert.equal(isAlive(started.inGroup), false, output);
      assert.equal(isAlive(started.escaped), false, output);
      assert.equal(isAlive(unrelated.pid), true, output);
      assert.notDeepEqual(result.leftBehind, noLeftovers, output);
      assert.deepEqual(result.leftAfterCleanup, noLeftovers, output);
    } finally {
      unrelated.kill("SIGKILL");
    }
  }
);

// 치우기의 한 단계가 실패해도 나머지 단계(폴더 삭제)는 계속하고, 실패를 알린다. 읽을 수 없는 pid 파일로 실패를 만든다.
test(
  "the supervisor keeps cleaning up after a cleanup step fails and reports it",
  {
    timeout: 60_000,
    skip:
      process.platform === "win32" &&
      "file modes cannot make a file unreadable on Windows",
  },
  async () => {
    const script = `
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "unreadable-"));
      const file = path.join(dir, "postmaster.pid");
      fs.writeFileSync(file, "1\\n");
      fs.chmodSync(file, 0o000);
      console.log(dir);
    `;
    const error = await supervise(["-e", script], process.env).then(
      () => assert.fail("the supervisor did not report the failed step"),
      (error) => error
    );
    assert.ok(error instanceof AggregateError, String(error));
    assert.match(
      error.errors.map((e) => e.message).join("\n"),
      /stop the Postgres left in the folder: .*EACCES/
    );
    const scope = /could not clean up (\S+)/.exec(error.message)?.[1];
    assert.ok(scope, error.message);
    assert.equal(existsSync(scope), false, `${scope} was not removed`);
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
    // Windows는 환경 변수 이름의 대소문자를 가리지 않아 서버가 이 이름도 BABOJUBOT_FAKE_PROVIDER_SETTINGS로 읽는다.
    babojubot_fake_provider_settings: "not json",
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
 * 스크립트를 감독하며 돌린다. 임시 폴더(`TMPDIR` 등)를 이 감독자의 폴더로 정해 넘긴다. POSIX에서는 자기 프로세스 그룹으로 띄운다.
 * `leftBehind`는 스크립트가 끝난 직후 그 폴더에 남은 것, `leftAfterCleanup`은 감독자가 치운 뒤에 남은 것이다.
 * 치우기는 실행이 어떻게 끝났든 `finally`에서 단계마다 따로 시도하고, 실패한 단계는 원래 실패와 함께 알린다.
 */
async function supervise(
  args,
  env,
  { overrunMs: limit = overrunMs, graceMs = stopGraceMs } = {}
) {
  const scope = await mkdtemp(path.join(tmpdir(), "boot-check-supervised-"));
  let child;
  let result;
  let failure;
  let problems;
  try {
    child = spawn(process.execPath, args, {
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
    if (!exit) exit = await forceStop(child, closed, graceMs);
    result = {
      ...(exit ?? { code: null, signal: null }),
      stdout,
      stderr,
      overrun,
      leftBehind: leftovers(scope),
    };
  } catch (error) {
    failure = error;
  } finally {
    problems = await cleanUpScope(scope, child);
    if (result) result.leftAfterCleanup = leftovers(scope);
  }
  if (problems.length > 0)
    throw new AggregateError(
      failure ? [failure, ...problems] : problems,
      `the supervisor could not clean up ${scope}${result ? `\n${describe(result)}` : ""}`
    );
  if (failure) throw failure;
  return result;
}

/**
 * 시한을 넘긴 실행을 끝낸다. POSIX: 그룹에 멈춤 요청(SIGTERM) → 여유 → 그룹 강제 종료.
 * Windows에는 협조적인 멈춤 신호가 없고(SIGTERM도 그 프로세스만 강제로 끝낸다) 트리는 부모가 살아 있을 때만 따라갈 수 있으므로,
 * 부모가 살아 있는 동안 트리 전체를 먼저 강제로 끝낸다.
 */
async function forceStop(child, closed, graceMs) {
  if (process.platform === "win32") {
    killTree(child);
    return within(closed, 10_000);
  }
  signalGroup(child, "SIGTERM");
  const exit = await within(closed, graceMs);
  if (exit) return exit;
  signalGroup(child, "SIGKILL");
  return within(closed, 10_000);
}

/** 정상으로 끝났어도 남은 것을 치운다. 단계마다 따로 시도하고 실패한 단계를 모아 돌려준다. */
async function cleanUpScope(scope, child) {
  const problems = [];
  const attempt = async (what, work) => {
    try {
      await work();
    } catch (error) {
      problems.push(new Error(`${what}: ${error?.message ?? error}`));
    }
  };
  // POSIX에서 그룹에 남은 자식. Windows는 트리를 부모가 살아 있을 때만 따라갈 수 있어 forceStop에서 끝냈다.
  if (child && process.platform !== "win32")
    await attempt("stop the process group", () =>
      signalGroup(child, "SIGKILL")
    );
  await attempt("stop the Postgres left in the folder", () =>
    stopPostmasters(scope)
  );
  await attempt("wait for the folder's processes to end", async () => {
    if (!(await waitUntil(() => runningIn(scope).length === 0, 10_000)))
      throw new Error(`still running: ${runningIn(scope).join("; ")}`);
  });
  await attempt("remove the folder", () =>
    rm(scope, { recursive: true, force: true, maxRetries: 5 })
  );
  return problems;
}

function leftovers(scope) {
  return {
    folders: existsSync(scope) ? readdirSync(scope) : [],
    processes: runningIn(scope),
  };
}

/** POSIX 프로세스 그룹 전체에 신호를 보낸다. 그룹이 이미 없으면 넘어간다. */
function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/** Windows에서 살아 있는 부모부터 프로세스 트리 전체를 강제로 끝낸다. */
function killTree(child) {
  if (child.pid === undefined) return;
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
    });
  } catch {
    /* 이미 끝났다. */
  }
}

/**
 * 폴더 안의 postmaster.pid가 가리키는 Postgres를 멈춘다. pg_ctl이 띄운 Postgres는 자기 세션을 만들어 그룹을 벗어난다.
 * pid는 재사용될 수 있으므로 그 프로세스의 명령줄에 이 감독자의 폴더가 있을 때만 신호를 보낸다(POSIX). Windows는 명령줄을
 * 싸게 확인할 수 없어 신호를 보내지 않는다. 그 Postgres가 살아 있으면 남은 것으로 드러난다.
 */
async function stopPostmasters(scope) {
  for (const pid of postmasterPids(scope)) {
    if (process.platform === "win32" || !commandLine(pid).includes(scope))
      continue;
    for (const signal of ["SIGQUIT", "SIGKILL"]) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      if (await waitUntil(() => !isAlive(pid), 10_000)) break;
    }
  }
}

/** 폴더 안 postmaster.pid들이 가리키는 살아 있는 pid. 그 사이 지워진 파일은 넘어간다. */
function postmasterPids(scope) {
  const pids = [];
  for (const file of findFiles(scope, "postmaster.pid")) {
    let pid;
    try {
      pid = Number(readFileSync(file, "utf8").split("\n")[0]);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) pids.push(pid);
  }
  return pids;
}

function findFiles(dir, name) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** 그 pid의 명령줄. 없으면 빈 문자열. */
function commandLine(pid) {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
    });
  } catch {
    return "";
  }
}

/**
 * 그 폴더를 쓰는 살아 있는 프로세스. POSIX는 명령줄에 그 폴더가 있는 프로세스(그 폴더의 postmaster 등)다.
 * Windows는 명령줄을 싸게 볼 수 없어 그 폴더의 postmaster.pid가 가리키는 살아 있는 프로세스로 본다(쓰는 중인 폴더는 지울 수도 없다).
 */
function runningIn(folder) {
  if (process.platform === "win32")
    return existsSync(folder)
      ? postmasterPids(folder).map((pid) => `postmaster ${pid}`)
      : [];
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
