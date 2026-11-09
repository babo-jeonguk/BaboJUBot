import { claudeSessionFacts } from "./claude-transcript.ts";
import { claudeModelsFor } from "./claude-models.ts";
import { mkdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderConnection,
  RunResult,
  RunRequest,
  RuntimeAdapter,
  SteerMessage,
  SteerOutcome,
} from "@babojubot/contracts";

import { z } from "zod";
import {
  startProcess,
  probeTimeoutMs,
  startupLimitMs,
  saysLoginProblem,
  commandFor,
  providerEnvironment,
  runProbe,
} from "./process.ts";
import type { ContainerSettings } from "./container.ts";
import { placeAttempt } from "./container.ts";
import { connectionFolders } from "./folders.ts";

export type ClaudeOptions = {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
};
const launchSchema = z.object({
  instructions: z.string(),
  cwd: z.string(),
  model: z.string().nullable(),
});
type ClaudeAttempt = z.infer<typeof launchSchema> & {
  access: RunRequest["access"];
  previousSession: RunRequest["previousSession"];
  prompt: string;
  runId?: string;
  execution?: RunRequest["execution"];
  workspace?: RunRequest["workspace"];
  identity?: RunRequest["identity"];
  /** 이 실행 시도의 조직. 그 조직의 제품 폴더에서 돈다. */
  organizationId: string;
  /** 세션 압축처럼 세션을 다듬는 실행 시도. 이전 세션을 잇지 못하면 새 세션으로 다시 시도하지 않고 실패한다. */
  maintenance?: boolean;
};
/** 실행 시도마다 같은 연결의 값. */
type ClaudeConnection = {
  folders: ReturnType<typeof connectionFolders>;
  command: readonly [string, ...string[]];
  /** 그 제품 폴더로 띄우는 프로그램 환경. */
  environment: (home: string) => NodeJS.ProcessEnv;
  active: Map<string, (message: SteerMessage) => SteerOutcome>;
  container?: ContainerSettings;
};
const failed = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더를 실행하지 못했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
/** 연결 폴더의 제품 로그인 토큰이 있으면 환경에 넣는다. 모든 조직이 이 로그인 하나를 쓴다. 없어도 프로그램에 다른 로그인이 있을 수 있으므로 막지 않는다. */
async function withLogin(connection: string, env: NodeJS.ProcessEnv) {
  try {
    const token = (
      await readFile(path.join(connection, "setup-token"), "utf8")
    ).trim();
    if (token) return { ...env, CLAUDE_CODE_OAUTH_TOKEN: token };
  } catch {
    /* 토큰 파일이 없다. */
  }
  return env;
}
export function createClaudeProvider(
  options: ClaudeOptions
): ProviderConnection {
  const id = options.id ?? "claude";
  const folders = connectionFolders(options.dataDir, id);
  const connectionHome = folders.connection;
  const command = options.command ?? commandFor(id, "claude");
  const active = new Map<string, (message: SteerMessage) => SteerOutcome>();
  const environment = (home: string) =>
    providerEnvironment(id, home, {
      CLAUDE_CONFIG_DIR: path.join(home, "config"),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_AUTOUPDATER: "1",
      // root로 돌면 Claude가 권한 건너뛰기를 거부한다. 컨테이너 같은 환경에서도 돌게 한다.
      ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
    });
  const connection: ClaudeConnection = {
    folders,
    command,
    environment,
    active,
    container: options.container,
  };
  return {
    id,
    label: options.label ?? "Claude Code",
    openModels: true,
    isolatable: true,
    login: {
      command,
      args: ["setup-token"],
      env: environment(connectionHome),
      tokenFile: path.join(connectionHome, "setup-token"),
    },
    models: claudeModelsFor(id),
    adapter: {
      capabilities: {
        steer: true,
        resume: true,
        reinjectInstructionsOnResume: false,
        usageTokens: true,
        usageCost: true,
        precompact: true,
      },
      loginCommand: `pnpm provider:login ${id}`,
      async checkReadiness(signal) {
        await mkdir(connectionHome, { recursive: true, mode: 0o700 });
        // 파일 위치를 가정하지 않고 프로그램에 묻는다.
        try {
          await runProbe(command, ["auth", "status"], {
            env: await withLogin(connectionHome, environment(connectionHome)),
            cwd: connectionHome,
            signal,
            timeout: probeTimeoutMs,
            maxBuffer: 64 * 1024,
          });
          return { status: "unknown", reason: "credentials_unverified" };
        } catch (error) {
          const failure = error as { code?: unknown };
          if (failure.code === "ENOENT")
            return { status: "not_ready", reason: "program_missing" };
          return {
            status: "not_ready",
            reason:
              failure.code === 1 ? "product_login_missing" : "check_failed",
          };
        }
      },
      async precompact({ session, access, execution, organizationId }, signal) {
        const launch = launchSchema.safeParse(session.launch);
        if (!launch.success || typeof session.id !== "string")
          return { ok: false, nextSession: null };
        const result = await executeClaude(
          {
            ...launch.data,
            access,
            previousSession: session,
            prompt: "/compact",
            execution,
            organizationId,
            maintenance: true,
          },
          { signal, emit: async () => {} },
          connection
        );
        return {
          ok: result.stopReason === "completed",
          nextSession:
            result.stopReason === "completed" ? result.nextSession : null,
        };
      },
      async steer(message) {
        return active.get(message.runId)?.(message) ?? "rejected";
      },
      async execute(request, control) {
        if (active.has(request.identity.runId)) return failed();
        try {
          return await executeClaude(
            {
              instructions: request.instructions
                .map((f) => f.content)
                .join("\n\n"),
              cwd:
                request.workspace?.cwd ??
                folders.organization(request.identity.organizationId),
              model: request.model,
              access: request.access,
              previousSession: request.previousSession,
              prompt: JSON.stringify({
                identity: request.identity,
                context: request.context,
                wakeReasons: request.wakeReasons,
              }),
              runId: request.identity.runId,
              execution: request.execution,
              workspace: request.workspace,
              identity: request.identity,
              organizationId: request.identity.organizationId,
            },
            control,
            connection
          );
        } finally {
          active.delete(request.identity.runId);
        }
      },
    },
  };
}

