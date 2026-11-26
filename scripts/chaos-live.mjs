// 사람이 돌리는 실제 OpenCode 장애 검사. CI와 자동 검사는 실제 호출로 부르지 않는다. 구독 사용량이나 비용을 쓴다.
// 실행 중 취소·서버 강제 종료 후 복구·재시작 전후 같은 호출 키·조직 간 동시 실행 제한·실행 중 메시지 전달·세션 재개와 설정 변경을
// 장면마다 새 임시 제품 홈·서버로 확인한다. 결과는 메타데이터만 `.scratch/chaos/<시각>/results.json`에 남긴다.
// 사용법: docs/providers.md "실모델 장애 검사".
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attemptEach, failureCode } from "@babojubot/contracts";
import { removeFolderWithin } from "@babojubot/process/test-cleanup";
import {
  createOpenCodeProvider,
  processRecordPids,
  recoverProviderProcesses,
} from "@babojubot/runtime";
import { LaunchRefused, limits, parseLaunch } from "./live/chaos-budget.mjs";
import { exitCodeOf, runChaos, writeEvidence } from "./live/chaos-run.mjs";
import { scrubEnvironment } from "./live/chaos-server.mjs";
import { scenes } from "./live/chaos-scenes.mjs";
import { afterOutput } from "./exit-after-output.ts";
import { installUserInterrupt } from "./live/chaos-interrupt.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const usage = `Usage: node scripts/chaos-live.mjs --allow-live [--scenes=a,d,e,f,b,c,g]

Runs real OpenCode chaos scenes. Needs explicit permission to use model quota and is refused in CI.
  BABOJUBOT_CHAOS_MAX_LIVE_RUNS  live run budget, 1-${limits.maxLiveRuns} (default ${limits.maxLiveRuns})
  Models: the product's free-model choice only (a run starts only while a free model is confirmed)`;

let launch;
try {
  launch = parseLaunch(
    process.argv.slice(2),
    process.env,
    scenes.map((s) => s.id)
  );
} catch (error) {
  if (!(error instanceof LaunchRefused)) throw error;
  console.error(error.message);
  console.error(usage);
  process.exit(await afterOutput(2));
}

// 실제 호출 전 확인과 서버가 개인 설정·자격 증명(PASS_ENV 등)을 읽지 않게 한다.
scrubEnvironment(process.env);

// 사용자 중단(Ctrl-C): 지금 장면을 멈추고 정리한 뒤 결과를 남긴다. 두 번째 Ctrl-C는 바로 끝낸다.
const stop = new AbortController();
installUserInterrupt(stop);

/**
 * 준비 확인 결과에서 두 가지를 읽는다. `probe`: 확인 명령(`runProbe`)의 끝을 확인했는가. `runProbe`는 트리의 끝을 확인하지 못하면
 * `killed`로 던지고 준비 확인은 그것을 `check_failed`로 돌려주므로, 그 밖의 이유로 돌아왔으면 확인 명령은 시작하지 못했거나 끝났다.
 * `check_failed`에는 끝을 확인한 실패도 접혀 있지만 가를 수 없어 확인 못 함으로 센다. OpenCode 준비 확인이 내지 않는 이유도 확인 못
 * 함이다. `free`: 무료 모델이 있다(준비됨).
 * @param {import("@babojubot/contracts").ProviderReadinessCheck} readiness
 * @returns {{ probe: "ended" | "unconfirmed", free: boolean }}
 */
function readinessOf(readiness) {
  const reason = readiness.reason;
  switch (reason) {
    case null:
      return { probe: "ended", free: true };
    case "credentials_unverified":
    case "program_missing":
      return { probe: "ended", free: false };
    case "check_failed":
    case "check_timeout":
    case "not_checked":
    case "product_login_missing":
    case "credentials_invalid":
    case "isolation_unavailable":
    case "isolation_unsafe":
    case "credential_relay_unverified":
    case "credential_relay_failed":
      return { probe: "unconfirmed", free: false };
    default: {
      /** @type {never} */
      const unknown = reason;
      throw new Error(`unknown readiness reason ${String(unknown)}`);
    }
  }
}

