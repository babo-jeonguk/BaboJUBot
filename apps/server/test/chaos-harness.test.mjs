// 실모델 장애 검사(scripts/chaos-live.mjs)의 자동 검사. 실제 모델은 부르지 않는다.
// 실행 허용 차단, 예산 제한, 결과 판정, 증거 검사, 그리고 가짜 연결·임시 홈·임시 DB로 강제 종료·시간 초과·중단 뒤 정리를 본다.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
} from "../../../scripts/live/chaos-scenes.mjs";

const ids = scenes.map((s) => s.id);
const launchAll = { scenes: ids, maxLiveRuns: 24, model: null, altModel: null };
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

describe("chaos harness budget gate", () => {
  async function gated(budget) {
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
    const run = (n) =>
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
        { signal: new AbortController().signal, emit: async () => {} }
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

  it("fails the connection limit on an overlap above the limit or a run that did not wait for a slot", () => {
    const at = (start, end) => ({ start, end });
    expect(maxOverlap([at(0, 10), at(10, 20)])).toBe(1);
    const fine = judgeConcurrency({
      intervals: [at(0, 10), at(1, 12), at(10, 20)],
      limit: 2,
      source: "live",
    });
    expect(fine.checks.map((c) => c.outcome)).toEqual(["passed", "passed"]);
    const over = judgeConcurrency({
      intervals: [at(0, 10), at(1, 12), at(5, 20)],
      limit: 2,
      source: "live",
    });
    expect(over.checks.map((c) => c.outcome)).toEqual(["failed", "failed"]);
    const few = judgeConcurrency({
      intervals: [at(0, 10)],
      limit: 2,
      source: "live",
    });
    expect(few.checks[1]).toMatchObject({
      outcome: "not_run",
      reason: expect.any(String),
    });
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
  it("kills the separate server with SIGKILL, restarts it on the same home and database, and checks recovery and the same key", async () => {
    const { summary, secrets } = await runChaos({
      launch: { ...launchAll, scenes: ["b", "c"] },
      connection: "fake-live",
      scenes: [sceneById("b"), sceneById("c")],
    });
    const [b, c] = summary.scenes;
    // 가짜 연결은 프로그램을 띄우지 않으므로 프로세스 정리 검사만 미실행이다.
    for (const scene of [b, c]) {
      expect(scene.serverStarts).toBe(2);
      expect(scene.checks.filter((x) => x.outcome !== "passed")).toEqual(
        scene.id === "b"
          ? [
              expect.objectContaining({
                name: "old_run_processes_cleaned_after_restart",
                outcome: "not_run",
                source: "fake",
              }),
            ]
          : []
      );
      expect(scene.cleanup).toMatchObject({
        serverStopped: true,
        homeRemoved: true,
        providerRecordsLeft: 0,
        commandPidsLeft: 0,
        problems: 0,
      });
    }
    expect(b.outcome).toBe("partial");
    expect(c.outcome).toBe("passed");
    expect(summary.outcome).toBe("incomplete");
    expect(summary.liveRuns).toBe(4);
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
});
