// 실모델 장애 검사(scripts/chaos-live.mjs)의 실행 허용·예산·기록. 실제 모델을 부르지 않는 순수 부분이라 자동 검사가 직접 부른다.
// 예산은 서버 프로세스 안의 실행 관문(gateConnection)이 실제 실행을 시작하기 전에 확인한다. 시작한 뒤 세지 않는다.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  closeSync,
} from "node:fs";
import path from "node:path";

/** 이슈 #154에서 합의한 상한. 여기보다 크게 실행하지 않는다. */
export const limits = Object.freeze({
  /** 전체 실제 모델 실행 수(자동 재실행·실패·서버 복구로 시작한 실행 포함). */
  maxLiveRuns: 24,
  /** 전체 벽시계. */
  totalMs: 35 * 60_000,
  /** 장면 하나의 시한. */
  sceneMs: 480_000,
  /** 시험용 긴 명령의 최대 길이(초). */
  longCommandSeconds: 90,
  /** 입력 토큰 권고 기준. 넘어도 막지 않고 보고한다. */
  inputTokenAdvisory: 200_000,
  /** 장면별 실제 실행 수. 동시 실행 제한 검사만 10회다. */
  sceneRuns: Object.freeze({ d: 10, default: 4 }),
});

export const sceneRunCap = (sceneId) =>
  limits.sceneRuns[sceneId] ?? limits.sceneRuns.default;

export class LaunchRefused extends Error {}

/** CI 환경인지. 값이 비었거나 false·0이면 아니다. */
export function inCi(env) {
  return ["CI", "GITHUB_ACTIONS", "BUILDKITE", "GITLAB_CI"].some((name) => {
    const value = env[name];
    return (
      value !== undefined && value !== "" && !/^(false|0)$/i.test(value.trim())
    );
  });
}

/** `BABOJUBOT_CHAOS_MAX_LIVE_RUNS`: 기본 24. 24 이하 양의 정수만 받는다. */
export function readMaxLiveRuns(value) {
  if (value === undefined || value === "") return limits.maxLiveRuns;
  if (!/^\d+$/.test(value.trim()))
    throw new LaunchRefused(
      `BABOJUBOT_CHAOS_MAX_LIVE_RUNS must be a whole number from 1 to ${limits.maxLiveRuns}, got "${value}"`
    );
  const n = Number(value.trim());
  if (n < 1 || n > limits.maxLiveRuns)
    throw new LaunchRefused(
      `BABOJUBOT_CHAOS_MAX_LIVE_RUNS must be from 1 to ${limits.maxLiveRuns}, got ${n}`
    );
  return n;
}

/**
 * 실행 허용을 확인한다. 실제 호출 전에 부르며, 거절하면 `LaunchRefused`를 던진다.
 * `--allow-live`가 없거나 CI이거나 입력값이 틀리면 거절한다.
 */
