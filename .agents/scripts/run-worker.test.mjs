// run-worker가 worker를 끄는 경로(#255 리뷰 SPEC-1·SPEC-3). 시간 한도(--limit)는 worker 호출 전체의 상한이라 닿으면 다시 띄우지
// 않고 종료 코드 4로 끝난다. 끌 때는 프로세스 그룹 전체가 사라진 것을 확인한 뒤 끝나므로, SIGTERM을 무시하는 하위 명령도 남지 않는다.
// 실제 모델은 부르지 않고, PATH 맨 앞의 가짜 opencode가 세션 없이 멈춰 있다.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/runtime/remove-folder";
import {
  killUnlessGone,
  processAlive,
  withCleanup,
} from "@babojubot/runtime/test-cleanup";

const script = fileURLToPath(new URL("./run-worker.mjs", import.meta.url));

// 가짜 opencode: 띄워질 때마다 한 줄을 남기고, 세션을 알리지 않은 채 멈춰 있다. FAKE_STUBBORN_PID가 있으면 SIGTERM을 무시하는
// 하위 명령을 같은 프로세스 그룹에 띄운다(백그라운드 셸 명령처럼). 하위 명령은 무시를 설치한 뒤에 자기 pid를 그 파일에 남긴다.
// 그 파일이 생긴 뒤의 SIGTERM만 "무시하는 명령"에 닿은 것이다.
const stubbornCommand = [
  "process.on('SIGTERM', () => {});",
  "require('node:fs').writeFileSync(process.env.FAKE_STUBBORN_PID, String(process.pid));",
  "setInterval(() => {}, 1000);",
].join(" ");
const fakeOpencode = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_OPENCODE_LAUNCHES, "launch\\n");
if (process.env.FAKE_STUBBORN_PID)
  spawn(process.execPath, ["-e", ${JSON.stringify(stubbornCommand)}], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;

// run-worker는 worker를 자기 프로세스 그룹(음수 pid)으로 끈다. 가짜 opencode는 PATH의 shebang 스크립트다. 둘 다 POSIX 전용이다.
const posixOnly =
  process.platform === "win32"
    ? "process groups and shebang scripts on PATH are POSIX only"
    : false;

/** 가짜 opencode를 둔 폴더와 run-worker 인수·환경. 시험이 끝나면 남은 하위 명령을 끄고 폴더를 지운다. */
function fixture(defer, { stubborn = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "babojubot-run-worker-"));
  defer(() => removeFolder(dir));
  const fake = path.join(dir, "opencode");
  writeFileSync(fake, fakeOpencode);
  chmodSync(fake, 0o755);
  const launches = path.join(dir, "launches");
  writeFileSync(launches, "");
  const stubbornPid = path.join(dir, "stubborn.pid");
  // 고치기 전처럼 하위 명령이 남으면 시험이 끝날 때 끈다.
  defer(() => {
    if (existsSync(stubbornPid))
      killUnlessGone(Number(readFileSync(stubbornPid, "utf8")));
  });
  return {
    launches,
    stubbornPid,
    args: (limitMinutes) => [
      script,
      "--model",
      "fake/model",
      "--title",
      "limit test",
      "--out",
      path.join(dir, "out.jsonl"),
      "--message",
      "hi",
      "--limit",
      String(limitMinutes),
      // 세션 확인(60초)보다 한도·신호가 먼저 온다.
      "--start-check",
      "60",
    ],
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      FAKE_OPENCODE_LAUNCHES: launches,
      ...(stubborn ? { FAKE_STUBBORN_PID: stubbornPid } : {}),
    },
  };
}

/** `file`이 생길 때까지 다시 보고 그 내용을 돌려준다. 상한이 지나면 무엇을 기다렸는지 밝혀 실패한다. */
function contentOf(file, withinMs) {
  const deadline = Date.now() + withinMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(file)) return resolve(readFileSync(file, "utf8"));
      if (Date.now() > deadline)
        return reject(new Error(`${file} did not appear in ${withinMs}ms`));
      setTimeout(check, 50);
    };
    check();
  });
}

test(
  "a worker that reaches --limit is not launched again and ends with exit code 4",
  { skip: posixOnly },
  async () => {
    await withCleanup(async (defer) => {
      const f = fixture(defer);
      // 한도 1.2초.
      const result = spawnSync(process.execPath, f.args(0.02), {
        encoding: "utf8",
        timeout: 60_000,
        env: f.env,
      });
      assert.equal(result.status, 4, result.stdout + result.stderr);
      assert.match(
        result.stdout,
        /^status: stopped after the 0\.02-minute limit$/m
      );
      assert.match(result.stdout, /^attempts: 1$/m);
      assert.equal(readFileSync(f.launches, "utf8"), "launch\n");
    });
  }
);

test(
  "a worker stopped at --limit leaves no command that ignores SIGTERM",
  { skip: posixOnly },
  async () => {
    await withCleanup(async (defer) => {
      const f = fixture(defer, { stubborn: true });
      // 한도 3초. 하위 명령이 그 전에 SIGTERM 무시를 설치했는지 아래에서 확인한다(아니면 이 시험은 아무것도 보지 못한다).
      const result = spawnSync(process.execPath, f.args(0.05), {
        encoding: "utf8",
        timeout: 60_000,
        env: f.env,
      });
      assert.equal(result.status, 4, result.stdout + result.stderr);
      assert.ok(
        existsSync(f.stubbornPid),
        "the command that ignores SIGTERM was not ready before the limit"
      );
      const stubborn = Number(readFileSync(f.stubbornPid, "utf8"));
      assert.equal(
        processAlive(stubborn),
        false,
        `command ${stubborn} that ignores SIGTERM was left running`
      );
    });
  }
);

test(
  "a runner stopped by a signal leaves no command that ignores SIGTERM",
  { skip: posixOnly },
  async () => {
    await withCleanup(async (defer) => {
      const f = fixture(defer, { stubborn: true });
      // 한도는 길게 둔다. 멈춤은 신호로만 온다.
      const runner = spawn(process.execPath, f.args(10), {
        env: f.env,
        stdio: "ignore",
      });
      const exited = once(runner, "exit");
      defer(async () => {
        killUnlessGone(runner.pid);
        await exited;
      });
      const stubborn = Number(await contentOf(f.stubbornPid, 30_000));
      runner.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 128 + 15);
      assert.equal(
        processAlive(stubborn),
        false,
        `command ${stubborn} that ignores SIGTERM was left running`
      );
    });
  }
);
