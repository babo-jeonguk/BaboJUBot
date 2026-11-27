import os from "node:os";
import type {
  ModelOption,
  ProviderConnection,
  ProviderReadinessCheck,
} from "@babojubot/contracts";
import { record } from "./record.ts";
import {
  commandFor,
  probeEnding,
  probeTimeoutMs,
  runProbe,
} from "./process.ts";
import {
  extractJsonObject,
  extractJsonValue,
  hostProviderEnvironment,
  isAcpAuthProblem,
  isExplicitlySignedOut,
  isPositiveLoginLine,
  probeErrorFields,
  runAcpSession,
  stripAnsi,
} from "./acp-session.ts";

/** 구버전 Kiro CLI가 `--format` 옵션을 알지 못해 거절했는지 판단한다. */
const rejectedFormatFlag = (text: string): boolean => {
  const clean = stripAnsi(text);
  return (
    /--format\b/i.test(clean) &&
    /unexpected|unknown|unrecognized|invalid/i.test(clean)
  );
};

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (value !== null && typeof value === "object")
    return Object.keys(record(value)).length > 0;
  return false;
}

/**
 * `kiro-cli whoami --format json`의 JSON 객체를 3상태로 판정한다(fail-closed).
 * 명시적 양성 증거가 있을 때만 `"ready"`, 명시적 로그아웃이면 `"signed_out"`,
 * 빈 객체(`{}`)나 알 수 없는 형식은 `"unknown"`(`check_failed`)이다.
 */
function classifyWhoamiJson(
  parsed: Record<string, unknown>
): "ready" | "signed_out" | "unknown" {
  if (
    ("account" in parsed && parsed.account === null) ||
    parsed.logged_in === false ||
    parsed.loggedIn === false ||
    parsed.authenticated === false ||
    (typeof parsed.error === "string" && isAcpAuthProblem(parsed.error))
  )
    return "signed_out";
  if ("error" in parsed && parsed.error !== null && parsed.error !== undefined)
    return "unknown";
  if (
    hasNonEmptyValue(parsed.account) ||
    parsed.logged_in === true ||
    parsed.loggedIn === true ||
    parsed.authenticated === true ||
    hasNonEmptyValue(parsed.user) ||
    hasNonEmptyValue(parsed.username) ||
    hasNonEmptyValue(parsed.email) ||
    hasNonEmptyValue(parsed.profile)
  )
    return "ready";
  return "unknown";
}

function classifyProbeFailure(
  error: unknown,
  connectionId: string
): ProviderReadinessCheck {
  const detail = probeErrorFields(error);
  if (detail.code === "ENOENT")
    return { status: "not_ready", reason: "program_missing" };
  const parsed = extractJsonObject(detail.stdout);
  if (parsed && classifyWhoamiJson(parsed) === "signed_out")
    return { status: "not_ready", reason: "product_login_missing" };
  const text = `${detail.stdout}\n${detail.stderr}`;
  if (isAcpAuthProblem(text))
    return { status: "not_ready", reason: "product_login_missing" };
  console.warn(
    `[provider] the ${connectionId} readiness check failed (${probeEnding(error)})`
  );
  return { status: "not_ready", reason: "check_failed" };
}

/**
 * Kiro CLI의 ACP(`kiro-cli acp`). 로그인은 이 컴퓨터의 `kiro-cli login` 세션(`~/.kiro`)이다.
 * 제품 폴더로 HOME을 바꾸면 `~/.kiro`의 로그인이 보이지 않으므로 사용자 HOME을 그대로 쓴다.
 * 실제 프로그램을 띄우는 연결(`isolatable: true`)이지만 인증 중계가 아직 없으므로,
 * 격리 실행 스위치가 꺼져 있을 때만 이 컴퓨터에서 돌고 격리 실행 스위치를 켜면 fail-closed로 거부한다.
 */
