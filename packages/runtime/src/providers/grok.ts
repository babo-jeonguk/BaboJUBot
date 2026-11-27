import os from "node:os";
import type { ModelOption, ProviderConnection } from "@babojubot/contracts";
import { record } from "./record.ts";
import {
  commandFor,
  probeEnding,
  probeTimeoutMs,
  runProbe,
} from "./process.ts";
import {
  extractJsonValue,
  hostProviderEnvironment,
  isAcpAuthProblem,
  isExplicitlySignedOut,
  isPositiveLoginLine,
  probeErrorFields,
  runAcpSession,
  stripAnsi,
} from "./acp-session.ts";

/**
 * Grok Build CLI의 ACP(`grok agent --no-leader stdio`). 로그인은 이 컴퓨터의 `grok login`(grok.com, `~/.grok`)이다.
 * 제품 폴더로 HOME을 바꾸면 `~/.grok`의 로그인이 보이지 않으므로 사용자 HOME을 그대로 쓴다.
 * 실제 프로그램을 띄우는 연결(`isolatable: true`)이지만 인증 중계가 아직 없으므로,
 * 격리 실행 스위치가 꺼져 있을 때만 이 컴퓨터에서 돌고 격리 실행 스위치를 켜면 fail-closed로 거부한다.
 * 조직 도구 토큰은 ACP 세션 인자로만 넘기고 `~/.grok`와 작업 폴더에는 쓰지 않는다.
 */
export function createGrokProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
}): ProviderConnection {
  const connectionId = options.id ?? "grok";
  const command = options.command ?? commandFor(connectionId, "grok");
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
        const output = await probe(["models"], signal);
        if (isExplicitlySignedOut(output))
          return { status: "not_ready", reason: "product_login_missing" };
        if (modelsFrom(output).length > 0 || isPositiveLoginLine(output))
          return { status: "ready", reason: null };
        console.warn(
          `[provider] the ${connectionId} readiness check returned an unexpected response`
        );
        return { status: "not_ready", reason: "check_failed" };
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
    },
    execute(request, control) {
      return runAcpSession(
        {
          logName: "Grok",
          dataDir: options.dataDir,
          connectionId,
          command,
          // `--no-leader`는 공유 리더 데몬에 붙지 않고 독립 프로세스로 띄워 감독 실행기가 트리 수명을 소유하게 한다.
          args: ["agent", "--no-leader", "stdio"],
          env: env(),
        },
        request,
        control
      );
    },
  };
  return {
    id: connectionId,
    label: options.label ?? "Grok Build",
    isolatable: true,
    login: { command, args: ["login"], env: env() },
    adapter,
    models: [],
    async listModels(signal) {
      const stdout = await probe(["models"], signal);
      const parsed = modelsFrom(stdout);
      if (parsed.length === 0) throw new Error("Grok returned no models");
      return parsed;
    },
  };
}

/** `grok models` 출력에서 모델 ID를 읽는다. JSON(객체 `{ models }`·최상위 배열)과 ANSI가 섞인 글머리 줄을 모두 받는다. */
function modelsFrom(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  const push = (id: string, label?: string) => {
    const cleanId = id.trim();
    if (!cleanId || seen.has(cleanId)) return;
    seen.add(cleanId);
    models.push({ id: cleanId, label: label?.trim() || cleanId });
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
      const id =
        typeof row.id === "string"
          ? row.id
          : typeof row.model_id === "string"
            ? row.model_id
            : "";
      const label =
        typeof row.label === "string"
          ? row.label
          : typeof row.name === "string"
            ? row.name
            : typeof row.model_name === "string"
              ? row.model_name
              : undefined;
      if (id) push(id, label);
    }
    return models;
  }
  for (const row of stripAnsi(stdout).split("\n")) {
    const match =
      /^\s*[*+-]\s+([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\s+(.*))?$/.exec(row);
    const id = match?.[1];
    if (!id) continue;
    const trailing = (match?.[2] ?? "").trim();
    // 구분자(`-`·`.`·`:`·`/`·숫자)가 있거나 뒤가 비어 있거나 `(default)` 메타데이터인 줄만 모델 ID로 인정해 안내 문장을 배제한다.
    const looksLikeModelId =
      /[-.:/0-9]/.test(id) || trailing === "" || /^\([^)]*\)$/.test(trailing);
    if (looksLikeModelId) push(id);
  }
  return models;
}
