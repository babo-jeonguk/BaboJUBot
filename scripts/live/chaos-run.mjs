// 실모델 장애 검사의 실행기. 장면마다 새 임시 홈·서버를 만들고, 예산·시한 안에서 장면을 돌린 뒤 성공·실패·시간 초과·중단 모두에서 정리한다.
// 결과는 메타데이터만 담은 JSON이다. 쓰기 전에 모델 원문·메시지 본문·토큰 같은 등록된 비밀값이 섞였는지 검사한다.
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attemptAll,
  attemptEach,
  continueAfterFailure,
  failureCode,
  settled,
} from "@babojubot/contracts";
import { killUnlessGone, withCleanup } from "@babojubot/process/test-cleanup";
import {
  createLedger,
  limits,
  sceneRunCap,
  writeBudget,
  writeSecretFile,
} from "./chaos-budget.mjs";
import { chaosServer, processRecordPids } from "./chaos-server.mjs";
import { stillRunning } from "./processes.mjs";
import {
  brief,
  busyPids,
  check,
  InvariantBroken,
  NotRun,
  sceneOutcome,
} from "./chaos-scenes.mjs";

/** 남은 시간이 이보다 적으면 새 장면을 시작하지 않는다. */
const minSceneMs = 60_000;
/** 전체 시간 안에 마지막 장면의 정리(서버 정지·DB 정지·홈 삭제)까지 끝내도록 남겨 두는 시간. */
const cleanupReserveMs = 90_000;

/**
 * 선택한 장면을 순서대로 돌린다. 결과 요약을 돌려준다(쓰기는 `writeEvidence`).
 * - `connection`: `opencode` 또는 `fake-live`(자동 검사)
 * - `scenes`: 장면 정의 전체(chaos-scenes.mjs `scenes`). `launch.scenes`에 없는 장면은 미실행(선택하지 않음)이다.
 * - `signal`: 사용자 중단. 지금 장면을 멈추고 정리한 뒤 나머지는 미실행으로 남긴다.
 */
