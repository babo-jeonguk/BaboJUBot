// run-worker가 worker를 끄는 경로(#255 리뷰 SPEC-1·SPEC-3, #262). 시간 한도(--limit)는 worker 호출 전체의 상한이라 닿으면 다시
// 띄우지 않고 종료 코드 4로 끝난다. worker는 제품의 공용 실행으로 띄우고 그 트리의 끄기로 끝내므로, SIGTERM을 무시하는 하위 명령도,
// 새 세션으로 빠져나간 명령도, Windows에서 대표가 먼저 끝나 남은 명령도 남지 않는다. 남았는지는 번호(pid)가 아니라 그 명령이 쥔
// 연결로 본다(번호는 재사용된다, #259).
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
// - FAKE_SKIP_INPUT: 쉼표로 적은 몇 번째 띄움(1부터)에서는 표준 입력을 읽지 않고 곧바로 끝난다(지침을 읽기 전에 끝난 worker).
// - FAKE_SESSION: 표준 입력을 끝까지 읽은 뒤 세션을 알리고 끝난다(일을 마친 worker).
const fakeOpencode = `import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.env.FAKE_OPENCODE_LAUNCHES, "launch\\n");
const launch = readFileSync(process.env.FAKE_OPENCODE_LAUNCHES, "utf8").split("\\n").filter(Boolean).length;
if ((process.env.FAKE_SKIP_INPUT ?? "").split(",").includes(String(launch))) process.exit(0);
// opencode run처럼 인수에 지침이 없으면 표준 입력 전체를 지침으로 읽는다. 받은 인수와 표준 입력을 한 줄(JSON)로 남긴다.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  appendFileSync(process.env.FAKE_OPENCODE_CALLS, JSON.stringify({ args: process.argv.slice(2), input }) + "\\n");
  // 남긴 뒤 시험의 연결을 쥐어 남겼음을 알린다(FAKE_RECORDED는 그 연결을 쥐는 문장이다).
  if (process.env.FAKE_RECORDED) (0, eval)(process.env.FAKE_RECORDED);
  if (process.env.FAKE_SESSION) {
    console.log(JSON.stringify({ type: "step_start", sessionID: "ses_fake" }));
    process.exit(0);
  }
});
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
async function fixture(
  defer,
  {
    stubborn = false,
    moved = false,
    recorded = false,
    skipInput = "",
    session = false,
  } = {}
) {
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
  // 띄워질 때마다 받은 인수와 표준 입력(지침)을 한 줄(JSON)로 남긴다.
  const calls = path.join(dir, "calls");
  writeFileSync(calls, "");
  const commands = { stubborn, moved };
  const env = {
    ...process.env,
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    FAKE_OPENCODE_LAUNCHES: launches,
    FAKE_OPENCODE_CALLS: calls,
    ...(recorded ? { FAKE_RECORDED: lifelines.hold("recorded") } : {}),
    ...(skipInput ? { FAKE_SKIP_INPUT: skipInput } : {}),
    ...(session ? { FAKE_SESSION: "1" } : {}),
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
    dir,
    launches,
    calls,
    lifelines,
    /** 지침 인수. 주지 않으면 `--message hi`다. */
    args: (limitMinutes, brief = ["--message", "hi"]) => [
      script,
      "--model",
      "fake/model",
      "--title",
      "limit test",
      "--out",
      path.join(dir, "out.jsonl"),
      ...brief,
      "--limit",
      String(limitMinutes),
      // 세션 확인(60초)보다 한도·신호가 먼저 온다.
      "--start-check",
      "60",
    ],
    env,
  };
}

/**
 * run-worker를 띄운다. 시험이 먼저 실패해도 정리가 끄고 끝나기를 기다린다.
 * @param {string[]} [brief] 지침 인수(`--brief <파일>`이나 `--message <글>`). 주지 않으면 `--message hi`다.
 */
function runner(defer, f, limitMinutes, brief) {
  const child = spawn(process.execPath, f.args(limitMinutes, brief), {
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

// 인수를 확인하지 못하면 아무것도 띄우지 않고 사용법과 함께 종료 코드 1로 끝난다. 인수는 Map에 받고(#284), 정한 이름만 받는다:
// 모든 객체가 물려받는 이름(--constructor)도 모르는 인수다(#281 리뷰 REC-1과 같은 모양). 같은 인수를 두 번 주면 어느 값을 쓸지
// 정하지 않고 거절한다. PATH를 비워 확인을 지나가더라도 opencode를 띄울 수 없게 한다.
test("a runner refuses missing, repeated, conflicting and unknown arguments before it starts anything", (context) => {
  const dir = mkdtempSync(path.join(tmpdir(), "babojubot-run-worker-args-"));
  context.after(() => removeFolder(dir));
  const out = path.join(dir, "out.jsonl");
  const brief = path.join(dir, "brief.md");
  writeFileSync(brief, "brief\n");
  const base = ["--model", "fake/model", "--title", "t", "--out", out];
  /** @type {[string, string[], RegExp][]} 경우, 인수, 알리는 문구 */
  const cases = [
    [
      "no --out",
      ["--model", "m", "--title", "t", "--message", "hi"],
      /^--model, --title and --out are required$/m,
    ],
    [
      "a name without a value",
      [...base, "--message"],
      /^bad argument: --message$/m,
    ],
    [
      "both --brief and --message",
      [...base, "--brief", brief, "--message", "hi"],
      /^give exactly one of --brief and --message$/m,
    ],
    [
      "neither --brief nor --message",
      base,
      /^give exactly one of --brief and --message$/m,
    ],
    [
      "a missing brief file",
      [...base, "--brief", path.join(dir, "missing.md")],
      /^brief not found: .*missing\.md$/m,
    ],
    [
      "a repeated argument",
      [...base, "--message", "a", "--message", "b"],
      /^--message given twice$/m,
    ],
    [
      "an unknown argument",
      [...base, "--message", "hi", "--nope", "x"],
      /^bad argument: --nope$/m,
    ],
    ...["constructor", "toString", "__proto__", "hasOwnProperty"].map(
      /** @returns {[string, string[], RegExp]} */
      (name) => [
        `the inherited name ${name}`,
        [...base, "--message", "hi", `--${name}`, "x"],
        new RegExp(`^bad argument: --${name}$`, "m"),
      ]
    ),
  ];
  for (const [shape, args, message] of cases) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      killSignal: "SIGKILL",
      env: { ...process.env, PATH: "" },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 1, `${shape}: ${result.stderr}`);
    assert.match(result.stderr, message, shape);
    assert.match(result.stderr, /^usage: run-worker\.mjs /m, shape);
    assert.equal(existsSync(out), false, `${shape}: started a worker`);
  }
});

// 지침은 명령 인수가 아니라 표준 입력으로 간다(#284). Windows의 .cmd(npm으로 설치한 opencode, 이 시험의 가짜)는 cmd.exe가 띄우고
// cmd.exe는 인수를 첫 줄바꿈에서 끊어, 여러 줄 지침이 첫 줄만 닿았다. 그래서 여러 줄 지침이 세 OS 모두 그대로 닿는지와 인수에
// 지침이 없는지를 `--brief`(한 번 읽은 파일 내용)와 `--message` 둘 다 본다.
test("a runner sends a multi-line brief on the worker's standard input, not as an argument", async () => {
  const text = '첫 줄\n둘째 줄\n\n  들여 쓴 줄 "따옴표" & | %PATH%\n';
  await withCleanup(async (defer) => {
    for (const kind of ["--brief", "--message"]) {
      const f = await fixture(defer, { recorded: true });
      const brief = path.join(f.dir, "brief.md");
      writeFileSync(brief, text);
      const args = kind === "--brief" ? [kind, brief] : [kind, text];
      // 한도 6초. 가짜는 표준 입력의 끝까지 읽어 남긴 뒤 연결로 알린다.
      const run = runner(defer, f, 0.1, args);
      await f.lifelines.connected("recorded", 30_000);
      assert.equal(await run.exited, 4, run.output());
      const calls = readFileSync(f.calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        calls,
        [
          {
            args: [
              "run",
              "--agent",
              "dev-worker",
              "--standalone",
              "--auto",
              "--format",
              "json",
              "-m",
              "fake/model",
              "--title",
              "limit test",
            ],
            input: text,
          },
        ],
        `${kind}: ${run.output()}`
      );
    }
  });
});

// 파이프 버퍼보다 훨씬 큰 지침(8MB)을 읽지 않고 곧바로 끝나는 worker에 보내면 쓰기는 상대가 닫혀 반드시 실패한다(EPIPE 등). 지침을
// 못 보낸 것은 모델의 오류 이벤트(종료 코드 2, 다음 모델로)가 아니라 실행 실패라 이유와 함께 종료 코드 4로 끝난다(#284 리뷰).
const bigBrief = "지침 한 줄입니다.\n".repeat(400_000);

test("a runner whose brief cannot be sent ends with exit code 4 and the reason, not as an error event", async () => {
  await withCleanup(async (defer) => {
    const f = await fixture(defer, { skipInput: "1,2" });
    const brief = path.join(f.dir, "brief.md");
    writeFileSync(brief, bigBrief);
    const run = runner(defer, f, 10, ["--brief", brief]);
    assert.equal(await run.exited, 4, run.output());
    assert.match(run.output(), /^status: could not send the brief: \S+$/m);
    assert.match(run.output(), /^attempts: 2$/m);
    assert.match(run.output(), /^errors: -$/m);
  });
});

// 보내기 실패는 그 시도에 묶인다. 첫 시도가 지침을 읽지 않고 끝나 다시 띄운 둘째 시도가 지침을 끝까지 읽고 세션을 알리고 마치면,
// 호출은 첫 시도의 실패 없이 마친다.
test("a runner whose first attempt could not take the brief finishes when the second attempt takes it", async () => {
  await withCleanup(async (defer) => {
    const f = await fixture(defer, { skipInput: "1", session: true });
    const brief = path.join(f.dir, "brief.md");
    writeFileSync(brief, bigBrief);
    const run = runner(defer, f, 10, ["--brief", brief]);
    assert.equal(await run.exited, 0, run.output());
    assert.match(run.output(), /^status: finished$/m);
    assert.match(run.output(), /^attempts: 2$/m);
    assert.match(run.output(), /^errors: -$/m);
    const calls = readFileSync(f.calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, bigBrief);
  });
});

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
