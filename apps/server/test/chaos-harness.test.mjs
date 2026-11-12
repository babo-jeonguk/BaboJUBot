// 실모델 장애 검사(scripts/chaos-live.mjs)의 자동 검사. 실제 모델은 부르지 않는다.
// 실행 허용 차단, 예산 제한, 결과 판정, 증거 검사, 그리고 가짜 연결·임시 홈·임시 DB로 강제 종료·시간 초과·중단 뒤 정리를 본다.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LaunchRefused,
  claimLiveRun,
  createLedger,
  gateConnection,
  maxOverlap,
  parseLaunch,
  writeBudget,
} from "../../../scripts/live/chaos-budget.mjs";
import {
  exitCodeOf,
  runChaos,
  sanitizeEvidence,
  writeEvidence,
} from "../../../scripts/live/chaos-run.mjs";
import {
  check,
  judgeConcurrency,
  judgeRestart,
  sceneOutcome,
  sceneTools,
  scenes,
  steerKillChecks,
} from "../../../scripts/live/chaos-scenes.mjs";
import {
  chaosEnvironment,
  chaosServer,
  scrubEnvironment,
} from "../../../scripts/live/chaos-server.mjs";

const ids = scenes.map((s) => s.id);
const launchAll = { scenes: ids, maxLiveRuns: 24 };
const sceneById = (id) => scenes.find((s) => s.id === id);

/** 이 홈의 내장 Postgres 프로세스가 남았는지. */
const postgresAlive = (home) => {
  try {
    execFileSync("pgrep", ["-f", `${home}/postgres`]);
    return true;
  } catch {
    return false;
  }
};

describe("chaos harness launch", () => {
  it("refuses live calls without --allow-live, in CI, with --record, and with a bad budget or scene", () => {
    const refused = (argv, env = {}) => {
      expect(() => parseLaunch(argv, env, ids)).toThrow(LaunchRefused);
    };
    refused([]);
    refused(["--scenes=a"]);
    refused(["--allow-live"], { CI: "true" });
    refused(["--allow-live"], { GITHUB_ACTIONS: "true" });
    refused(["--allow-live", "--record"]);
    refused(["--allow-live", "--scenes=z"]);
    for (const value of ["0", "25", "-1", "1.5", "abc", "2e1"])
      refused(["--allow-live"], { BABOJUBOT_CHAOS_MAX_LIVE_RUNS: value });
    // 비용을 확인할 수 없는 모델은 고르지 못한다. 제품의 무료 모델 선택만 쓴다.
    refused(["--allow-live"], { BABOJUBOT_CHAOS_MODEL: "opencode/some-model" });
    refused(["--allow-live"], {
      BABOJUBOT_CHAOS_ALT_MODEL: "opencode/other-model",
    });
  });

  it("accepts an explicit permission with a budget up to 24 and keeps the scene order", () => {
    expect(parseLaunch(["--allow-live"], { CI: "false" }, ids)).toMatchObject({
      scenes: ids,
      maxLiveRuns: 24,
    });
    expect(
      parseLaunch(
        ["--allow-live", "--scenes=c,a"],
        { BABOJUBOT_CHAOS_MAX_LIVE_RUNS: "10" },
        ids
      )
    ).toMatchObject({ scenes: ["a", "c"], maxLiveRuns: 10 });
  });
});

describe("chaos harness environment", () => {
  const env = {
    PATH: "/bin",
    HOME: "/home/owner",
    LANG: "C.UTF-8",
    HTTPS_PROXY: "http://proxy",
    NODE_EXTRA_CA_CERTS: "/ca.pem",
    TMPDIR: "/tmp",
    OPENAI_API_KEY: "sk-owner",
    BABOJUBOT_OPENCODE_PASS_ENV: "OPENAI_API_KEY",
    BABOJUBOT_OPENCODE_COMMAND: "/other/opencode",
    BABOJUBOT_PROVIDERS: "claude",
    DATABASE_URL: "postgres://owner",
    GH_TOKEN: "ghp-owner",
  };
  const kept = {
    PATH: "/bin",
    LANG: "C.UTF-8",
    HTTPS_PROXY: "http://proxy",
    NODE_EXTRA_CA_CERTS: "/ca.pem",
    TMPDIR: "/tmp",
  };

  it("gives the server only network, certificate, locale and temp settings, never product settings or credentials", () => {
    expect(chaosEnvironment(env, "/tmp/home")).toEqual({
      ...kept,
      HOME: "/tmp/home",
      BABOJUBOT_HOME: "/tmp/home",
    });
  });

  it("scrubs the harness's own environment the same way before the preflight", () => {
    const own = { ...env };
    expect(scrubEnvironment(own)).toBe(own);
    expect(own).toEqual({ ...kept, HOME: "/home/owner" });
  });
});