export async function runChaos({
  launch,
  connection,
  scenes,
  signal = new AbortController().signal,
  totalMs = limits.totalMs,
  sceneMs = limits.sceneMs,
  log = (_line) => {},
  /** 전체 시간의 시작. 실제 호출 전 확인을 먼저 했으면 그 시작 시각을 준다. */
  startedAt = Date.now(),
}) {
  const deadlineAt = startedAt + totalMs - cleanupReserveMs;
  const secrets = new Set();
  const results = [];
  const fake = connection !== "opencode";
  // 실행 기록·예산 폴더는 만든 직후 지우기를 등록한다. 장면 서버들이 이 폴더의 기록·예산 파일을 쓰므로, 띄운 장면의 정리가 모두
  // 끝났음을 봤을 때만 지운다. 아니면 폴더를 남기고 알린다(정리가 끝나지 않은 장면은 실패 결과로 남고, 결과 없이 던진 장면은 그 오류가
  // 이 실행의 실패로 나간다). 지우기 실패는 장면의 실패와 함께 알린다.
  /** 띄웠지만 정리가 끝났음을 보지 못한 장면. 띄우기 전에 넣고, 정리가 끝났음을 본 뒤에만 뺀다. */
  const uncleaned = [];
  await withCleanup(async (defer) => {
    const runDir = await mkdtemp(path.join(tmpdir(), "babojubot-chaos-run-"));
    defer(async () => {
      if (uncleaned.length) {
        console.error(
          `[chaos] the run folder ${runDir} is kept: the cleanup of ${uncleaned.join(", ")} was not confirmed`
        );
        return;
      }
      await rm(runDir, { recursive: true, force: true });
    });
    await chmod(runDir, 0o700);
    const ledger = createLedger(path.join(runDir, "ledger.jsonl"));
    const budgetFile = path.join(runDir, "budget.json");
    for (const scene of scenes) {
      const base = {
        id: scene.id,
        title: scene.title,
        optional: !!scene.optional,
      };
      const claims = () => ledger.read().filter((e) => e.kind === "claim");
      const skip = (reason) => {
        results.push({ ...base, outcome: "not_run", reason, checks: [] });
        log(`${scene.id} ${scene.title}: 미실행 (${reason})`);
      };
      if (!launch.scenes.includes(scene.id)) {
        skip("선택하지 않음");
        continue;
      }
      if (signal.aborted) {
        skip("사용자 중단");
        continue;
      }
      if (deadlineAt - Date.now() < minSceneMs) {
        skip("전체 시간 한도");
        continue;
      }
      const remainingRuns = launch.maxLiveRuns - claims().length;
      if (remainingRuns < scene.minLiveRuns) {
        skip(
          `남은 실제 실행 예산 부족(${remainingRuns}회 남음, ${scene.minLiveRuns}회 필요)`
        );
        continue;
      }
      log(`${scene.id} ${scene.title}: 시작`);
      // 정리가 끝났음을 본 뒤에만 뺀다. 장면이 결과 없이 던지면(정리 뒤의 읽기 실패 등) 정리됐다고 볼 근거가 없어 남는다.
      uncleaned.push(scene.id);
      results.push(
        await runScene({
          scene,
          base,
          launch,
          connection,
          fake,
          ledger,
          budgetFile,
          secrets,
          signal,
          sceneDeadlineAt: Math.min(Date.now() + sceneMs, deadlineAt),
          globalDeadlineAt: deadlineAt,
        })
      );
      const last = results.at(-1);
      if (sceneCleanedUp(last.cleanup)) uncleaned.pop();
      log(
        `${scene.id} ${scene.title}: ${last.outcome}${last.reason ? ` (${last.reason})` : ""}`
      );
    }
  });
  const liveRuns = results.reduce((n, r) => n + (r.liveRuns ?? 0), 0);
  const inputTokens = results.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
  const allChecks = results.flatMap((r) => r.checks);
  const overrunSeconds = Math.max(0, (Date.now() - startedAt - totalMs) / 1000);
  const outcome =
    overrunSeconds > 0 || results.some((r) => r.outcome === "failed")
      ? "failed"
      : results.every((r) => r.outcome === "passed")
        ? "passed"
        : "incomplete";
  return {
    summary: {
      outcome,
      connection: fake ? "fake-live" : "opencode",
      model: fake ? "fake-live-mini" : "product-default-free",
      startedAt: new Date(startedAt).toISOString(),
      seconds: (Date.now() - startedAt) / 1000,
      overrunSeconds,
      timeLimitExceeded: overrunSeconds > 0,
      limits: {
        maxLiveRuns: launch.maxLiveRuns,
        totalSeconds: totalMs / 1000,
        sceneSeconds: sceneMs / 1000,
        longCommandSeconds: limits.longCommandSeconds,
        inputTokenAdvisory: limits.inputTokenAdvisory,
      },
      liveRuns,
      inputTokens,
      inputTokenAdvisoryExceeded: inputTokens > limits.inputTokenAdvisory,
      checks: {
        passed: allChecks.filter((c) => c.outcome === "passed").length,
        failed: allChecks.filter((c) => c.outcome === "failed").length,
        notRun: allChecks.filter((c) => c.outcome === "not_run").length,
      },
      scenes: results,
    },
    secrets,
  };
}

