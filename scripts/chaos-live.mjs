// 사람이 돌리는 실제 OpenCode 장애 검사. CI와 자동 검사는 실제 호출로 부르지 않는다. 구독 사용량이나 비용을 쓴다.
// 실행 중 취소·서버 강제 종료 후 복구·재시작 전후 같은 호출 키·조직 간 동시 실행 제한·실행 중 메시지 전달·세션 재개와 설정 변경을
// 장면마다 새 임시 제품 홈·서버로 확인한다. 결과는 메타데이터만 `.scratch/chaos/<시각>/results.json`에 남긴다.
// 사용법: docs/providers.md "실모델 장애 검사".
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LaunchRefused, limits, parseLaunch } from "./live/chaos-budget.mjs";
import { exitCodeOf, runChaos, writeEvidence } from "./live/chaos-run.mjs";
import { scenes } from "./live/chaos-scenes.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const usage = `Usage: node scripts/chaos-live.mjs --allow-live [--scenes=a,d,e,f,b,c,g]

Runs real OpenCode chaos scenes. Needs explicit permission to use model quota and is refused in CI.
  BABOJUBOT_CHAOS_MAX_LIVE_RUNS  live run budget, 1-${limits.maxLiveRuns} (default ${limits.maxLiveRuns})
  BABOJUBOT_CHAOS_MODEL          OpenCode model ID (default: the product's free-model choice)
  BABOJUBOT_CHAOS_ALT_MODEL      second model for the model-change check (not run without it)`;

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
  process.exit(2);
}

// 사용자 중단(Ctrl-C): 지금 장면을 멈추고 정리한 뒤 결과를 남긴다. 두 번째 Ctrl-C는 바로 끝낸다.
const stop = new AbortController();
process.on("SIGINT", () => {
  if (stop.signal.aborted) process.exit(130);
  console.error(
    "Stopping: cancelling runs and cleaning up. Press Ctrl-C again to quit now."
  );
  stop.abort(new Error("user interrupt"));
});

/** 실제 호출 전 확인: 프로그램·로그인 상태와 쓸 모델. 임시 홈에서 하고 지운다. 사용자 OpenCode 설정·자격 증명은 읽지 않는다. */
async function preflight() {
  const { createOpenCodeProvider } =
    await import("../packages/runtime/src/index.ts");
  const home = await mkdtemp(path.join(tmpdir(), "babojubot-chaos-preflight-"));
  try {
    const connection = createOpenCodeProvider({ dataDir: home });
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]);
    const readiness = await connection.adapter.checkReadiness(signal);
    if (readiness.status === "not_ready")
      return { problem: `OpenCode 준비 안 됨(${readiness.reason})` };
    const models =
      (await connection.listModels?.(signal).catch(() => [])) ?? [];
    const ids = models.map((m) => m.id);
    if (launch.model && ids.length && !ids.includes(launch.model))
      return { problem: "BABOJUBOT_CHAOS_MODEL이 OpenCode 모델 목록에 없음" };
    if (launch.altModel && ids.length && !ids.includes(launch.altModel)) {
      console.error(
        "BABOJUBOT_CHAOS_ALT_MODEL is not in the OpenCode model list; the model-change check will not run."
      );
      launch.altModel = null;
    }
    return { readiness: readiness.status };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
      model: launch.model ?? "product-default-free",
      altModel: launch.altModel,
      scenes: launch.scenes,
      maxLiveRuns: launch.maxLiveRuns,
      totalMinutes: limits.totalMs / 60_000,
    },
  })
);
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
    log: (line) => console.log(line),
  }));
if (stop.signal.aborted) summary.interrupted = true;
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
process.exit(stop.signal.aborted ? 130 : exitCodeOf(evidence.outcome));
