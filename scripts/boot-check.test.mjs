// 실제 boot-check를 한 번 돌려, 부모의 DB·HOST·시한·프로바이더 설정과 옛 기본 port가 검사에 새지 않는지 본다.
// 수정 전에는 내장 Postgres 검사가 상속한 DATABASE_URL로 접속하다 실패한다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldDefaultPort = 38417;
const runTimeoutMs = 300_000;

test(
  "boot check ignores inherited database, host, shutdown, and provider settings",
  { timeout: runTimeoutMs + 30_000 },
  async () => {
    const listener = await occupyOldDefaultPort();
    try {
      const env = {
        ...process.env,
        DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/unused",
        BABOJUBOT_EPHEMERAL_DB: "1",
        HOST: "not a host",
        BABOJUBOT_SHUTDOWN_TIMEOUT_MS: "soon",
        BABOJUBOT_PROVIDERS: "unknown-provider",
      };
      delete env.BOOT_CHECK_PORT;
      delete env.BOOT_CHECK_DB_PORT;

      const result = await runBootCheck(env);
      const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      assert.equal(
        result.timeout,
        undefined,
        `boot check did not finish\n${output}`
      );
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

/** 실제 스크립트를 자식 하나로 돌린다. stdout/stderr는 끝까지 읽고, 시한이 지나면 끝내고 기다린다. */
async function runBootCheck(env) {
  const child = spawn(process.execPath, ["scripts/boot-check.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  // exit/error는 spawn 직후에 붙여 한 번만 오는 사건을 놓치지 않는다.
  // close는 stdout/stderr를 끝까지 읽은 뒤 오므로 마지막 출력까지 모은다.
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) =>
      resolve({ code: null, signal: null, error })
    );
  });
  let timer;
  try {
    const result = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), runTimeoutMs);
      }),
    ]);
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 이미 끝났다. */
      }
    }
    await exited;
  }
}
