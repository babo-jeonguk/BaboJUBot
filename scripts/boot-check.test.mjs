// 실제 boot-check를 돌려, 부모의 DB·HOST·시한·프로바이더 설정과 옛 기본 port가 검사에 새지 않는지 본다.
// 수정 전에는 내장 Postgres 검사가 상속한 DATABASE_URL로 접속하다 실패한다.
// boot-check는 자기가 띄운 서버·내장 Postgres·임시 폴더의 주인이다. 시한이 지나거나 멈추라는 요청을 받으면
// 그것들을 스스로 정리하고 끝난다. 이 파일은 boot-check만 강제로 끝내지 않고 멈춤을 요청한다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldDefaultPort = 38417;
// boot-check 자신의 실행 시한(scripts/boot-check.mjs `runTimeoutMs`)과 그 뒤 정리 몫. 여기서는 안전망일 뿐이다.
const bootCheckTimeoutMs = 360_000;
const cleanupMs = 60_000;

test(
  "boot check ignores inherited database, host, shutdown, and provider settings",
  { timeout: bootCheckTimeoutMs + 2 * cleanupMs + 30_000 },
  async () => {
    const listener = await occupyOldDefaultPort();
    try {
      const run = startBootCheck(pollutedEnv());
      let result;
      try {
        result = await run.finished(bootCheckTimeoutMs + cleanupMs);
      } finally {
        await run.stop();
      }
      const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
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
      assert.equal(
        existsSync(result.home),
        false,
        `boot check left its folder\n${output}`
      );
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

// 서버와 내장 Postgres가 떠 있는 중에 멈추라고 하면 boot-check가 둘을 멈추고 임시 폴더를 지운 뒤 실패로 끝난다.
// boot-check만 강제로 끝내면 서버·Postgres·폴더가 남는다.
test(
  "boot check stops its server and Postgres and removes its folder when asked to stop",
  { timeout: bootCheckTimeoutMs + 2 * cleanupMs + 30_000 },
  async () => {
    const run = startBootCheck(pollutedEnv());
    try {
      await run.printed(
        /^first start: server ready/m,
        bootCheckTimeoutMs,
        "the first server was not ready"
      );
      const home = run.home();
      const postmaster = readPostmasterPid(
        path.join(home, "postgres", "postmaster.pid")
      );
      assert.ok(postmaster, `no running Postgres under ${home}`);

      const result = await run.stop();
      const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      assert.equal(
        result.code,
        1,
        `boot check did not fail on stop\n${output}`
      );
      assert.match(result.stdout, /stop requested by the parent/);
      assert.equal(isAlive(postmaster), false, `Postgres stayed\n${output}`);
      assert.equal(existsSync(home), false, `folder stayed\n${output}`);
    } finally {
      await run.stop();
    }
  }
);

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
 * 실제 스크립트를 자식 하나로 띄운다. stdout/stderr는 끝까지 읽는다. 멈춤은 IPC 요청으로 하고,
 * 정리 몫 안에 끝나지 않을 때만 강제로 끝낸 뒤 남았을 수 있는 폴더를 밝혀 실패한다.
 */
function startBootCheck(env) {
  const child = spawn(process.execPath, ["scripts/boot-check.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
  const home = () => {
    const match = /^boot check folder: (.+?)\r?$/m.exec(stdout);
    if (!match)
      throw new Error(`boot check did not print its folder\n${stdout}`);
    return match[1];
  };
  const result = (exit) => ({ ...exit, stdout, stderr, home: home() });
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
    home,
    /** 스스로 끝나기를 기다린다. 시한이 지나면 멈춤을 요청하고 실패한다. */
    async finished(ms) {
      const exit = await within(closed, ms);
      if (exit) return result(exit);
      const stopped = await this.stop();
      throw new Error(
        `boot check did not finish in ${ms}ms (stopped with code ${stopped.code})\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    },
    /** 출력에 pattern이 나올 때까지 기다린다. */
    async printed(pattern, ms, what) {
      const deadline = Date.now() + ms;
      while (!pattern.test(stdout)) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`${what}: boot check ended\n${stdout}\n${stderr}`);
        if (Date.now() >= deadline)
          throw new Error(`${what} in ${ms}ms\n${stdout}\n${stderr}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    /** 멈춤을 요청하고 정리가 끝나기를 기다린다. 이미 끝났으면 그 결과를 돌려준다. */
    stop() {
      stopping ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.send("stop");
          } catch {
            /* 그 사이 끝났다. */
          }
        }
        const exit = await within(closed, cleanupMs);
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
          `boot check did not clean up within ${cleanupMs}ms of a stop request; its server, Postgres, and ${folder} may remain\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
      })();
      return stopping;
    },
  };
}

function readPostmasterPid(file) {
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
