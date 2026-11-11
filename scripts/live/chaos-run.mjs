// 실모델 장애 검사의 실행기. 장면마다 새 임시 홈·서버를 만들고, 예산·시한 안에서 장면을 돌린 뒤 성공·실패·시간 초과·중단 모두에서 정리한다.
// 결과는 메타데이터만 담은 JSON이다. 쓰기 전에 모델 원문·메시지 본문·토큰 같은 등록된 비밀값이 섞였는지 검사한다.
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLedger,
  limits,
  sceneRunCap,
  writeBudget,
  writeSecretFile,
} from "./chaos-budget.mjs";
import { chaosServer, processRecordPids } from "./chaos-server.mjs";
import {
  brief,
  busyPids,
  check,
  NotRun,
  sceneOutcome,
} from "./chaos-scenes.mjs";

/** 남은 시간이 이보다 적으면 새 장면을 시작하지 않는다. */
const minSceneMs = 60_000;
/** 전체 시간 안에 마지막 장면의 정리(서버 정지·DB 정지·홈 삭제)까지 끝내도록 남겨 두는 시간. */
const cleanupReserveMs = 60_000;

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
  log = () => {},
  /** 전체 시간의 시작. 실제 호출 전 확인을 먼저 했으면 그 시작 시각을 준다. */
  startedAt = Date.now(),
}) {
  const deadlineAt = startedAt + totalMs - cleanupReserveMs;
  const runDir = await mkdtemp(path.join(tmpdir(), "babojubot-chaos-run-"));
  await chmod(runDir, 0o700);
  const ledger = createLedger(path.join(runDir, "ledger.jsonl"));
  const budgetFile = path.join(runDir, "budget.json");
  const secrets = new Set();
  const results = [];
  const fake = connection !== "opencode";
  try {
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
      log(
        `${scene.id} ${scene.title}: ${last.outcome}${last.reason ? ` (${last.reason})` : ""}`
      );
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
  const liveRuns = results.reduce((n, r) => n + (r.liveRuns ?? 0), 0);
  const inputTokens = results.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
  const allChecks = results.flatMap((r) => r.checks);
  const outcome = results.some((r) => r.outcome === "failed")
    ? "failed"
    : results.every((r) => r.outcome === "passed")
      ? "passed"
      : "incomplete";
  return {
    summary: {
      outcome,
      connection: fake ? "fake-live" : "opencode",
      model: launch.model ?? (fake ? "fake-live-mini" : "product-default-free"),
      altModel: launch.altModel,
      startedAt: new Date(startedAt).toISOString(),
      seconds: (Date.now() - startedAt) / 1000,
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
  const home = await mkdtemp(path.join(tmpdir(), "babojubot-chaos-home-"));
  const harnessDir = await mkdtemp(
    path.join(tmpdir(), "babojubot-chaos-scene-")
  );
  await chmod(home, 0o700);
  await chmod(harnessDir, 0o700);
  writeBudget(budgetFile, {
    scene: scene.id,
    maxLiveRuns: launch.maxLiveRuns,
    sceneMaxRuns: sceneRunCap(scene.id),
    deadlineAt: sceneDeadlineAt,
  });
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
    model: fake ? "fake-live-mini" : launch.model,
    altModel: launch.altModel,
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
      const { withClient } = await import("../../packages/db/src/client.ts");
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
            : "실제 실행 예산에 닿아 새 실제 실행을 막음"
        );
    },
  };
  let outcome,
    reason = null,
    checks = [],
    observations = {};
  try {
    await server.start();
    secrets.add(server.info.dbUrl);
    const aborted = new Promise((_, reject) =>
      sceneSignal.addEventListener("abort", () => reject(sceneSignal.reason), {
        once: true,
      })
    );
    aborted.catch(() => {});
    ({ checks, observations } = await Promise.race([scene.run(ctx), aborted]));
    outcome = sceneOutcome(checks);
  } catch (error) {
    if (error instanceof NotRun) {
      outcome = "not_run";
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
  if (
    !cleanup.serverStopped ||
    !cleanup.homeRemoved ||
    cleanup.problems > 0 ||
    cleanup.commandPidsLeft > 0
  ) {
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

/** 장면 정리. 정리에서 난 문제도 결과에 남긴다. */
export async function cleanupScene({ server, home, harnessDir, marker }) {
  const cleanup = {
    serverStopped: false,
    homeRemoved: false,
    postgresLeft: false,
    providerRecordsLeft: 0,
    commandPidsLeft: 0,
    problems: 0,
  };
  try {
    const leftovers = await server.dispose();
    cleanup.postgresLeft = leftovers.postgres;
    cleanup.providerRecordsLeft = leftovers.providerRecords;
  } catch {
    cleanup.problems++;
    await rm(home, { recursive: true, force: true }).catch(
      () => cleanup.problems++
    );
  }
  cleanup.serverStopped = !server.running;
  // 이 장면 표시가 붙은 시험용 명령만 남아 있으면 끝낸다. 다른 작업의 프로세스는 표시가 달라 건드리지 않는다.
  const left = busyPids(marker);
  cleanup.commandPidsLeft = left.length;
  for (const pid of left)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 이미 끝났다. */
    }
  await rm(harnessDir, { recursive: true, force: true });
  cleanup.homeRemoved = !existsSync(home);
  return cleanup;
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
