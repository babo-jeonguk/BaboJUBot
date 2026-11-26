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
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { psField } from "@babojubot/process";
import { openLifelines } from "@babojubot/process/lifelines";
import { removeFolder } from "@babojubot/process/remove-folder";
import { runTimeoutMs, stopGraceMs } from "./boot-check-limits.mjs";
import {
  folderCleanup,
  killUnlessGone,
  lifelineHolder,
  processAlive as isAlive,
  withCleanup,
  removeFolderWithin,
} from "@babojubot/process/test-cleanup";
import {
  attemptAll,
  attemptEach,
  combinedFailure,
  hasErrorCode,
} from "@babojubot/contracts";

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
    // 다른 프로그램이 쥔 옛 기본 port는 시험이 실패해도 놓아 준다.
    await withCleanup(async (defer) => {
      defer(async () => {
        if (listener)
          await new Promise((resolve, reject) =>
            listener.server.close((error) =>
              error ? reject(error) : resolve(undefined)
            )
          );
      });

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
    });
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
      const unrelatedPid = unrelated.pid;
      assert.ok(
        unrelatedPid !== undefined,
        "the unrelated process did not start"
      );
      const result = await supervise(
        ["scripts/test-fixtures/stuck-run.mjs"],
        { ...process.env, UNRELATED_PID: String(unrelatedPid) },
        { overrunMs: 1_000, graceMs: 500 }
      );
      const output = describe(result);
      const [firstLine] = result.stdout.trim().split("\n");
      assert.ok(firstLine, output);
      const started = JSON.parse(firstLine);
      assert.equal(result.overrun, true, output);
      assert.equal(isAlive(started.inGroup), false, output);
      assert.equal(isAlive(started.escaped), false, output);
      assert.equal(isAlive(unrelatedPid), true, output);
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
    assert.match(
      String(error.cause?.message),
      /stop the Postgres left in the folder: .*EACCES/
    );
    const scope = /could not clean up (\S+)/.exec(error.message)?.[1];
    assert.ok(scope, error.message);
    assert.equal(existsSync(scope), false, `${scope} was not removed`);
  }
);