async function runScene({
  scene,
  base,
  launch,
  connection,
  fake,
  ledger,
  budgetFile,
  secrets,
  signal,
  sceneDeadlineAt,
  globalDeadlineAt,
}) {
  const at = Date.now();
  const { home, harnessDir } = await prepareScene(() =>
    writeBudget(budgetFile, {
      scene: scene.id,
      maxLiveRuns: launch.maxLiveRuns,
      sceneMaxRuns: sceneRunCap(scene.id),
      deadlineAt: sceneDeadlineAt,
    })
  );
  const server = chaosServer({
    home,
    harnessDir,
    connection,
    database: scene.database,
    brief,
    ledgerFile: ledger.file,
    budgetFile,
  });
  const marker = `chaos${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const timeout = AbortSignal.timeout(
    Math.max(0, sceneDeadlineAt - Date.now())
  );
  const sceneSignal = AbortSignal.any([signal, timeout]);
  const sceneClaims = () =>
    ledger.read().filter((e) => e.kind === "claim" && e.scene === scene.id)
      .length;
  const ctx = {
    scene: scene.id,
    fake,
    home,
    marker,
    signal: sceneSignal,
    secrets,
    ledger,
    server,
    model: fake ? "fake-live-mini" : null,
    get liveId() {
      return server.info.liveProviderId;
    },
    api: async (method, route, body) => {
      const response = await fetch(server.info.url + route, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: sceneSignal,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    query: async (sql, params) => {
      const { withClient } = await import("@babojubot/db/admin");
      return withClient(
        server.info.dbUrl,
        async (client) => (await client.query(sql, params)).rows
      );
    },
    control: (settings) =>
      writeSecretFile(server.files.control, JSON.stringify(settings), {
        replace: true,
      }),
    processRecordPids: () => processRecordPids(home),
    remainingSceneRuns: () =>
      Math.min(
        sceneRunCap(scene.id) - sceneClaims(),
        launch.maxLiveRuns -
          ledger.read().filter((e) => e.kind === "claim").length
      ),
    /** 이 장면에서 실행 관문이 실행을 거절했으면 멈춘다. 그 뒤로는 새 실제 실행이 없다. */
    assertBudget: () => {
      const refused = ledger
        .read()
        .find((e) => e.kind === "refused" && e.scene === scene.id);
      if (refused)
        throw new NotRun(
          refused.reason === "time_limit"
            ? "시간 한도에 닿아 새 실제 실행을 막음"
            : refused.reason === "no_free_model"
              ? "무료 모델을 확인하지 못해 새 실제 실행을 막음"
              : "실제 실행 예산에 닿아 새 실제 실행을 막음"
        );
    },
  };
  let outcome,
    reason = null,
    checks = [],
    observations = {};
  try {
    await server.start(sceneSignal);
    secrets.add(server.info.dbUrl);
    const aborted = new Promise((_, reject) =>
      sceneSignal.addEventListener("abort", () => reject(sceneSignal.reason), {
        once: true,
      })
    );
    // 중단 실패는 아래 경주가 받는다. 경주가 먼저 끝난 뒤의 거절이 처리되지 않은 거절로 남지 않게 끝남만 지킨다.
    void settled(aborted);
    ({ checks, observations } = await Promise.race([scene.run(ctx), aborted]));
    outcome = sceneOutcome(checks);
  } catch (error) {
    if (error instanceof NotRun) {
      outcome = "not_run";
      reason = error.message;
    } else if (error instanceof InvariantBroken) {
      outcome = "failed";
      reason = error.message;
    } else if (signal.aborted) {
      outcome = "not_run";
      reason = "사용자 중단";
    } else if (timeout.aborted) {
      outcome = "failed";
      reason =
        sceneDeadlineAt >= globalDeadlineAt
          ? "전체 시간 한도로 장면을 멈춤"
          : "장면 시간 초과";
    } else {
      outcome = "failed";
      reason =
        `오류: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300
        );
    }
  }
  // 사용자 중단·시간 초과에서도 진행 중인 실행을 취소하고 서버·DB·프로세스·홈을 정리한다.
  const cleanup = await cleanupScene({ server, home, harnessDir, marker });
  // 정리가 끝나지 않았으면(서버·홈·시험용 명령이 남음) 장면 결과와 상관없이 실패다.
  if (!sceneCleanedUp(cleanup)) {
    checks = [
      ...checks,
      check("cleanup_complete", false, { source: fake ? "fake" : "live" }),
    ];
    outcome = "failed";
    reason ??= "장면 정리가 끝나지 않음";
  }
  const sceneEntries = ledger.read().filter((e) => e.scene === scene.id);
  const ends = sceneEntries.filter((e) => e.kind === "end" && e.live);
  return {
    ...base,
    outcome,
    reason,
    seconds: (Date.now() - at) / 1000,
    liveRuns: sceneEntries.filter((e) => e.kind === "claim").length,
    refusedRuns: sceneEntries.filter((e) => e.kind === "refused").length,
    inputTokens: ends.reduce((n, e) => n + (e.inputTokens ?? 0), 0),
    outputTokens: ends.reduce((n, e) => n + (e.outputTokens ?? 0), 0),
    serverStarts: server.starts,
    checks,
    observations,
    cleanup,
  };
}

