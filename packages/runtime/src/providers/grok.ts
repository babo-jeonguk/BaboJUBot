import os from "node:os";
import type { ProviderConnection } from "@babojubot/contracts";
import {
  commandFor,
  probeEnding,
  probeTimeoutMs,
  runProbe,
} from "./process.ts";
import {
  hasPositiveLoginLine,
  hostProviderEnvironment,
  isAcpAuthProblem,
  isExplicitlySignedOut,
  parseCliModels,
  probeErrorFields,
} from "./host-cli.ts";
import { runAcpSession } from "./acp-session.ts";

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
  const probe = (args: string[], signal: AbortSignal) =>
    runProbe(command, args, {
      cwd: os.tmpdir(),
      env: env(),
      signal,
      timeout: probeTimeoutMs,
      maxBuffer: 1024 * 1024,
    });
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
        const { stdout, stderr } = await probe(["models"], signal);
        if (isExplicitlySignedOut(`${stdout}\n${stderr}`))
          return { status: "not_ready", reason: "product_login_missing" };
        if (parseCliModels(stdout).length > 0 || hasPositiveLoginLine(stdout))
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
      const { stdout } = await probe(["models"], signal);
      const parsed = parseCliModels(stdout);
      if (parsed.length === 0) throw new Error("Grok returned no models");
      return parsed;
    },
  };
}
