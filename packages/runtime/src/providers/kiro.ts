import os from "node:os";
import path from "node:path";
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
  saysLoginProblem,
} from "./process.ts";
import {
  extractJsonObject,
  hostProviderEnvironment,
  isAcpAuthProblem,
  isExplicitlySignedOut,
  probeErrorFields,
  runAcpSession,
} from "./acp-session.ts";

/** 구버전 Kiro CLI가 `--format` 옵션을 알지 못해 거절했는지 판단한다. */
const rejectedFormatFlag = (text: string): boolean =>
  /--format\b/i.test(text) &&
  /unexpected|unknown|unrecognized|invalid/i.test(text);

/** `kiro-cli whoami --format json`의 JSON 객체가 로그인됨을 뜻하는지. */
function whoamiJsonLoggedIn(parsed: Record<string, unknown>): boolean {
  if ("account" in parsed && parsed.account === null) return false;
  if (parsed.logged_in === false || parsed.authenticated === false)
    return false;
  return true;
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
  const stateDir = path.join(options.dataDir, "providers", connectionId);
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
      return { status: "ready", reason: null };
    } catch (error) {
      const detail = probeErrorFields(error);
      if (detail.code === "ENOENT")
        return { status: "not_ready", reason: "program_missing" };
      const text = `${detail.stdout}\n${detail.stderr}`;
      if (isAcpAuthProblem(text))
        return { status: "not_ready", reason: "product_login_missing" };
      console.warn(
        `[provider] the ${connectionId} readiness check failed (${probeEnding(error)})`
      );
      return { status: "not_ready", reason: "check_failed" };
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
        if (parsed)
          return whoamiJsonLoggedIn(parsed)
            ? { status: "ready", reason: null }
            : { status: "not_ready", reason: "product_login_missing" };
        if (isExplicitlySignedOut(output))
          return { status: "not_ready", reason: "product_login_missing" };
        return { status: "ready", reason: null };
      } catch (error) {
        const detail = probeErrorFields(error);
        if (detail.code === "ENOENT")
          return { status: "not_ready", reason: "program_missing" };
        const parsed = extractJsonObject(detail.stdout);
        if (parsed && !whoamiJsonLoggedIn(parsed))
          return { status: "not_ready", reason: "product_login_missing" };
        const text = `${detail.stdout}\n${detail.stderr}`;
        if (rejectedFormatFlag(text)) return checkPlainWhoami(signal);
        if (saysLoginProblem(text) || isAcpAuthProblem(text))
          return { status: "not_ready", reason: "product_login_missing" };
        console.warn(
          `[provider] the ${connectionId} readiness check failed (${probeEnding(error)})`
        );
        return { status: "not_ready", reason: "check_failed" };
      }
    },
    execute(request, control) {
      return runAcpSession(
        {
          logName: "Kiro",
          stateDir,
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
      const stdout = await probe(
        ["chat", "--list-models", "--format", "json"],
        signal
      );
      const parsed = modelsFrom(stdout);
      if (parsed.length === 0) throw new Error("Kiro returned no models");
      return parsed;
    },
  };
}

/** 목록 JSON. 한 줄·여러 줄 JSON과 앞뒤 안내 줄을 모두 읽는다. */
function modelsFrom(stdout: string): ModelOption[] {
  const parsed = extractJsonObject(stdout);
  if (!parsed) return [];
  const models = parsed.models;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const result: ModelOption[] = [];
  for (const item of models) {
    const row = record(item);
    const rawId =
      typeof row.model_id === "string"
        ? row.model_id
        : typeof row.id === "string"
          ? row.id
          : "";
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawLabel =
      typeof row.model_name === "string"
        ? row.model_name
        : typeof row.name === "string"
          ? row.name
          : typeof row.label === "string"
            ? row.label
            : "";
    const label = rawLabel.trim() || id;
    result.push({ id, label });
  }
  return result;
}
