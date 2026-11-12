// 실제 boot-check를 돌려, 부모의 DB·HOST·시한·프로바이더 설정과 옛 기본 port가 검사에 새지 않는지 본다.
// 수정 전에는 내장 Postgres 검사가 상속한 DATABASE_URL로 접속하다 실패한다.
// boot-check는 자기가 띄운 서버·내장 Postgres·임시 폴더의 주인이다. 시한이 지나거나 멈추라는 요청을 받으면
// 진행 중인 단계를 마친 뒤 그것들을 스스로 정리하고 끝난다. 이 파일은 boot-check만 강제로 끝내지 않고 멈춤을 요청한다.
// IPC로 띄우면 boot-check는 단계마다 `{ checkpoint }`를 보내고 부모의 "continue"/"stop"을 기다린다(결정적인 gate).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTimeoutMs, stopGraceMs } from "./boot-check-limits.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldDefaultPort = 38417;
// boot-check는 실행 시한 + 멈춤 시한 안에 스스로 끝난다. 여기서의 시한은 그 위의 안전망이다.
const finishMs = runTimeoutMs + stopGraceMs + 30_000;
const stopMs = stopGraceMs + 30_000;
const testTimeoutMs = finishMs + stopMs + 30_000;

test(
  "boot check ignores inherited database, host, shutdown, and provider settings",
  { timeout: testTimeoutMs },
  async () => {
    const listener = await occupyOldDefaultPort();
    try {
      const run = startBootCheck(pollutedEnv(), () => "continue");
      let result;
      try {
        result = await run.finished(finishMs);
      } finally {
        await run.stop();
      }
      const output = describe(result);
      assert.equal(result.code, 0, `boot check failed\n${output}`);
      assert.deepEqual(result.checkpoints, [
        "first start: server ready",
        "start after a killed server: server ready",
        "open after another killed server",
        "close",
      ]);
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
      assertNothingLeft(result);
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

// 서버가 떠 있는 채로 gate에서 멈추라고 하면 boot-check가 그 서버와 서버가 켠 Postgres를 멈추고 폴더를 지운다.
// gate가 서버를 붙잡고 있으므로 멈춤을 보낼 때 서버가 살아 있다.
test(
  "boot check stops a running server and its Postgres when asked to stop",
  { timeout: testTimeoutMs },
  async () => {
    let server;
    let postmaster;
    const result = await stopAt(
      "first start: server ready",
      (message, home) => {
        server = message.serverPid;
        assert.ok(server && isAlive(server), "the held server is not running");
        postmaster = readPostmasterPid(home);
        assert.ok(postmaster && isAlive(postmaster), "no running Postgres");
        return ["stop"];
      }
    );
    assert.equal(isAlive(server), false, `server stayed\n${describe(result)}`);
    assert.equal(
      isAlive(postmaster),
      false,
      `Postgres stayed\n${describe(result)}`
    );
  }
);

// DB를 다시 여는 중(남은 Postgres를 멈추고 새로 켬)에 멈추라고 하면, 정리가 그 시작과 겹치지 않고
// 시작이 끝난 뒤 Postgres를 멈추고 폴더를 지운다. 정리가 따로 돌면 켜지는 Postgres와 폴더 삭제가 겹친다.
test(
  "boot check finishes reopening the database before it cleans up on stop",
  { timeout: testTimeoutMs },
  async () => {
    await stopAt("open after another killed server", () => [
      "continue",
      "stop",
    ]);
  }
);

// DB를 닫는 중에 멈추라고 해도 닫기를 마친 뒤 정리한다.
test(
  "boot check finishes closing the database before it cleans up on stop",
  { timeout: testTimeoutMs },
  async () => {
    await stopAt("close", () => ["continue", "stop"]);
  }
);

/**
 * `stage` gate까지는 계속 진행시키고, 그 gate에서 `reply`가 돌려준 메시지를 차례로 보낸다.
 * boot-check가 실패 코드로 끝나고 아무것도 남기지 않았는지 확인한다.
 */
async function stopAt(stage, reply) {
  let reached = false;
  const run = startBootCheck(pollutedEnv(), (message, home) => {
    if (message.checkpoint !== stage) return "continue";
    reached = true;
    return reply(message, home);
  });
  let result;
  try {
    result = await run.finished(finishMs);
  } finally {
    await run.stop();
  }
  const output = describe(result);
  assert.ok(reached, `boot check never reached "${stage}"\n${output}`);
  assert.equal(result.code, 1, `boot check did not fail on stop\n${output}`);
  assert.match(result.stdout, /stop requested by the parent/);
  assertNothingLeft(result);
  return result;
}

/** 폴더가 지워졌고, 정리 실패·잔존 경고가 없으며, 그 폴더를 쓰는 프로세스가 없다. */
function assertNothingLeft(result) {
  const output = describe(result);
  assert.doesNotMatch(result.stdout, /cleanup failed|may remain/, output);
  assert.equal(existsSync(result.home), false, `folder stayed\n${output}`);
  assert.deepEqual(processesUsing(result.home), [], output);
}

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
 * 실제 스크립트를 IPC와 함께 자식 하나로 띄운다. stdout/stderr는 끝까지 읽는다. gate마다 `onCheckpoint`가
 * 돌려준 메시지(하나 또는 여럿)를 보낸다. 멈춤은 IPC 요청으로 하고, 멈춤 시한 안에 끝나지 않을 때만
 * 강제로 끝낸 뒤 남았을 수 있는 폴더를 밝혀 실패한다.
 */
function startBootCheck(env, onCheckpoint) {
  const child = spawn(process.execPath, ["scripts/boot-check.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  const checkpoints = [];
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
  const send = (message) => {
    try {
      child.send(message);
    } catch {
      /* 그 사이 끝났다. */
    }
  };
  // gate 처리 중 단언이 실패하면 멈춤을 보내고, 결과에서 그 실패를 다시 던진다.
  let gateFailure;
  child.on("message", (message) => {
    if (!message?.checkpoint) return;
    checkpoints.push(message.checkpoint);
    let replies;
    try {
      replies = [onCheckpoint(message, home())].flat();
    } catch (error) {
      gateFailure ??= error;
      replies = ["stop"];
    }
    for (const reply of replies) send(reply);
  });
  const home = () => {
    const match = /^boot check folder: (.+?)\r?$/m.exec(stdout);
    if (!match)
      throw new Error(`boot check did not print its folder\n${stdout}`);
    return match[1];
  };
  const result = (exit) => {
    if (gateFailure) throw gateFailure;
    return { ...exit, stdout, stderr, checkpoints, home: home() };
  };
  const within = async (promise, ms) => {
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
  };
  let stopping;
  return {
    /** 스스로 끝나기를 기다린다. 시한이 지나면 멈춤을 요청하고 실패한다. */
    async finished(ms) {
      const exit = await within(closed, ms);
      if (exit) return result(exit);
      await this.stop().catch(() => {});
      throw new Error(
        `boot check did not finish in ${ms}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    },
    /** 멈춤을 요청하고 정리가 끝나기를 기다린다. 이미 끝났으면 그 결과를 돌려준다. */
    stop() {
      stopping ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) send("stop");
        const exit = await within(closed, stopMs);
        if (exit) return result(exit);
        child.kill("SIGKILL");
        await within(closed, 10_000);
        let folder = "(folder not printed)";
        try {
          folder = home();
        } catch {
          /* 폴더를 알리기 전에 멈췄다. */
        }
        throw new Error(
          `boot check did not clean up within ${stopMs}ms of a stop request; its server, Postgres, and ${folder} may remain\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
      })();
      return stopping;
    },
  };
}

function describe(result) {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function readPostmasterPid(home) {
  const file = path.join(home, "postgres", "postmaster.pid");
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * 명령줄에 그 폴더가 있는 프로세스(그 폴더의 postmaster 등). POSIX에서 폴더를 지워도 쓰던 프로세스는 남으므로 따로 본다.
 * Windows에서는 쓰는 중인 폴더를 지울 수 없어 폴더가 지워졌는지로 충분하다.
 */
function processesUsing(folder) {
  if (process.platform === "win32") return [];
  return execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(folder));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