/** 장면 정리가 끝났는가: 서버가 멈추고 홈을 지웠고, 프로세스 기록·시험용 명령·정리 문제가 하나도 남지 않았다. */
function sceneCleanedUp(cleanup) {
  return (
    cleanup.serverStopped &&
    cleanup.homeRemoved &&
    !cleanup.homeKept &&
    cleanup.providerRecordsLeft === 0 &&
    cleanup.problems === 0 &&
    cleanup.commandPidsLeft === 0
  );
}

/** 장면 정리. 정리에서 난 문제도 결과에 남긴다. */
/**
 * 장면의 임시 홈과 검사 폴더(0700)를 만들고 `ready`(예산 쓰기)를 한다. 준비가 실패하면 그때까지 만든 폴더를 지우고 원래 실패를
 * 던진다(지우기 실패는 따로 알린다). 성공하면 두 폴더의 정리는 장면 끝의 `cleanupScene`이 맡는다. 폴더는 `root` 아래에 만든다.
 */
export async function prepareScene(ready, root = tmpdir()) {
  const made = [];
  try {
    const home = await mkdtemp(path.join(root, "babojubot-chaos-home-"));
    made.push(home);
    const harnessDir = await mkdtemp(path.join(root, "babojubot-chaos-scene-"));
    made.push(harnessDir);
    await chmod(home, 0o700);
    await chmod(harnessDir, 0o700);
    ready();
    return { home, harnessDir };
  } catch (error) {
    await continueAfterFailure(
      () =>
        attemptAll(
          made.map((dir) => () => rm(dir, { recursive: true, force: true }))
        ),
      (cleanupError) =>
        console.error(
          `[chaos] scene folders were not removed after a failed start (${failureCode(cleanupError)})`
        )
    );
    throw error;
  }
}

export async function cleanupScene({ server, home, harnessDir, marker }) {
  /** 정리 단계 하나. 실패하면 터미널에만 짧게 알리고(증거에는 남기지 않는다) 실패로 돌려준다. 실패 수는 `attemptEach`의 목록이다. */
  const step = (describe, work) => async () => {
    try {
      await work();
    } catch (error) {
      console.error(`[chaos] ${describe(error)}`);
      throw error;
    }
  };
  const code = (error) => failureCode(error.cause ?? error);
  /** @type {Awaited<ReturnType<typeof server.dispose>> | undefined} */
  let leftovers;
  /** @type {ReturnType<typeof busyPids> | undefined} */
  let left;
  const serverAndList = await attemptEach([
    step(
      (error) => `scene server cleanup failed (${failureCode(error)})`,
      async () => {
        leftovers = await server.dispose();
      }
    ),
    // 이 장면 표시가 붙은 시험용 명령만 남아 있으면 끝낸다. 다른 작업의 프로세스는 표시가 달라 건드리지 않는다.
    // 조회가 실패하면 남은 명령을 모르므로 그 수를 비우고(null) 문제로 센 뒤 나머지 정리를 이어 간다.
    step(
      (error) => `could not list test commands (${code(error)})`,
      () => {
        left = busyPids(marker);
      }
    ),
  ]);
  let survivors = [];
  const commands = await attemptEach([
    // 이미 끝난 명령(ESRCH)은 넘어가고, 끄지 못한 명령은 세고 알린 뒤 나머지 정리를 이어 간다. 목록을 만든 뒤 다른 정리를
    // 기다렸으므로, 그 번호가 아직 이 장면의 명령인지(명령줄의 장면 표시) 신호 바로 앞에서 다시 보고, 보기와 신호 사이에 기다림을
    // 두지 않는다. 다른 프로세스에 다시 쓰인 번호에는 보내지 않는다.
    ...(left ?? []).map((pid) =>
      step(
        (error) => `could not stop test command ${pid} (${code(error)})`,
        () => {
          if (busyPids(marker).includes(pid)) killUnlessGone(pid);
        }
      )
    ),
    // 신호만 보내고 떠나지 않는다. 끈 명령이 실제로 끝났는지 상한 안에서 확인하고, 남은 것은 세고 알린다.
    step(
      (error) => `could not confirm the test commands ended (${code(error)})`,
      async () => {
        survivors = await stillRunning(left ?? [], 10_000);
      }
    ),
    step(
      (error) => error.message,
      () => {
        if (survivors.length)
          throw new Error(
            `test commands still running after SIGKILL: ${survivors.join(", ")}`
          );
      }
    ),
  ]);
  // 장면 서버와 시험용 명령은 harness 폴더를 쓴다. 그 끝을 모두 확인했을 때만 지우고, 아니면 남기고 알린다(지우면 아직 쓰는
  // 프로세스가 남은 채로 정리된 것처럼 보인다). 지우기의 실패도 정리 실패로 센다.
  const unconfirmed = serverAndList.length + commands.length;
  const harness = unconfirmed
    ? []
    : await attemptEach([
        step(
          (error) =>
            `could not remove the scene harness folder (${code(error)})`,
          () => rm(harnessDir, { recursive: true, force: true })
        ),
      ]);
  if (unconfirmed)
    console.error(
      `[chaos] the scene harness folder ${harnessDir} is kept: the scene server or its commands were not confirmed ended`
    );
  return {
    serverStopped: !server.running,
    homeRemoved: !existsSync(home),
    // 서버 정리가 실패했으면 홈에는 아직 프로세스 기록이 남아 있을 수 있다. 지우지 않고 남긴다.
    homeKept: leftovers ? leftovers.homeKept : existsSync(home),
    postgresLeft: leftovers?.postgres ?? false,
    providerRecordsFound: leftovers?.providerRecordsFound ?? 0,
    providerRecordsLeft: leftovers?.providerRecordsLeft ?? 0,
    // 정리에 들어갈 때 시험용 명령이 남아 있었다는 것 자체가 정리 실패의 신호다. 끈 뒤에 끝났는지와 상관없이 그 수를 센다.
    commandPidsLeft: left?.length ?? null,
    harnessKept: existsSync(harnessDir),
    // 남긴 harness 폴더는 그 원인(서버·명령의 정리 실패)으로 이미 센다.
    problems: unconfirmed + harness.length,
  };
}