export function createKiroProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
}): ProviderConnection {
  const connectionId = options.id ?? "kiro";
  const command = options.command ?? commandFor(connectionId, "kiro-cli");
  const env = () => hostProviderEnvironment(connectionId);
  const probe = async (args: string[], signal: AbortSignal) =>
    (
      await runProbe(command, args, {
        cwd: os.tmpdir(),
        env: env(),
        signal,
        timeout: probeTimeoutMs,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;

  async function checkPlainWhoami(
    signal: AbortSignal
  ): Promise<ProviderReadinessCheck> {
    try {
      const output = await probe(["whoami"], signal);
      if (isExplicitlySignedOut(output))
        return { status: "not_ready", reason: "product_login_missing" };
      if (isPositiveLoginLine(output)) return { status: "ready", reason: null };
      console.warn(
        `[provider] the ${connectionId} readiness check returned an unexpected response`
      );
      return { status: "not_ready", reason: "check_failed" };
    } catch (error) {
      return classifyProbeFailure(error, connectionId);
    }
  }

  const adapter: ProviderConnection["adapter"] = {
    capabilities: {
      steer: false,
      resume: true,
      // 매 실행의 첫 입력에 지침을 다시 붙인다. 세션을 이어 가도 같다.
      reinjectInstructionsOnResume: true,
      usageTokens: false,
      usageCost: false,
      precompact: false,
    },
    loginCommand: `pnpm provider:login ${connectionId}`,
    async checkReadiness(signal) {
      try {
        const output = await probe(["whoami", "--format", "json"], signal);
        const parsed = extractJsonObject(output);
        if (parsed) {
          const verdict = classifyWhoamiJson(parsed);
          if (verdict === "ready") return { status: "ready", reason: null };
          if (verdict === "signed_out")
            return { status: "not_ready", reason: "product_login_missing" };
          console.warn(
            `[provider] the ${connectionId} readiness check returned an unexpected JSON shape`
          );
          return { status: "not_ready", reason: "check_failed" };
        }
        if (isExplicitlySignedOut(output))
          return { status: "not_ready", reason: "product_login_missing" };
        if (isPositiveLoginLine(output))
          return { status: "ready", reason: null };
        console.warn(
          `[provider] the ${connectionId} readiness check returned an unexpected response`
        );
        return { status: "not_ready", reason: "check_failed" };
      } catch (error) {
        const detail = probeErrorFields(error);
        const text = `${detail.stdout}\n${detail.stderr}`;
        if (detail.code !== "ENOENT" && rejectedFormatFlag(text))
          return checkPlainWhoami(signal);
        return classifyProbeFailure(error, connectionId);
      }
    },
    execute(request, control) {
      return runAcpSession(
        {
          logName: "Kiro",
          dataDir: options.dataDir,
          connectionId,
          command,
          // `--agent-engine`과 `--auth-method`는 Kiro CLI 기본값(v3·cli)을 그대로 따라 특정 버전에 묶지 않는다.
          args: ["acp"],
          env: env(),
        },
        request,
        control
      );
    },
  };
  return {
    id: connectionId,
    label: options.label ?? "Kiro CLI",
    isolatable: true,
    login: { command, args: ["login"], env: env() },
    adapter,
    models: [],
    async listModels(signal) {
      let stdout: string;
      try {
        stdout = await probe(
          ["chat", "--list-models", "--format", "json"],
          signal
        );
      } catch (error) {
        const detail = probeErrorFields(error);
        const text = `${detail.stdout}\n${detail.stderr}`;
        if (detail.code === "ENOENT" || !rejectedFormatFlag(text)) throw error;
        stdout = await probe(["chat", "--list-models"], signal);
      }
      const parsed = modelsFrom(stdout);
      if (parsed.length === 0) throw new Error("Kiro returned no models");
      return parsed;
    },
  };
}

/** 목록 JSON(객체 `{ models }` 또는 최상위 배열)과 구버전 평문 글머리 출력을 모두 읽는다. */
function modelsFrom(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  const push = (rawId: string, rawLabel?: string) => {
    const id = rawId.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({ id, label: rawLabel?.trim() || id });
  };
  const json = extractJsonValue(stdout);
  const items = Array.isArray(json)
    ? json
    : json !== null && typeof json === "object"
      ? record(json).models
      : undefined;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === "string") {
        push(item);
        continue;
      }
      const row = record(item);
      const rawId =
        typeof row.model_id === "string"
          ? row.model_id
          : typeof row.id === "string"
            ? row.id
            : "";
      const rawLabel =
        typeof row.model_name === "string"
          ? row.model_name
          : typeof row.name === "string"
            ? row.name
            : typeof row.label === "string"
              ? row.label
              : undefined;
      if (rawId) push(rawId, rawLabel);
    }
    return result;
  }
  for (const row of stripAnsi(stdout).split("\n")) {
    const match =
      /^\s*[*+-]\s+([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\s+(.*))?$/.exec(row);
    const id = match?.[1];
    if (!id) continue;
    const trailing = (match?.[2] ?? "").trim();
    const looksLikeModelId =
      /[-.:/0-9]/.test(id) || trailing === "" || /^\([^)]*\)$/.test(trailing);
    if (looksLikeModelId) push(id);
  }
  return result;
}
