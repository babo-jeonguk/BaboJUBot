// run-worker가 worker를 끄는 경로(#255 리뷰 SPEC-1·SPEC-3, #262). 시간 한도(--limit)는 worker 호출 전체의 상한이라 닿으면 다시
// 띄우지 않고 종료 코드 4로 끝난다. worker는 제품의 공용 실행으로 띄우고 그 트리의 끄기로 끝내므로, SIGTERM을 무시하는 하위 명령도,
// 새 세션으로 빠져나간 명령도, Windows에서 대표가 먼저 끝나 남은 명령도 남지 않는다. 남았는지는 번호(pid)가 아니라 그 명령이 쥔
// 연결로 본다(번호는 재사용된다, #259).
// 실제 모델은 부르지 않고, PATH 맨 앞의 가짜 opencode가 세션 없이 멈춰 있다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openLifelines } from "@babojubot/process/lifelines";
import { removeFolder } from "@babojubot/process/remove-folder";
import { killUnlessGone, withCleanup } from "@babojubot/process/test-cleanup";

const script = fileURLToPath(new URL("./run-worker.mjs", import.meta.url));
const windows = process.platform === "win32";

// 가짜 opencode: 띄워질 때마다 한 줄을 남기고, 세션을 알리지 않은 채 멈춰 있다. 하위 명령을 띄우라는 환경이 있으면 띄운다.
// - FAKE_STUBBORN: SIGTERM을 무시하는 명령을 같은 그룹에 띄운다(백그라운드 셸 명령처럼).
// - FAKE_MOVED: 새 세션(detached)으로 그룹을 빠져나가는 명령을 띄운다(Claude Code·Codex의 셸 명령처럼, #219).
// 각 명령은 받은 코드로 시험의 연결을 쥐고(그 코드를 실행한 뒤에야 무시를 설치한 것이다), 자기 번호를 파일에 남긴다(실패한 시험의
// 정리용. 연결이 열려 있을 때만 그 번호로 끈다).
const fakeOpencode = `import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_OPENCODE_LAUNCHES, "launch\\n");
const command = (code, pidFile) =>
  \`process.on("SIGTERM", () => {}); \${code} require("node:fs").writeFileSync(\${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\`;
if (process.env.FAKE_STUBBORN)
  spawn(process.execPath, ["-e", command(process.env.FAKE_STUBBORN, process.env.FAKE_STUBBORN_PID)], { stdio: "ignore" });
if (process.env.FAKE_MOVED)
  spawn(process.execPath, ["-e", command(process.env.FAKE_MOVED, process.env.FAKE_MOVED_PID)], { stdio: "ignore", detached: true }).unref();
setInterval(() => {}, 1000);
`;

/**
 * 가짜 opencode를 둔 폴더와 run-worker 인수·환경. POSIX는 PATH의 shebang 스크립트, Windows는 그 스크립트를 부르는 .cmd다.
 * 시험이 끝나면 남은 하위 명령을 끄고 폴더를 지운다.
 */
async function fixture(defer, { stubborn = false, moved = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "babojubot-run-worker-"));
  defer(() => removeFolder(dir));
  const lifelines = await openLifelines();
  defer(() => lifelines.close());
  writeFileSync(path.join(dir, "opencode.mjs"), fakeOpencode);
  if (windows)
    writeFileSync(
      path.join(dir, "opencode.cmd"),
      `@"${process.execPath}" "%~dp0opencode.mjs" %*\r\n`
    );
  else {
    writeFileSync(
      path.join(dir, "opencode"),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "opencode.mjs")}" "$@"\n`
    );
    chmodSync(path.join(dir, "opencode"), 0o755);
  }
  const launches = path.join(dir, "launches");
  writeFileSync(launches, "");
  const commands = { stubborn, moved };
  const env = {
    ...process.env,
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    FAKE_OPENCODE_LAUNCHES: launches,
  };
  for (const [name, wanted] of Object.entries(commands)) {
    if (!wanted) continue;
    const key = `FAKE_${name.toUpperCase()}`;
    const pidFile = path.join(dir, `${name}.pid`);
    env[key] = lifelines.hold(name);
    env[`${key}_PID`] = pidFile;
    // 고치기 전처럼 명령이 남으면 시험이 끝날 때 끈다. 연결이 열려 있으면 그 번호의 프로세스는 아직 그 명령이다.
    defer(() => {
      if (lifelines.names().includes(name) && lifelines.open(name))
        killUnlessGone(Number(readFileSync(pidFile, "utf8")));
    });
  }
  return {
    launches,
    lifelines,
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
    env,
  };
}