// 폴더를 쓰는 프로세스가 끝났는지 확인하지 못하면 폴더를 지우지 않는다. 지우면 남은 프로세스와 그 작업 파일의 관계가 끊겨
// 원인을 볼 수 없다. 그룹을 벗어나 폴더 이름을 인수로 들고 도는 프로세스로 만든다(Postgres가 아니라 감독자가 끝내지 않는다).
test(
  "the supervisor keeps the folder and reports it when a process using it does not end",
  {
    timeout: 60_000,
    skip:
      process.platform === "win32" &&
      "Windows finds the folder's processes only through its postmaster.pid files",
  },
  () =>
    withCleanup(async (defer) => {
      // 남긴 프로세스는 자기 번호를 파일에 남긴 뒤 연결을 쥔다. 정리는 그 번호를 연결이 열려 있음을 본 직후에만 신호한다(공용
      // lifelineHolder, 번호는 reportedPid로 읽는다).
      const lifelines = await openLifelines();
      defer(() => lifelines.close());
      const pids = await mkdtemp(path.join(tmpdir(), "boot-check-pids-"));
      // 남긴 프로세스의 끝을 확인한 뒤에만 그 번호 기록(pids)과 감독 대상 폴더(scope, 감독자가 알린 뒤에 안다)를 지운다. 끝을 확인하지
      // 못하면 둘 다 남겨 남은 프로세스를 볼 수 있게 한다(CODING_STANDARDS.md#정리, #292 외부 리뷰 6회차 STD-7).
      /** @type {string | undefined} */
      let scope;
      const folder = folderCleanup(() =>
        attemptAll([
          () => removeFolderWithin(pids),
          async () => {
            if (scope) await removeFolderWithin(scope);
          },
        ])
      );
      defer(folder.cleanUp);
      const escaped = lifelineHolder(
        lifelines,
        "escaped",
        path.join(pids, "escaped")
      );
      folder.own(escaped.end);
      const script = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(`${escaped.code} setInterval(() => {}, 1000);`)}, require("node:os").tmpdir()], {
        detached: true,
        stdio: "ignore",
      }).unref();
    `;
      // 감독자가 알리지 않고 끝나도(폴더를 지웠어도) 남긴 프로세스는 아래에서 끝낸다.
      /** @type {{ result?: Supervised, error?: unknown }} */
      const outcome = await supervise(["-e", script], process.env).then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      const reported =
        outcome.error instanceof Error ? outcome.error : undefined;
      scope = /could not clean up (\S+)/.exec(reported?.message ?? "")?.[1];
      assert.ok(
        reported,
        `the supervisor did not report the running process: ${String(outcome.error)}`
      );
      assert.ok(scope, reported.message);
      assert.ok(reported.cause instanceof Error, reported.message);
      const messages = reported.cause.message;
      assert.match(
        messages,
        /wait for the folder's processes to end: still running/
      );
      assert.ok(messages.includes(`kept ${scope}`), messages);
      assert.equal(existsSync(scope), true, `${scope} was removed`);
    })
);

// 명령줄에 폴더 이름이 없어도, 끝난 실행의 출력 통로를 아직 쥔 프로세스는 그 폴더를 쓰고 있을 수 있다. 출력이 닫힌 것을
// 확인하지 못하면 폴더를 남긴다. 그룹을 벗어나 출력을 물려받고 폴더를 작업 폴더로 쓰는 프로세스로 만든다.
test(
  "the supervisor keeps the folder and reports it when a process still holds the run's output",
  {
    timeout: 60_000,
    skip:
      process.platform === "win32" &&
      "POSIX process groups only; Windows ends the whole tree while the parent is alive",
  },
  () =>
    withCleanup(async (defer) => {
      // 남긴 프로세스는 자기 번호를 파일에 남긴 뒤 연결을 쥔다. 정리는 그 번호를 연결이 열려 있음을 본 직후에만 신호한다(공용
      // lifelineHolder, 번호는 reportedPid로 읽는다).
      const lifelines = await openLifelines();
      defer(() => lifelines.close());
      const pids = await mkdtemp(path.join(tmpdir(), "boot-check-pids-"));
      // 남긴 프로세스의 끝을 확인한 뒤에만 그 번호 기록(pids)과 감독 대상 폴더(scope, 감독자가 알린 뒤에 안다)를 지운다. 끝을 확인하지
      // 못하면 둘 다 남겨 남은 프로세스를 볼 수 있게 한다(CODING_STANDARDS.md#정리, #292 외부 리뷰 6회차 STD-7).
      /** @type {string | undefined} */
      let scope;
      const folder = folderCleanup(() =>
        attemptAll([
          () => removeFolderWithin(pids),
          async () => {
            if (scope) await removeFolderWithin(scope);
          },
        ])
      );
      defer(folder.cleanUp);
      const held = lifelineHolder(lifelines, "held", path.join(pids, "held"));
      folder.own(held.end);
      const script = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(`${held.code} setInterval(() => {}, 1000);`)}], {
        cwd: require("node:os").tmpdir(),
        detached: true,
        stdio: ["ignore", "inherit", "ignore"],
      }).unref();
    `;
      // 감독자가 알리지 않고 끝나도(폴더를 지웠어도) 남긴 프로세스는 아래에서 끝낸다.
      /** @type {{ result?: Supervised, error?: unknown }} */
      const outcome = await supervise(["-e", script], process.env).then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      const reported =
        outcome.error instanceof Error ? outcome.error : undefined;
      scope = /could not clean up (\S+)/.exec(reported?.message ?? "")?.[1];
      assert.ok(
        reported,
        `the supervisor did not report the held output: ${String(outcome.error)}`
      );
      assert.ok(scope, reported.message);
      assert.ok(reported.cause instanceof Error, reported.message);
      assert.ok(
        reported.cause.message.includes(`kept ${scope}`),
        reported.cause.message
      );
      assert.equal(existsSync(scope), true, `${scope} was removed`);
    })
);

const noLeftovers = { folders: [], processes: [] };