/**
 * 임시 홈에서 준비 확인을 하고, 그 확인이 띄운 프로그램이 끝났는지 본다. 서버의 끝은 제품 복구 뒤 남은 복구 기록이 없는 것으로 본다
 * (제품은 트리가 멈춘 것을 확인했을 때만 기록을 지운다). 한계: 제품이 기록을 저장하지 못한 길과, 트리는 멈췄지만 출력을 쥔 자손이
 * 남은 길은 이 판정이 보지 못한다(#286 PR 3b-3b-1 「한계」, 남은 폴더 자동 정리 후속 이슈).
 */
async function checkIn(home) {
  const connection = createOpenCodeProvider({ dataDir: home });
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]);
  const readiness = await connection.adapter.checkReadiness(signal);
  await recoverProviderProcesses(home);
  return {
    readiness,
    ...readinessOf(readiness),
    recordsLeft: processRecordPids(home).length,
  };
}

/**
 * 실제 호출 전 확인: 프로그램·로그인 상태와 무료 모델. 임시 홈에서 하고, 그 확인이 띄운 프로그램의 끝을 확인했을 때만 지운다. 사용자
 * OpenCode 설정·자격 증명은 읽지 않는다. 확인하지 못했거나 지우지 못하면 홈을 남기고 그 위치와 까닭을 알리며, 문제로 돌려줘 실제
 * 호출로 넘어가지 않는다. 확인 자체가 던지면 남긴 위치를 알린 뒤 그대로 던진다.
 */
async function preflight() {
  const home = await mkdtemp(path.join(tmpdir(), "babojubot-chaos-preflight-"));
  let checked;
  try {
    checked = await checkIn(home);
  } catch (error) {
    console.error(
      `[chaos] the preflight failed (${failureCode(error)}); kept ${home}`
    );
    throw error;
  }
  const { readiness } = checked;
  const problems = [];
  if (!checked.free)
    problems.push(
      `무료 모델을 확인하지 못함(${readiness.status}, ${readiness.reason})`
    );
  if (checked.probe !== "ended" || checked.recordsLeft !== 0) {
    console.error(
      `[chaos] the preflight could not confirm that the programs it started ended (readiness ${readiness.status}/${readiness.reason}, process records left ${checked.recordsLeft}); kept ${home}`
    );
    problems.push(
      `확인이 띄운 프로그램의 끝을 확인하지 못함, 임시 홈을 남김(${home})`
    );
  } else {
    // 지우기 실패는 확인 결과를 버리지 않고 문제로 더한다(증거 파일에 남는다).
    const [unremoved] = await attemptEach([() => removeFolderWithin(home)]);
    if (unremoved !== undefined)
      problems.push(
        `임시 홈을 지우지 못함(${failureCode(unremoved)}), 남김(${home})`
      );
  }
  return problems.length > 0
    ? { problem: problems.join("; ") }
    : { readiness: readiness.status };
}

const evidenceDir = path.join(
  repoRoot,
  ".scratch/chaos",
  new Date().toISOString().replace(/[:.]/g, "-")
);
console.log(
  JSON.stringify({
    plan: {
      connection: "opencode",
      model: "product-default-free",
      scenes: launch.scenes,
      maxLiveRuns: launch.maxLiveRuns,
      totalMinutes: limits.totalMs / 60_000,
    },
  })
);
const startedAt = Date.now();
const checked = await preflight();
let summary, secrets;
if (checked.problem) {
  summary = {
    outcome: "incomplete",
    connection: "opencode",
    reason: checked.problem,
    liveRuns: 0,
    scenes: scenes.map((s) => ({
      id: s.id,
      title: s.title,
      optional: !!s.optional,
      outcome: "not_run",
      reason: checked.problem,
      checks: [],
    })),
  };
  secrets = new Set();
} else
  ({ summary, secrets } = await runChaos({
    launch,
    connection: "opencode",
    scenes,
    signal: stop.signal,
    startedAt,
    log: (line) => console.log(line),
  }));
if (stop.signal.aborted) summary = { ...summary, interrupted: true };
const { file, evidence } = await writeEvidence(evidenceDir, summary, secrets);
for (const scene of evidence.scenes)
  console.log(
    `${scene.id} ${scene.title}: ${scene.outcome}${scene.reason ? ` (${scene.reason})` : ""}`
  );
console.log(
  JSON.stringify({
    outcome: evidence.outcome,
    liveRuns: evidence.liveRuns,
    evidence: path.relative(repoRoot, file),
  })
);
process.exit(
  await afterOutput(stop.signal.aborted ? 130 : exitCodeOf(evidence.outcome))
);