export function parseLaunch(argv, env, knownScenes) {
  const flags = new Set(argv.filter((arg) => !arg.startsWith("--scenes=")));
  for (const flag of flags)
    if (flag !== "--allow-live")
      throw new LaunchRefused(
        flag === "--record"
          ? "--record is not allowed: the chaos harness keeps metadata only"
          : `unknown argument ${flag}`
      );
  if (!flags.has("--allow-live"))
    throw new LaunchRefused(
      "Live model calls need --allow-live. They use subscription quota or cost."
    );
  if (inCi(env))
    throw new LaunchRefused(
      "Live model calls are refused in CI even with --allow-live."
    );
  const sceneArg = argv.find((arg) => arg.startsWith("--scenes="));
  const scenes = sceneArg
    ? sceneArg
        .slice("--scenes=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...knownScenes];
  for (const id of scenes)
    if (!knownScenes.includes(id))
      throw new LaunchRefused(`unknown scene "${id}"`);
  if (!scenes.length) throw new LaunchRefused("no scene selected");
  return {
    scenes: knownScenes.filter((id) => scenes.includes(id)),
    maxLiveRuns: readMaxLiveRuns(env.BABOJUBOT_CHAOS_MAX_LIVE_RUNS),
    model: env.BABOJUBOT_CHAOS_MODEL?.trim() || null,
    altModel: env.BABOJUBOT_CHAOS_ALT_MODEL?.trim() || null,
  };
}

/**
 * 실행 기록(JSON Lines). 서버 프로세스는 장면마다 하나씩만 뜨므로 한 프로세스가 쓴다. 읽기는 검사 쪽도 한다.
 * - `claim`: 실제 실행을 시작했다. `refused`: 예산·시간 때문에 시작하지 않았다. `end`: 실행이 돌아왔다.
 * - `steer`: 끼워 넣기 결과(`injected`면 주입한 거절).
 * 비밀값·모델 원문·세션 내용은 남기지 않는다. 세션은 ID의 짧은 해시만 남긴다.
 */
export function createLedger(file) {
  return {
    file,
    append(entry) {
      appendFileSync(
        file,
        JSON.stringify({ at: Date.now(), ...entry }) + "\n",
        {
          mode: 0o600,
        }
      );
    },
    read() {
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

/** 예산 상태: 장면을 시작할 때 검사 쪽이 쓰고 서버 프로세스가 실행마다 읽는다. */
export function writeBudget(file, budget) {
  writeSecretFile(file, JSON.stringify(budget), { replace: true });
}

export function readBudget(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 지금 실제 실행 하나를 시작해도 되는지. 시작 전에 확인하고, 되면 기록까지 한 번에 한다. */
export function claimLiveRun(ledger, budget, { runId, connection, now }) {
  if (!budget) {
    ledger.append({ kind: "refused", scene: null, runId, reason: "no_budget" });
    return { ok: false, reason: "no_budget" };
  }
  const claims = ledger.read().filter((e) => e.kind === "claim");
  const sceneClaims = claims.filter((e) => e.scene === budget.scene).length;
  const reason =
    now >= budget.deadlineAt
      ? "time_limit"
      : claims.length >= budget.maxLiveRuns
        ? "run_limit"
        : sceneClaims >= budget.sceneMaxRuns
          ? "scene_run_limit"
          : null;
  if (reason) {
    ledger.append({ kind: "refused", scene: budget.scene, runId, reason });
    return { ok: false, reason };
  }
  ledger.append({ kind: "claim", scene: budget.scene, runId, connection });
  return { ok: true };
}

/** 세션의 짧은 지문. 내용은 남기지 않고 같은 세션인지만 본다. */
export function sessionFingerprint(session) {
  if (!session || typeof session !== "object") return null;
  const id = typeof session.id === "string" ? session.id : stableJson(session);
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

const stableJson = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
        )
      : v
  );

/** 0600으로 새 파일을 만든다. 있으면 실패한다(`replace`면 지우고 만든다). 토큰·설정처럼 남이 읽으면 안 되는 값에 쓴다. */
export function writeSecretFile(file, content, { replace = false } = {}) {
  if (replace) rmSync(file, { force: true });
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

const budgetRefusal = (reason) => ({
  stopReason: "failed",
  error: `Chaos harness ${reason.replaceAll("_", " ")} reached; the live run was not started.`,
  summary: null,
  usage: null,
  nextSession: null,
});

/**
 * 연결의 adapter를 감싼다. 서버 프로세스 안에서 쓴다.
 * - `live`면 실행 전 예산을 확인하고(넘으면 실제 프로그램을 띄우지 않고 실패로 끝냄), 실행 시도 토큰을 0600 파일로 둔다(끝나면 지움).
 * - 지침을 시험용 지침 하나로 바꾼다(지침 bundle 버전은 그대로라 세션 재개 규칙은 제품 그대로다).
 * - 제어 파일(`control`)에 따라 끼워 넣기 거절을 주입하거나 이번 실행의 지난 대화 맥락을 비운다.
 * - 시작·끝·세션 지문·사용량·끼워 넣기 결과를 실행 기록에 남긴다.
 */
export function gateConnection(
  connection,
  { live, ledgerFile, budgetFile, tokenDir, controlFile, brief }
) {
  const ledger = createLedger(ledgerFile);
  const control = () => {
    try {
      return JSON.parse(readFileSync(controlFile, "utf8"));
    } catch {
      return {};
    }
  };
  const inner = connection.adapter;
  const adapter = {
    ...inner,
    async execute(request, ctl) {
      const runId = request.identity.runId;
      let budget = null;
      try {
        budget = readBudget(budgetFile);
      } catch {
        /* 예산이 없으면 실제 실행을 시작하지 않는다. */
      }
      if (live) {
        const claim = claimLiveRun(ledger, budget, {
          runId,
          connection: connection.id,
          now: Date.now(),
        });
        if (!claim.ok) return budgetRefusal(claim.reason);
      } else {
        ledger.append({
          kind: "fake_run",
          scene: budget?.scene ?? null,
          runId,
          connection: connection.id,
        });
      }
      const tokenFile = path.join(tokenDir, `${runId}.token`);
      if (live) writeSecretFile(tokenFile, request.access.token);
      const settings = control();
      const input = {
        ...request,
        instructions: brief
          ? [{ path: "AGENTS.md", content: brief }]
          : request.instructions,
        ...(settings.stripConversation
          ? { context: { ...request.context, conversation: [] } }
          : {}),
      };
      let result;
      try {
        result = await inner.execute(input, ctl);
        return result;
      } finally {
        rmSync(tokenFile, { force: true });
        ledger.append({
          kind: "end",
          scene: budget?.scene ?? null,
          runId,
          connection: connection.id,
          live: !!live,
          stopReason: result?.stopReason ?? "thrown",
          inputTokens: result?.usage?.inputTokens ?? null,
          outputTokens: result?.usage?.outputTokens ?? null,
          resumedFrom: sessionFingerprint(request.previousSession),
          sessionAfter: sessionFingerprint(result?.nextSession),
          model: request.model,
        });
      }
    },
  };
  if (inner.steer)
    adapter.steer = async (message) => {
      if (control().injectSteerRejection) {
        ledger.append({
          kind: "steer",
          runId: message.runId,
          outcome: "rejected",
          injected: true,
        });
        return "rejected";
      }
      let outcome = "thrown";
      try {
        outcome = await inner.steer(message);
        return outcome;
      } finally {
        ledger.append({
          kind: "steer",
          runId: message.runId,
          outcome,
          injected: false,
        });
      }
    };
  return { ...connection, adapter };
}

/** 구간 목록에서 동시에 열린 최대 개수. 끝이 없으면 아직 열려 있다. 같은 시각의 끝은 시작보다 먼저 센다. */
export function maxOverlap(intervals) {
  const points = [];
  for (const { start, end } of intervals) {
    points.push([start, 1]);
    points.push([end ?? Number.POSITIVE_INFINITY, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0,
    max = 0;
  for (const [, delta] of points) {
    open += delta;
    max = Math.max(max, open);
  }
  return max;
}