/** 부모 셸에 남은 실제 서비스 설정을 흉내 낸다. boot-check는 이것을 서버에 넘기지 않아야 한다. */
function pollutedEnv() {
  /** @type {NodeJS.ProcessEnv} */
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
      server.listen(oldDefaultPort, "127.0.0.1", () => resolve(undefined));
    });
    return { server, requests: () => requests };
  } catch (error) {
    if (hasErrorCode("EADDRINUSE")(error)) return undefined;
    throw error;
  }
}

/**
 * 스크립트를 감독하며 돌린다. 임시 폴더(`TMPDIR` 등)를 이 감독자의 폴더로 정해 넘긴다. POSIX에서는 자기 프로세스 그룹으로 띄운다.
 * `leftBehind`는 스크립트가 끝난 직후 그 폴더에 남은 것, `leftAfterCleanup`은 감독자가 치운 뒤에 남은 것이다.
 * 치우기는 실행이 어떻게 끝났든 따로 시도하고(`attemptEach`), 실패한 단계는 원래 실패와 함께 알린다. 치우기 실패는 그 폴더와
 * 실행 결과를 문구에, 실패한 단계들을 `cause`에 담는다.
 */
/**
 * @typedef {{ folders: string[], processes: string[] }} Leftovers
 * @typedef {{ code: number | null, signal: NodeJS.Signals | null, error?: Error, stdout: string, stderr: string,
 *   overrun: boolean, leftBehind: Leftovers, leftAfterCleanup?: Leftovers }} Supervised
 */
/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {{ overrunMs?: number, graceMs?: number }} [limits]
 * @returns {Promise<Supervised>}
 */
async function supervise(
  args,
  env,
  { overrunMs: limit = overrunMs, graceMs = stopGraceMs } = {}
) {
  const scope = await mkdtemp(path.join(tmpdir(), "boot-check-supervised-"));
  let child;
  /** @type {Supervised | undefined} */
  let result;
  // 띄운 실행의 출력 통로가 닫힌 것을 확인했는가. 띄우지 못했으면 확인할 출력이 없다.
  let outputClosed = true;
  // 실행과 정리를 따로 시도한다. 정리는 실행이 어떻게 끝났든 단계마다 따로 하고, 실패한 단계는 원래 실패와 함께 알린다.
  const failures = await attemptEach([
    async () => {
      child = spawn(process.execPath, args, {
        cwd: root,
        env: { ...env, TMPDIR: scope, TMP: scope, TEMP: scope },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      outputClosed = false;
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      // 끝남은 exit로 본다. spawn 직후에 붙여 한 번만 오는 사건을 놓치지 않는다. close는 stdout/stderr를 끝까지 읽은 뒤
      // 오지만, 끝난 프로세스가 남긴 자식이 출력 통로를 물려받아 잡고 있으면 오지 않는다(그 자식은 남은 것이다).
      const exited = new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) =>
          resolve({ code: null, signal: null, error })
        );
      });
      const closed = new Promise((resolve) => {
        child.once("close", () => resolve(true));
      });
      let exit = await within(exited, limit);
      const overrun = !exit;
      if (!exit) exit = await forceStop(child, exited, graceMs);
      outputClosed = (await within(closed, 5_000)) === true;
      if (!outputClosed) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      result = {
        ...(exit ?? { code: null, signal: null }),
        stdout,
        stderr,
        overrun,
        leftBehind: leftovers(scope, outputClosed),
      };
    },
    async () => {
      const problems = await cleanUpScope(scope, child, outputClosed);
      if (result) result.leftAfterCleanup = leftovers(scope);
      if (problems.length > 0)
        throw new Error(
          `the supervisor could not clean up ${scope}${result ? `\n${describe(result)}` : ""}`,
          { cause: combinedFailure(problems, "cleanup steps failed") }
        );
    },
  ]);
  if (failures.length > 0)
    throw combinedFailure(failures, "the supervised run failed", {
      cause: failures[0],
    });
  if (!result) throw new Error("the supervised run left no result");
  return result;
}

