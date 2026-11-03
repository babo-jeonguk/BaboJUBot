import { claudeSessionFacts } from "./claude-transcript.ts";
import { execFile } from "node:child_process";
import { mkdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ProviderConnection,
  RunResult,
  RunRequest,
  RuntimeAdapter,
  SteerMessage,
  SteerOutcome,
} from "@babojubot/contracts";

import { z } from "zod";
import { startProcess } from "./process.ts";

export const claudeVersion = "2.1.316";
export type ClaudeOptions = {
  dataDir: string;
  command?: readonly [string, ...string[]];
};
const launchSchema = z.object({
  version: z.literal(claudeVersion),
  instructions: z.string(),
  cwd: z.string(),
  model: z.string().nullable(),
});
type ClaudeAttempt = z.infer<typeof launchSchema> & {
  access: RunRequest["access"];
  previousSession: RunRequest["previousSession"];
  prompt: string;
  runId?: string;
};
const failed = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더를 실행하지 못했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
export function createClaudeProvider(
  options: ClaudeOptions
): ProviderConnection {
  const home = path.resolve(options.dataDir, "providers/claude");
  const command = options.command ?? ["claude"];
  const active = new Map<string, (message: SteerMessage) => SteerOutcome>();
  const environment = () => ({
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, "config"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_AUTOUPDATER: "1",
  });
  return {
    id: "claude",
    label: "Claude Code",
    models: [
      { id: "haiku", label: "Haiku" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
    ],
    adapter: {
      capabilities: {
        steer: true,
        resume: true,
        reinjectInstructionsOnResume: false,
        usageTokens: true,
        usageCost: true,
        precompact: true,
      },
      loginCommand: `HOME='${home.replaceAll("'", "'\\''")}' claude setup-token`,
      async checkReadiness(signal) {
        await mkdir(home, { recursive: true, mode: 0o700 });
        try {
          const { stdout } = await promisify(execFile)(
            command[0],
            [...command.slice(1), "--version"],
            {
              env: environment(),
              cwd: home,
              signal,
              timeout: 3000,
              maxBuffer: 64 * 1024,
            }
          );
          if (stdout.trim() !== `${claudeVersion} (Claude Code)`)
            return { status: "not_ready", reason: "version_unsupported" };
          try {
            if (
              !(await readFile(path.join(home, "setup-token"), "utf8")).trim()
            )
              throw new Error();
          } catch {
            return { status: "not_ready", reason: "product_login_missing" };
          }
          return { status: "unknown", reason: "credentials_unverified" };
        } catch (error) {
          return {
            status: "not_ready",
            reason:
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "program_missing"
                : "check_failed",
          };
        }
      },
      async precompact({ session, access }, signal) {
        const launch = launchSchema.safeParse(session.launch);
        if (!launch.success || typeof session.id !== "string")
          return { ok: false, nextSession: null };
        const result = await executeClaude(
          {
            ...launch.data,
            access,
            previousSession: session,
            prompt: "/compact",
          },
          { signal, emit: async () => {} },
          home,
          command,
          environment(),
          active,
          true
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
              version: claudeVersion,
              instructions: request.instructions
                .map((f) => f.content)
                .join("\n\n"),
              cwd: request.workspace?.cwd ?? home,
              model: request.model,
              access: request.access,
              previousSession: request.previousSession,
              prompt: JSON.stringify({
                identity: request.identity,
                context: request.context,
                wakeReasons: request.wakeReasons,
              }),
              runId: request.identity.runId,
            },
            control,
            home,
            command,
            environment(),
            active
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
  home: string,
  command: readonly [string, ...string[]],
  env: NodeJS.ProcessEnv,
  active: Map<string, (message: SteerMessage) => SteerOutcome>,
  maintenance = false
): Promise<RunResult> {
  if (control.signal.aborted)
    return { ...failed(), stopReason: "cancelled", error: null };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(path.join(home, "attempt-"));
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
    try {
      env.CLAUDE_CODE_OAUTH_TOKEN = (
        await readFile(path.join(home, "setup-token"), "utf8")
      ).trim();
    } catch {
      return { ...failed(), errorCode: "login_required" };
    }
    if (!env.CLAUDE_CODE_OAUTH_TOKEN)
      return { ...failed(), errorCode: "login_required" };
    try {
      const { stdout } = await promisify(execFile)(
        command[0],
        [...command.slice(1), "--version"],
        {
          env,
          cwd: home,
          signal: control.signal,
          timeout: 3000,
          maxBuffer: 64 * 1024,
        }
      );
      if (stdout.trim() !== `${claudeVersion} (Claude Code)`) return failed();
    } catch {
      return control.signal.aborted
        ? { ...failed(), stopReason: "cancelled", error: null }
        : failed();
    }
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
      "--append-system-prompt",
      request.instructions,
    ];
    if (request.model) args.push("--model", request.model);
    if (typeof request.previousSession?.id === "string")
      args.push("--resume", request.previousSession.id);
    let completed = false,
      ready = false,
      compacting = false,
      missingSession = false,
      compactBoundary = false;
    const process = startProcess({
      stateDir: home,
      command,
      args,
      cwd: request.cwd,
      env,
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
        missingSession =
          !ready &&
          !!request.previousSession &&
          Array.isArray(frame.errors) &&
          frame.errors.some(
            (e) =>
              typeof e === "string" &&
              e.startsWith("No conversation found with session ID:")
          );
        completed = true;
        const usage = frame.usage as Record<string, unknown> | undefined;
        const number = (n: unknown) =>
          typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
        result = {
          stopReason: frame.subtype === "success" ? "completed" : "failed",
          error:
            frame.subtype === "success"
              ? null
              : "프로바이더 실행이 실패했습니다.",
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
            typeof frame.session_id === "string"
              ? {
                  id: frame.session_id,
                  costUsd: number(frame.total_cost_usd),
                  launch: {
                    version: request.version,
                    instructions: request.instructions,
                    cwd: request.cwd,
                    model: request.model,
                  },
                }
              : null,
        };
        process.end();
      },
    });
    const startup = setTimeout(() => process.end(), 10000);
    if (request.runId)
      active.set(request.runId, (message) => {
        if (
          !ready ||
          completed ||
          compacting ||
          control.signal.aborted ||
          process.closed ||
          message.body.startsWith("/")
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
      const exit = await process.done;
      if (control.signal.aborted)
        return { ...failed(), stopReason: "cancelled", error: null };
      if (missingSession && !exit.broken && !maintenance) {
        await control.emit({
          type: "progress",
          text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
        });
        return executeClaude(
          { ...request, previousSession: null },
          control,
          home,
          command,
          env,
          active
        );
      }
      if (exit.broken || exit.code !== 0) return failed();
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