describe("chaos harness budget gate", () => {
  async function gated(budget, readiness = { status: "ready", reason: null }) {
    const dir = await mkdtemp(path.join(tmpdir(), "chaos-gate-"));
    const files = {
      ledgerFile: path.join(dir, "ledger.jsonl"),
      budgetFile: path.join(dir, "budget.json"),
      tokenDir: dir,
      controlFile: path.join(dir, "control.json"),
    };
    writeBudget(files.budgetFile, budget);
    const seen = [];
    const connection = gateConnection(
      {
        id: "live",
        adapter: {
          capabilities: {},
          checkReadiness: async () => readiness,
          async execute(request) {
            const file = path.join(dir, `${request.identity.runId}.token`);
            seen.push({
              token: await readFile(file, "utf8"),
              mode: statSync(file).mode & 0o777,
            });
            return {
              stopReason: "completed",
              error: null,
              summary: null,
              usage: null,
              nextSession: null,
            };
          },
        },
      },
      { live: true, brief: "brief", ...files }
    );
    const run = (n, signal = new AbortController().signal) =>
      connection.adapter.execute(
        {
          identity: { runId: `run-${n}` },
          access: { token: `token-${n}` },
          instructions: [],
          context: {},
          previousSession: null,
          wakeReasons: [],
          model: null,
        },
        { signal, emit: async () => {} }
      );
    return { dir, run, seen, ledger: createLedger(files.ledgerFile) };
  }

  it("starts no live run beyond the total budget and keeps the token in a 0600 file only while it runs", async () => {
    const g = await gated({
      scene: "a",
      maxLiveRuns: 2,
      sceneMaxRuns: 4,
      deadlineAt: Date.now() + 60_000,
    });
    const results = [await run(g, 1), await run(g, 2), await run(g, 3)];
    expect(g.seen).toEqual([
      { token: "token-1", mode: 0o600 },
      { token: "token-2", mode: 0o600 },
    ]);
    expect(results.map((r) => r.stopReason)).toEqual([
      "completed",
      "completed",
      "failed",
    ]);
    expect(existsSync(path.join(g.dir, "run-1.token"))).toBe(false);
    expect(g.ledger.read().map((e) => [e.kind, e.reason ?? null])).toEqual([
      ["claim", null],
      ["end", null],
      ["claim", null],
      ["end", null],
      ["refused", "run_limit"],
    ]);
    await rm(g.dir, { recursive: true, force: true });
  });

  it("refuses by the scene budget and after the deadline before starting", async () => {
    const g = await gated({
      scene: "a",
      maxLiveRuns: 24,
      sceneMaxRuns: 1,
      deadlineAt: Date.now() + 60_000,
    });
    await run(g, 1);
    await run(g, 2);
    expect(g.seen).toHaveLength(1);
    const ledger = g.ledger;
    expect(
      claimLiveRun(
        ledger,
        {
          scene: "b",
          maxLiveRuns: 24,
          sceneMaxRuns: 4,
          deadlineAt: Date.now() - 1,
        },
        { runId: "x", connection: "live", now: Date.now() }
      )
    ).toEqual({ ok: false, reason: "time_limit" });
    expect(
      claimLiveRun(ledger, null, {
        runId: "y",
        connection: "live",
        now: Date.now(),
      })
    ).toEqual({ ok: false, reason: "no_budget" });
    expect(
      ledger
        .read()
        .filter((e) => e.kind === "refused")
        .map((e) => e.reason)
    ).toEqual(["scene_run_limit", "time_limit", "no_budget"]);
    await rm(g.dir, { recursive: true, force: true });
  });

  it("starts no live run while no free model is confirmed", async () => {
    const g = await gated(
      {
        scene: "a",
        maxLiveRuns: 24,
        sceneMaxRuns: 4,
        deadlineAt: Date.now() + 60_000,
      },
      { status: "unknown", reason: "credentials_unverified" }
    );
    expect((await run(g, 1)).stopReason).toBe("failed");
    expect(g.seen).toEqual([]);
    expect(g.ledger.read().map((e) => [e.kind, e.reason ?? null])).toEqual([
      ["refused", "no_free_model"],
    ]);
    await rm(g.dir, { recursive: true, force: true });
  });

  it("ends a run cancelled during the free-model check as cancelled, not as a refusal", async () => {
    // 서버 재시작 장면은 다시 대기한 깨우기를 받은 실행을 확인하자마자 중단한다. 그 중단이 준비 확인 중에 오면
    // 확인은 실패로 돌아오지만, 그것은 비용 경계의 거절이 아니라 시작 전 취소다.
    const dir = await mkdtemp(path.join(tmpdir(), "chaos-gate-"));
    const files = {
      ledgerFile: path.join(dir, "ledger.jsonl"),
      budgetFile: path.join(dir, "budget.json"),
      tokenDir: dir,
      controlFile: path.join(dir, "control.json"),
    };
    writeBudget(files.budgetFile, {
      scene: "b",
      maxLiveRuns: 24,
      sceneMaxRuns: 4,
      deadlineAt: Date.now() + 60_000,
    });
    const controller = new AbortController();
    let executed = false;
    const connection = gateConnection(
      {
        id: "live",
        adapter: {
          capabilities: {},
          async checkReadiness(signal) {
            controller.abort({ type: "cancel", reason: "owner_interrupt" });
            return signal.aborted
              ? { status: "not_ready", reason: "check_failed" }
              : { status: "ready", reason: null };
          },
          async execute() {
            executed = true;
            throw new Error("must not start");
          },
        },
      },
      { live: true, brief: "brief", ...files }
    );
    const result = await connection.adapter.execute(
      {
        identity: { runId: "run-1" },
        access: { token: "token-1" },
        instructions: [],
        context: {},
        previousSession: null,
        wakeReasons: [],
        model: null,
      },
      { signal: controller.signal, emit: async () => {} }
    );
    expect(result.stopReason).toBe("cancelled");
    expect(executed).toBe(false);
    expect(
      createLedger(files.ledgerFile)
        .read()
        .map((e) => e.kind)
    ).toEqual(["cancelled_before_start"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("ends a run cancelled before it reaches the gate as cancelled even while a ready result is reused", async () => {
    // 준비됨 결과를 60초 다시 쓰는 동안에도 이미 취소된 실행은 예산을 쓰지 않고 시작 전 취소로 끝난다.
    const g = await gated({
      scene: "a",
      maxLiveRuns: 24,
      sceneMaxRuns: 4,
      deadlineAt: Date.now() + 60_000,
    });
    expect((await run(g, 1)).stopReason).toBe("completed");
    const cancelled = new AbortController();
    cancelled.abort({ type: "cancel", reason: "owner_interrupt" });
    const result = await g.run(2, cancelled.signal);
    expect(result.stopReason).toBe("cancelled");
    expect(g.seen).toHaveLength(1);
    expect(g.ledger.read().map((e) => e.kind)).toEqual([
      "claim",
      "end",
      "cancelled_before_start",
    ]);
    await rm(g.dir, { recursive: true, force: true });
  });

  const run = (g, n) => g.run(n);
});

describe("chaos harness verdicts", () => {
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const started = (run, wakes) => ({
    type: "run.started",
    payload: { runId: uuid(run), wakeIds: wakes.map(uuid) },
  });
  const finished = (run, stopReason, requeued) => ({
    type: "run.finished",
    payload: {
      runId: uuid(run),
      stopReason,
      ...(requeued ? { requeuedWakeIds: requeued.map(uuid) } : {}),
    },
  });
  const restart = (events) =>
    judgeRestart({
      events,
      oldRunId: uuid(1),
      oldWakeIds: [uuid(10)],
      source: "fake",
    });

  it("passes a restart only when the old run ends once and its wake reaches exactly one new run", () => {
    const good = restart([
      started(1, [10]),
      finished(1, "server_restart", [10]),
      started(2, [10]),
    ]);
    expect(good.checks.every((c) => c.outcome === "passed")).toBe(true);
    expect(good.newRunId).toBe(uuid(2));
    const twice = restart([
      started(1, [10]),
      finished(1, "server_restart", [10]),
      finished(1, "server_restart", [10]),
      started(2, [10]),
      started(3, [10]),
    ]);
    expect(twice.checks.map((c) => c.outcome)).toEqual([
      "failed",
      "passed",
      "failed",
    ]);
    const lost = restart([started(1, [10]), finished(1, "server_restart", [])]);
    expect(lost.checks.map((c) => c.outcome)).toEqual([
      "passed",
      "failed",
      "failed",
    ]);
  });

  it("passes the connection limit only after the limit was reached and a request waited for a slot", () => {
    const at = (requestedAt, start, end) => ({ requestedAt, start, end });
    const outcomes = (intervals) =>
      judgeConcurrency({ intervals, limit: 2, source: "live" }).checks.map(
        (c) => [c.name, c.outcome]
      );
    expect(maxOverlap([at(0, 0, 10), at(10, 10, 20)])).toBe(1);
    // 셋째 요청은 둘이 도는 동안 왔고 첫째가 끝난 뒤에 시작했다.
    expect(outcomes([at(0, 0, 10), at(0, 1, 12), at(2, 10, 20)])).toEqual([
      ["never_more_than_limit_running", "passed"],
      ["limit_saturated", "passed"],
      ["waiting_request_started_after_a_slot_freed", "passed"],
    ]);
    // 세 요청이 한꺼번에 오면 셋째는 앞의 둘이 자리를 차지한 동안 기다렸다가 첫째가 끝난 뒤 시작한다.
    expect(outcomes([at(0, 1, 10), at(0, 2, 12), at(0, 10, 20)])).toEqual([
      ["never_more_than_limit_running", "passed"],
      ["limit_saturated", "passed"],
      ["waiting_request_started_after_a_slot_freed", "passed"],
    ]);
    // 하나씩 돌면 상한에 닿지 않았고 기다린 요청도 없다. 통과로 치지 않는다.
    expect(outcomes([at(0, 0, 10), at(10, 10, 20), at(20, 20, 30)])).toEqual([
      ["never_more_than_limit_running", "passed"],
      ["limit_saturated", "not_run"],
      ["waiting_request_started_after_a_slot_freed", "not_run"],
    ]);
    // 둘이 도는 동안 온 요청이 자리가 나기 전에 시작했다.
    expect(outcomes([at(0, 0, 10), at(0, 1, 12), at(2, 5, 20)])).toEqual([
      ["never_more_than_limit_running", "failed"],
      ["limit_saturated", "passed"],
      ["waiting_request_started_after_a_slot_freed", "failed"],
    ]);
  });

  it("passes the server-kill steer checks only when the kill hit the intended moment", () => {
    const outcomes = (facts) =>
      steerKillChecks({ source: "live", ...facts }).map((c) => [
        c.name,
        c.outcome,
      ]);
    const hit = {
      acceptedBeforeKill: true,
      acceptedRecovered: true,
      inFlightSaved: true,
      inFlightSettledBeforeKill: false,
      inFlightRecovered: true,
    };
    expect(outcomes(hit)).toEqual([
      ["accepted_then_killed_steer_reaches_run_after_restart", "passed"],
      ["steer_in_flight_when_killed_is_not_lost", "passed"],
    ]);
    expect(
      outcomes({
        ...hit,
        acceptedBeforeKill: false,
        inFlightSettledBeforeKill: true,
      })
    ).toEqual([
      ["accepted_then_killed_steer_reaches_run_after_restart", "not_run"],
      ["steer_in_flight_when_killed_is_not_lost", "not_run"],
    ]);
    expect(outcomes({ ...hit, inFlightSaved: false })[1]).toEqual([
      "steer_in_flight_when_killed_is_not_lost",
      "not_run",
    ]);
    expect(
      outcomes({ ...hit, acceptedRecovered: false, inFlightRecovered: false })
    ).toEqual([
      ["accepted_then_killed_steer_reaches_run_after_restart", "failed"],
      ["steer_in_flight_when_killed_is_not_lost", "failed"],
    ]);
    for (const c of steerKillChecks({
      source: "live",
      ...hit,
      acceptedBeforeKill: false,
    }))
      if (c.outcome === "not_run") expect(c.reason).toEqual(expect.any(String));
  });

  it("never reports a result with a skipped check as a full pass", () => {
    const passed = check("x", true);
    const failed = check("y", false);
    const skipped = check("z", null, { reason: "why" });
    expect(() => check("z", null)).toThrow();
    expect(sceneOutcome([passed, passed])).toBe("passed");
    expect(sceneOutcome([passed, skipped])).toBe("partial");
    expect(sceneOutcome([skipped])).toBe("not_run");
    expect(sceneOutcome([passed, skipped, failed])).toBe("failed");
    expect([
      exitCodeOf("passed"),
      exitCodeOf("failed"),
      exitCodeOf("incomplete"),
    ]).toEqual([0, 1, 3]);
  });
});

describe("chaos harness evidence", () => {
  it("drops raw text fields, redacts registered secrets and bearer values, and fails the run when any was present", () => {
    const summary = {
      outcome: "passed",
      scenes: [
        {
          id: "a",
          reason: "오류: sent token-abcdef by mistake",
          observations: {
            body: "message body",
            replies: ["x"],
            count: 2,
            note: "Bearer abc.def",
          },
        },
      ],
    };
    const evidence = sanitizeEvidence(
      summary,
      new Set(["token-abcdef", "short"])
    );
    const text = JSON.stringify(evidence);
    expect(text).not.toContain("token-abcdef");
    expect(text).not.toContain("message body");
    expect(text).not.toContain("abc.def");
    expect(evidence.scenes[0].observations).toEqual({
      count: 2,
      note: "[redacted]",
    });
    expect(evidence.evidenceCheck).toEqual({
      forbiddenKeys: 2,
      secrets: 2,
      clean: false,
    });
    expect(evidence.outcome).toBe("failed");
    expect(
      sanitizeEvidence({ outcome: "passed", n: 1 }, new Set()).evidenceCheck
        .clean
    ).toBe(true);
  });

  it("writes the evidence file readable by the owner only", async () => {
    const dir = path.join(
      await mkdtemp(path.join(tmpdir(), "chaos-evidence-")),
      "run"
    );
    const { file } = await writeEvidence(dir, { outcome: "passed" }, new Set());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await rm(path.dirname(dir), { recursive: true, force: true });
  });
});

describe("chaos harness on a fake connection", () => {
  it("kills the separate server with SIGKILL, restarts it on the same home and database, and checks recovery, the same key, and steered messages", async () => {
    const { summary, secrets } = await runChaos({
      launch: { ...launchAll, scenes: ["b", "c", "g"] },
      connection: "fake-live",
      scenes: [sceneById("b"), sceneById("c"), sceneById("g")],
    });
    const [b, c, g] = summary.scenes;
    // 가짜 연결은 프로그램을 띄우지 않으므로 프로세스 정리 검사만 미실행이다.
    for (const scene of [b, c, g]) {
      expect(scene.serverStarts).toBe(scene.id === "g" ? 3 : 2);
      // 전달 중 강제 종료는 30ms 뒤에 끝내므로 서버가 메시지를 저장하기 전에 끝날 수 있다. 그때는 미실행이고 실패는 아니다.
      expect(
        scene.checks
          .filter((x) => x.outcome !== "passed")
          .filter(
            (x) =>
              !(
                x.name === "steer_in_flight_when_killed_is_not_lost" &&
                x.outcome === "not_run"
              )
          )
          .map((x) => [x.name, x.outcome, x.source])
      ).toEqual(
        scene.id === "b"
          ? [
              ["old_run_processes_cleaned_after_restart", "not_run", "fake"],
              [
                "old_provider_process_and_record_cleaned_after_restart",
                "not_run",
                "fake",
              ],
            ]
          : []
      );
      expect(scene.cleanup).toMatchObject({
        serverStopped: true,
        homeRemoved: true,
        homeKept: false,
        providerRecordsLeft: 0,
        commandPidsLeft: 0,
        problems: 0,
      });
    }
    expect(b.outcome).toBe("partial");
    expect(c.outcome).toBe("passed");
    // 수락 직후 강제 종료에도 메시지는 복구 뒤 실행이 받는다(수락된 메시지가 줄로 돌아오지 않던 결함의 회귀 검사).
    expect(g.checks).toContainEqual(
      expect.objectContaining({
        name: "accepted_then_killed_steer_reaches_run_after_restart",
        outcome: "passed",
      })
    );
    expect(["passed", "partial"]).toContain(g.outcome);
    expect(summary.outcome).toBe("incomplete");
    expect(summary).toMatchObject({
      overrunSeconds: 0,
      timeLimitExceeded: false,
    });
    // 전달 중 강제 종료된 HTTP 메시지는 저장되지 않을 수 있다(장면 g가 그 경우를 허용한다). 그래서 전체 실행 수는
    // 장면이 실제로 시작한 실행 수의 합과 같아야 하고, 이 장면 구성에서는 6..7이다.
    const sceneLiveRuns = summary.scenes.map((scene) => scene.liveRuns);
    expect(sceneLiveRuns.every((count) => count > 0)).toBe(true);
    expect(summary.liveRuns).toBe(
      sceneLiveRuns.reduce((sum, count) => sum + count, 0)
    );
    expect(summary.liveRuns).toBeGreaterThanOrEqual(6);
    expect(summary.liveRuns).toBeLessThanOrEqual(7);
    // 등록된 비밀값(토큰·메시지 본문·DB 주소)은 증거에 남지 않는다.
    expect(secrets.size).toBeGreaterThan(0);
    expect(sanitizeEvidence(summary, secrets).evidenceCheck.clean).toBe(true);
  }, 180_000);

  it("stops a scene at its time limit after a forced kill and cleans the server, database, and home", async () => {
    let home;
    const hang = {
      id: "a",
      title: "시간 초과",
      minLiveRuns: 1,
      database: "persistent",
      async run(ctx) {
        home = ctx.home;
        const org = await sceneTools.setupOrg(ctx, "Chaos hang");
        await sceneTools.startLongRun(ctx, org);
        // 서버만 강제로 끝낸다. 내장 DB는 남는다.
        await ctx.server.kill();
        await new Promise(() => {});
      },
    };
    const { summary } = await runChaos({
      launch: { ...launchAll, scenes: ["a"] },
      connection: "fake-live",
      scenes: [hang],
      sceneMs: 15_000,
    });
    const [scene] = summary.scenes;
    expect(scene).toMatchObject({
      outcome: "failed",
      reason: "장면 시간 초과",
      liveRuns: 1,
    });
    expect(scene.cleanup).toMatchObject({
      serverStopped: true,
      homeRemoved: true,
      postgresLeft: true,
      problems: 0,
    });
    expect(postgresAlive(home)).toBe(false);
    expect(existsSync(home)).toBe(false);
  }, 120_000);

  it("stops new live runs once the budget is used and leaves later scenes not run", async () => {
    const twoRuns = {
      id: "a",
      title: "예산",
      minLiveRuns: 1,
      database: "ephemeral",
      async run(ctx) {
        const org = await sceneTools.setupOrg(ctx, "Chaos budget");
        for (const n of [1, 2]) {
          const known = (await sceneTools.runsOf(ctx, org)).map((r) => r.id);
          await sceneTools.say(ctx, org, `Reply ${n}.`);
          await sceneTools.newRun(ctx, org, known);
          await sceneTools.settled(ctx, org);
        }
        return { checks: [check("unreachable", true)], observations: {} };
      },
    };
    const { summary } = await runChaos({
      launch: { ...launchAll, scenes: ["a", "b"], maxLiveRuns: 1 },
      connection: "fake-live",
      scenes: [twoRuns, sceneById("b")],
    });
    const [first, second] = summary.scenes;
    expect(first).toMatchObject({
      outcome: "not_run",
      liveRuns: 1,
      refusedRuns: 1,
    });
    expect(first.reason).toMatch(/예산/);
    expect(second).toMatchObject({ outcome: "not_run" });
    expect(second.reason).toMatch(/예산 부족/);
    expect(summary.outcome).toBe("incomplete");
    expect(first.cleanup).toMatchObject({
      serverStopped: true,
      homeRemoved: true,
    });
  }, 120_000);

  it("cleans up and leaves every remaining scene not run when the owner interrupts", async () => {
    const stop = new AbortController();
    const interrupted = {
      id: "a",
      title: "중단",
      minLiveRuns: 1,
      database: "ephemeral",
      async run(ctx) {
        const org = await sceneTools.setupOrg(ctx, "Chaos interrupt");
        await sceneTools.startLongRun(ctx, org);
        stop.abort(new Error("user interrupt"));
        await new Promise(() => {});
      },
    };
    const { summary } = await runChaos({
      launch: { ...launchAll, scenes: ["a", "b"] },
      connection: "fake-live",
      scenes: [interrupted, sceneById("b")],
      signal: stop.signal,
    });
    expect(summary.scenes.map((s) => [s.outcome, s.reason])).toEqual([
      ["not_run", "사용자 중단"],
      ["not_run", "사용자 중단"],
    ]);
    expect(summary.scenes[0].cleanup).toMatchObject({
      serverStopped: true,
      homeRemoved: true,
      problems: 0,
    });
  }, 120_000);

  it("reports a product invariant that times out as failed and a missing precondition as not run", async () => {
    const waiting = (id, wait) => ({
      id,
      title: id,
      minLiveRuns: 0,
      database: "ephemeral",
      async run(ctx) {
        await wait(ctx);
        return { checks: [check("unreachable", true)], observations: {} };
      },
    });
    const { summary } = await runChaos({
      launch: { ...launchAll, scenes: ["a", "b"] },
      connection: "fake-live",
      scenes: [
        waiting("a", (ctx) =>
          sceneTools.expectWithin(
            ctx,
            "복구된 깨우기가 실행됨",
            async () => false,
            {
              ms: 300,
            }
          )
        ),
        waiting("b", (ctx) =>
          sceneTools.waitFor(ctx, "모델이 명령을 시작함", async () => false, {
            ms: 300,
          })
        ),
      ],
    });
    expect(summary.scenes.map((s) => [s.outcome, s.reason])).toEqual([
      ["failed", "불변 조건 위반: 복구된 깨우기가 실행됨"],
      ["not_run", "모델이 명령을 시작함: 제한 시간 안에 관찰하지 못함"],
    ]);
  }, 120_000);

  it("keeps the home and fails the scene when a provider process record cannot be recovered", async () => {
    // 대표는 끝나고 그룹의 프로세스만 남았다. 제품 복구는 우리 것인지 확인할 수 없어 기록을 남긴다.
    const leader = spawn("sh", ["-c", "sleep 60 & exit 0"], {
      detached: true,
      stdio: "ignore",
    });
    await once(leader, "exit");
    const group = leader.pid;
    let home;
    try {
      const planted = {
        id: "a",
        title: "남은 프로세스",
        minLiveRuns: 0,
        database: "ephemeral",
        async run(ctx) {
          home = ctx.home;
          const dir = path.join(home, "providers/opencode/processes");
          await mkdir(dir, { recursive: true });
          await writeFile(
            path.join(dir, `${group}.json`),
            JSON.stringify({
              pid: group,
              start: "0",
              group,
              boot: readFileSync(
                "/proc/sys/kernel/random/boot_id",
                "utf8"
              ).trim(),
            })
          );
          return { checks: [check("ran", true)], observations: {} };
        },
      };
      const { summary } = await runChaos({
        launch: { ...launchAll, scenes: ["a"] },
        connection: "fake-live",
        scenes: [planted],
      });
      const [scene] = summary.scenes;
      expect(scene.outcome).toBe("failed");
      expect(scene.cleanup).toMatchObject({
        homeKept: true,
        homeRemoved: false,
        providerRecordsLeft: 1,
      });
      // 사람이 정리할 수 있게 기록을 지우지 않는다.
      expect(
        existsSync(
          path.join(home, "providers/opencode/processes", `${group}.json`)
        )
      ).toBe(true);
    } finally {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        /* 이미 끝났다. */
      }
      if (home) await rm(home, { recursive: true, force: true });
    }
  }, 120_000);

  it("stops waiting for a server start when the scene is aborted", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "chaos-abort-home-"));
    const harnessDir = await mkdtemp(path.join(tmpdir(), "chaos-abort-"));
    const server = chaosServer({
      home,
      harnessDir,
      connection: "fake-live",
      database: "persistent",
    });
    try {
      const at = Date.now();
      await expect(server.start(AbortSignal.timeout(200))).rejects.toThrow();
      expect(Date.now() - at).toBeLessThan(10_000);
      expect(server.running).toBe(false);
    } finally {
      // 실패해도 띄운 서버·DB·홈을 남기지 않는다.
      await server.dispose();
      await rm(harnessDir, { recursive: true, force: true });
    }
    expect(postgresAlive(home)).toBe(false);
  }, 60_000);
});