/**
 * 시한을 넘긴 실행을 끝낸다. POSIX: 그룹에 멈춤 요청(SIGTERM) → 여유 → 그룹 강제 종료.
 * Windows에는 협조적인 멈춤 신호가 없고(SIGTERM도 그 프로세스만 강제로 끝낸다) 트리는 부모가 살아 있을 때만 따라갈 수 있으므로,
 * 부모가 살아 있는 동안 트리 전체를 먼저 강제로 끝낸다.
 */
async function forceStop(child, exited, graceMs) {
  if (process.platform === "win32") {
    const failed = killTree(child);
    const exit = await within(exited, 10_000);
    // 끝났으면 taskkill의 실패는 이미 끝난 부모 때문이다. 끝나지 않았으면 그 실패가 원인이다.
    if (failed && !exit)
      throw new Error(`taskkill could not end process ${child.pid}`, {
        cause: failed,
      });
    return exit;
  }
  signalGroup(child, "SIGTERM");
  const exit = await within(exited, graceMs);
  if (exit) return exit;
  signalGroup(child, "SIGKILL");
  return within(exited, 10_000);
}

/**
 * 정상으로 끝났어도 남은 것을 치운다. 단계마다 따로 시도하고 실패한 단계를 모아 돌려준다.
 * 폴더는 그 폴더를 쓰는 프로세스가 모두 끝난 것을 확인했을 때만 지운다. 확인하지 못하면 폴더를 남기고 그 사실을 알린다.
 * 끝난 실행의 출력 통로를 아직 누가 쥐고 있으면(`outputClosed`가 거짓) 명령줄에 폴더가 없어도 그 폴더를 쓰는 중일 수 있어 남긴다.
 * Postgres 멈추기가 실패해도 남은 프로세스는 마지막 확인이 따로 보므로, 그 실패만으로 폴더를 남기지 않는다.
 */
async function cleanUpScope(scope, child, outputClosed) {
  /** 단계 이름을 붙여 던지는 정리 단계. 실패는 `attemptEach`가 모은다. */
  const step = (what, work) => async () => {
    try {
      await work();
    } catch (error) {
      throw new Error(
        `${what}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  };
  // POSIX에서 그룹에 남은 자식. Windows는 트리를 부모가 살아 있을 때만 따라갈 수 있어 forceStop에서 끝냈다.
  let groupStopped = !child || process.platform === "win32";
  let ended = false;
  const problems = await attemptEach([
    ...(groupStopped
      ? []
      : [
          step("stop the process group", () => {
            signalGroup(child, "SIGKILL");
            groupStopped = true;
          }),
        ]),
    step("stop the Postgres left in the folder", () => stopPostmasters(scope)),
    step("wait for the folder's processes to end", async () => {
      if (!(await waitUntil(() => runningIn(scope).length === 0, 10_000)))
        throw new Error(`still running: ${runningIn(scope).join("; ")}`);
      ended = true;
    }),
  ]);
  if (groupStopped && ended && outputClosed)
    problems.push(
      ...(await attemptEach([
        step("remove the folder", () => removeFolder(scope)),
      ]))
    );
  else
    problems.push(
      new Error(
        outputClosed
          ? `kept ${scope}: its processes were not confirmed to have ended`
          : `kept ${scope}: a process still holds the run's output`
      )
    );
  return problems;
}

/** 그 폴더에 남은 것. 끝난 실행의 출력 통로를 아직 누가 잡고 있으면 그것도 남은 프로세스다. */
function leftovers(scope, outputClosed = true) {
  return {
    folders: existsSync(scope) ? readdirSync(scope) : [],
    processes: [
      ...runningIn(scope),
      ...(outputClosed ? [] : ["a process still holds the run's output"]),
    ],
  };
}

/** POSIX 프로세스 그룹 전체에 신호를 보낸다. 그룹이 이미 없으면 넘어간다. */
function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!hasErrorCode("ESRCH")(error)) throw error;
  }
}