async function executeClaude(
  request: ClaudeAttempt,
  control: Parameters<RuntimeAdapter["execute"]>[1],
  connection: ClaudeConnection
): Promise<RunResult> {
  const { folders, command, active } = connection;
  const home = folders.organization(request.organizationId);
  const env = connection.environment(home);
  const maintenance = request.maintenance ?? false;
  if (control.signal.aborted)
    return { ...failed(), stopReason: "cancelled", error: null };
  const placement = placeAttempt(connection.container, home, request);
  if (!placement) return failed();
  await mkdir(home, { recursive: true, mode: 0o700 });
  // 컨테이너에서는 조직의 제품 폴더가 그 조직의 같은 연결 에이전트 컨테이너에 모두 들어가므로, 토큰이 든 이 실행 시도의 파일은 그 밖에 두고 이 컨테이너에만 읽기로 넣는다.
  const temp = placement.container
    ? await mkdtemp(path.join(os.tmpdir(), "babojubot-attempt-"))
    : await mkdtemp(path.join(home, "attempt-"));
  const launch = placement.container?.({
    cwd: request.cwd,
    program: "claude",
    attempt: temp,
  });
  let result = failed();
  try {
    const config = path.join(temp, "mcp.json");
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          organization: {
            type: "http",
            url: new URL("/api/tools/mcp", request.access.toolsBaseUrl).href,
            headers: { Authorization: `Bearer ${request.access.token}` },
          },
        },
      }),
      { mode: 0o600 }
    );
    const instructions = path.join(temp, "instructions.md");
    await writeFile(instructions, request.instructions, { mode: 0o600 });
    const args = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      config,
      "--dangerously-skip-permissions",
      "--settings",
      JSON.stringify({
        disableAllHooks: true,
        autoMemoryEnabled: false,
        claudeMdExcludes: ["**"],
      }),
      "--append-system-prompt-file",
      instructions,
    ];
    if (request.model) args.push("--model", request.model);
    if (typeof request.previousSession?.id === "string")
      args.push("--resume", request.previousSession.id);
    let completed = false,
      ready = false,
      compacting = false,
      compactBoundary = false;
    const process = startProcess({
      // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
      stateDir: folders.connection,
      command,
      args,
      cwd: request.cwd,
      env: await withLogin(folders.connection, env),
      container: launch,
      onFrame: async (raw) => {
        if (!raw || typeof raw !== "object" || completed) return;
        const frame = raw as Record<string, unknown>;
        if (
          frame.type === "system" &&
          frame.subtype === "compact_boundary" &&
          frame.session_id === request.previousSession?.id
        )
          compactBoundary = true;
        if (frame.type === "system" && frame.subtype === "status")
          compacting = frame.status === "compacting";
        if (frame.type === "system" && frame.subtype === "init") {
          clearTimeout(startup);
          ready = true;
          await control.emit({
            type: "progress",
            text: "프로바이더가 작업을 시작했습니다.",
          });
        }
        if (frame.type !== "result") return;
        completed = true;
        const usage = frame.usage as Record<string, unknown> | undefined;
        const number = (n: unknown) =>
          typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
        // 실제 프로그램은 오류에도 subtype을 success로 낸다.
        const success = frame.subtype === "success" && frame.is_error !== true;
        result = {
          stopReason: success ? "completed" : "failed",
          error: success ? null : "프로바이더 실행이 실패했습니다.",
          summary: null,
          usage: {
            inputTokens: number(usage?.input_tokens),
            outputTokens: number(usage?.output_tokens),
            cacheReadTokens: number(usage?.cache_read_input_tokens),
            cacheWriteTokens: number(usage?.cache_creation_input_tokens),
            costUsd:
              number(frame.total_cost_usd) === null
                ? null
                : Math.max(
                    0,
                    (frame.total_cost_usd as number) -
                      (frame.session_id === request.previousSession?.id &&
                      typeof request.previousSession?.costUsd === "number"
                        ? request.previousSession.costUsd
                        : 0)
                  ),
          },
          nextSession:
            success && typeof frame.session_id === "string"
              ? {
                  id: frame.session_id,
                  costUsd: number(frame.total_cost_usd),
                  launch: {
                    instructions: request.instructions,
                    cwd: request.cwd,
                    model: request.model,
                  },
                }
              : null,
        };
        if (
          !success &&
          (frame.api_error_status === 401 ||
            frame.api_error_status === 403 ||
            saysLoginProblem(frame.result))
        )
          result.errorCode = "login_required";
        process.end();
      },
    });
    const startup = setTimeout(() => process.end(), startupLimitMs);
    if (request.runId)
      active.set(request.runId, (message) => {
        if (
          !ready ||
          completed ||
          compacting ||
          control.signal.aborted ||
          process.closed ||
          // 슬래시 명령만 막는다. "/home/..."처럼 경로로 시작하는 말은 받는다.
          /^\/[^\s/]+(\s|$)/.test(message.body)
        )
          return "rejected";
        return process.write({
          type: "user",
          session_id: "",
          uuid: message.messageId,
          message: { role: "user", content: message.body },
          parent_tool_use_id: null,
        })
          ? "accepted"
          : "rejected";
      });
    const cancel = () => {
      process.write({
        type: "control_request",
        request_id: crypto.randomUUID(),
        request: { subtype: "interrupt" },
      });
      process.end();
    };
    control.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (control.signal.aborted) cancel();
      else
        process.write({
          type: "user",
          session_id: "",
          message: { role: "user", content: request.prompt },
          parent_tool_use_id: null,
        });
      await process.done;
      if (control.signal.aborted)
        return { ...failed(), stopReason: "cancelled", error: null };
      // 문구에 기대지 않는다. 이전 세션으로 시작조차 못 했으면 새 세션으로 한 번 다시 시도한다.
      if (
        !ready &&
        result.stopReason === "failed" &&
        request.previousSession &&
        !maintenance &&
        result.errorCode !== "login_required"
      ) {
        await control.emit({
          type: "progress",
          text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
        });
        return executeClaude(
          { ...request, previousSession: null },
          control,
          connection
        );
      }
      if (!completed) return failed();
      if (
        maintenance &&
        (!compactBoundary ||
          result.nextSession?.id !== request.previousSession?.id)
      )
        return failed();
      if (
        result.stopReason === "completed" &&
        typeof result.nextSession?.id === "string"
      ) {
        const facts = await claudeSessionFacts(home, result.nextSession.id);
        if (facts) result.sessionMaintenance = facts;
      }
      return result;
    } finally {
      clearTimeout(startup);
      control.signal.removeEventListener("abort", cancel);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