/** 증거에 남기지 않는 이름. 값이 무엇이든 지운다. */
const forbiddenKeys =
  /^(body|bodies|text|content|token|tokens|secret|password|stdout|stderr|transcript|summary|session|sessionState|reply|replies|word|url|dbUrl)$/i;

/** 결과를 증거로 쓸 모양으로 만든다. 금지된 이름은 지우고, 등록된 비밀값이 섞인 문자열은 가린 뒤 그 수를 센다. */
export function sanitizeEvidence(summary, secrets) {
  const found = { forbiddenKeys: 0, secrets: 0 };
  const listed = [...secrets].filter(
    (s) => typeof s === "string" && s.length >= 6
  );
  const clean = (value) => {
    if (typeof value === "string") {
      let out = value;
      for (const secret of listed)
        if (out.includes(secret)) {
          found.secrets++;
          out = out.split(secret).join("[redacted]");
        }
      if (/bearer\s+\S/i.test(out)) {
        found.secrets++;
        out = out.replace(/bearer\s+\S+/gi, "[redacted]");
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, v]) => {
          if (forbiddenKeys.test(key)) {
            found.forbiddenKeys++;
            return [];
          }
          return [[key, clean(v)]];
        })
      );
    return value;
  };
  const evidence = clean(summary);
  evidence.evidenceCheck = {
    ...found,
    clean: found.forbiddenKeys === 0 && found.secrets === 0,
  };
  // 비밀값이 섞였으면 그 자체가 결함이다. 전체 결과를 통과로 두지 않는다.
  if (!evidence.evidenceCheck.clean) evidence.outcome = "failed";
  return evidence;
}

/** 증거를 `<dir>/results.json`(0600, 폴더 0700)에 쓴다. */
export async function writeEvidence(dir, summary, secrets) {
  const evidence = sanitizeEvidence(summary, secrets);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = path.join(dir, "results.json");
  await writeFile(file, JSON.stringify(evidence, null, 2) + "\n", {
    mode: 0o600,
  });
  return { file, evidence };
}

/** 종료 코드: 전체 통과 0, 실패 1, 미실행이 있음 3. */
export const exitCodeOf = (outcome) =>
  outcome === "passed" ? 0 : outcome === "failed" ? 1 : 3;