/**
 * Windows에서 살아 있는 부모부터 프로세스 트리 전체를 강제로 끝낸다. taskkill이 실패하면 그 오류를 돌려준다. 그 사이 부모가 끝나서도
 * 실패하므로, 이미 끝난 것인지는 부르는 쪽이 끝(exit)을 보고 가린다(오류 글이나 종료 코드로 짐작하지 않는다).
 */
function killTree(child) {
  if (child.pid === undefined) return undefined;
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * 폴더 안의 postmaster.pid가 가리키는 Postgres를 멈춘다. pg_ctl이 띄운 Postgres는 자기 세션을 만들어 그룹을 벗어난다.
 * pid는 재사용될 수 있으므로 신호마다 바로 앞에서 그 프로세스의 명령줄에 이 감독자의 폴더가 있는지 보고(보기와 신호 사이에 기다림을
 * 두지 않는다), 끝남도 번호가 아니라 그 번호의 명령줄에 이 폴더가 더는 없음으로 본다(POSIX). SIGQUIT 뒤 기다리는 동안 그 번호가
 * 다른 프로세스에 다시 쓰였으면 SIGKILL을 보내지 않는다. Windows는 명령줄을 싸게 확인할 수 없어 신호를 보내지 않는다. 그 Postgres가
 * 살아 있으면 남은 것으로 드러난다. pid마다 따로 시도한다. 한 pid의 신호나 조회가 실패해도 다른 pid를 멈추고, 그 실패를 함께 알린다.
 * 명령줄 조회는 세 갈래다: 이 폴더의 것, 확인된 아님(그 번호의 프로세스가 없거나 다른 명령줄), 확인 실패(던진다). 조회 실패를 "우리
 * 것 아님"이나 "끝남"으로 접지 않는다(공용 psField, #292 외부 리뷰 3회차 STD-4). SIGKILL 뒤에도 시한 안에 끝나지 않으면 실패한다.
 */
async function stopPostmasters(scope) {
  if (process.platform === "win32") return;
  await attemptAll(
    postmasterPids(scope).map((pid) => async () => {
      const ours = () => psField(pid, "args", 10_000)?.includes(scope) === true;
      /** @type {NodeJS.Signals[]} */
      const signals = ["SIGQUIT", "SIGKILL"];
      for (const signal of signals) {
        if (!ours() || !killUnlessGone(pid, signal)) return;
        if (await waitUntil(() => !ours(), 10_000)) return;
      }
      throw new Error(
        `postmaster ${pid} of ${scope} did not end within 10000 ms after SIGKILL`
      );
    })
  );
}

/** 폴더 안 postmaster.pid들이 가리키는 pid. 그 사이 지워진 파일은 넘어간다. 살아 있는지는 쓰는 쪽이 pid마다 본다. */
function postmasterPids(scope) {
  const pids = [];
  for (const file of findFiles(scope, "postmaster.pid")) {
    let pid;
    try {
      pid = Number(readFileSync(file, "utf8").split("\n")[0]);
    } catch (error) {
      if (hasErrorCode("ENOENT")(error)) continue;
      throw error;
    }
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

function findFiles(dir, name) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * 그 폴더를 쓰는 살아 있는 프로세스. POSIX는 명령줄에 그 폴더가 있는 프로세스(그 폴더의 postmaster 등)다.
 * Windows는 명령줄을 싸게 볼 수 없어 그 폴더의 postmaster.pid가 가리키는 살아 있는 프로세스로 본다(쓰는 중인 폴더는 지울 수도 없다).
 */
function runningIn(folder) {
  if (process.platform === "win32")
    return existsSync(folder)
      ? postmasterPids(folder)
          .filter(isAlive)
          .map((pid) => `postmaster ${pid}`)
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

/**
 * `check`가 `ms` 안에 참이 되면 true, 아니면 false. 남은 프로세스처럼 종료를 알릴 수단이 없는 상태를 다시 확인한다.
 * 첫 확인은 바로 하고, 거짓일 때만 50ms 뒤 다시 확인한다. 무엇이 남았는지는 부른 쪽이 알린다. node:test에는 조건 대기가 없어 직접 둔다.
 */
function waitUntil(check, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (check()) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(poll, 50);
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}