/** run-worker를 띄운다. 시험이 먼저 실패해도 정리가 끄고 끝나기를 기다린다. */
function runner(defer, f, limitMinutes) {
  const child = spawn(process.execPath, f.args(limitMinutes), {
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = once(child, "exit");
  // 띄우지 못했으면 끌 프로세스가 없고, `exited`가 그 실패로 거절한다.
  defer(async () => {
    if (child.pid !== undefined) killUnlessGone(child.pid);
    await exited;
  });
  return {
    child,
    output: () => output,
    exited: exited.then(([code]) => code),
  };
}

test("a worker that reaches --limit is not launched again and ends with exit code 4", async () => {
  await withCleanup(async (defer) => {
    const f = await fixture(defer);
    // 한도 1.2초.
    const run = runner(defer, f, 0.02);
    assert.equal(await run.exited, 4, run.output());
    assert.match(
      run.output(),
      /^status: stopped after the 0\.02-minute limit$/m
    );
    assert.match(run.output(), /^attempts: 1$/m);
    assert.equal(readFileSync(f.launches, "utf8"), "launch\n");
  });
});

test("a worker stopped at --limit leaves no command that ignores SIGTERM", async () => {
  await withCleanup(async (defer) => {
    const f = await fixture(defer, { stubborn: true });
    // 한도 6초. 명령이 그 전에 연결을 쥐었는지(무시를 설치했는지) 본다. 아니면 이 시험은 아무것도 보지 못한다.
    const run = runner(defer, f, 0.1);
    await f.lifelines.connected("stubborn", 6_000);
    assert.equal(await run.exited, 4, run.output());
    await f.lifelines.closed("stubborn", 2_000);
  });
});

test("a worker stopped at --limit leaves no command that moved to a new session", async () => {
  await withCleanup(async (defer) => {
    const f = await fixture(defer, { moved: true });
    const run = runner(defer, f, 0.1);
    await f.lifelines.connected("moved", 6_000);
    assert.equal(await run.exited, 4, run.output());
    await f.lifelines.closed("moved", 2_000);
  });
});

// Windows는 runner가 받아 처리할 수 있는 신호를 보낼 수 없다(신호는 곧 강제 종료다).
test(
  "a runner stopped by a signal leaves no command that ignores SIGTERM",
  { skip: windows ? "Windows cannot send a signal the runner handles" : false },
  async () => {
    await withCleanup(async (defer) => {
      const f = await fixture(defer, { stubborn: true });
      // 한도는 길게 둔다. 멈춤은 신호로만 온다.
      const run = runner(defer, f, 10);
      await f.lifelines.connected("stubborn", 30_000);
      run.child.kill("SIGTERM");
      assert.equal(await run.exited, 128 + 15, run.output());
      await f.lifelines.closed("stubborn", 2_000);
    });
  }
);

// runner가 강제로 끝나도 감독 실행기가 제어 통로의 끝을 보고 worker의 트리(Linux·macOS는 그룹, Windows는 묶음)를 끈다(#268). 세 OS가
// 같다. 새 세션으로 나간 명령은 아직 이 길에 닿지 않는다(제품의 재시작 복구가 표식으로 끈다).
test("a runner that is killed leaves no worker", async () => {
  await withCleanup(async (defer) => {
    const f = await fixture(defer, { stubborn: true });
    const run = runner(defer, f, 10);
    await f.lifelines.connected("stubborn", 30_000);
    run.child.kill("SIGKILL");
    await run.exited;
    await f.lifelines.closed("stubborn", 15_000);
  });
});
