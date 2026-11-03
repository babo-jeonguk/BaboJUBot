import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  ProviderConnection,
  ProviderReadinessCheck,
  RunResult,
  Usage,
  RuntimeAdapter,
  RunRequest,
  SteerMessage,
  SteerOutcome,
} from "@babojubot/contracts";
import { startProcess } from "./process.ts";

export type CodexOptions = {
  dataDir: string;
  mode?: "app-server" | "exec";
  command?: readonly [string, ...string[]];
};
const failed = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더 실행이 실패했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
class ProtocolRejection extends Error {
  readonly missingThread: boolean;
  constructor(error: unknown) {
    super("Protocol request rejected");
    const message = record(error).message;
    this.missingThread =
      typeof message === "string" &&
      /thread not found|no rollout found/i.test(message);
  }
}
export function createCodexProvider(options: CodexOptions): ProviderConnection {
  const home = path.resolve(options.dataDir, "providers/codex");
  const command = options.command ?? ["codex"];
  const environment = () => ({
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: home,
  });
  const readiness = async (
    signal: AbortSignal
  ): Promise<ProviderReadinessCheck> => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const probe = (args: string[]) =>
      promisify(execFile)(command[0], [...command.slice(1), ...args], {
        env: environment(),
        cwd: home,
        signal,
        timeout: 3000,
        maxBuffer: 65536,
      });
    try {
      // 프로그램이 있는지만 본다. 어떤 판이든 실제로 동작하면 쓴다.
      await probe(["--version"]);
    } catch (error) {
      return {
        status: "not_ready",
        reason:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "program_missing"
            : "check_failed",
      };
    }
    try {
      await probe(["login", "status"]);
      return { status: "unknown", reason: "credentials_unverified" };
    } catch (error) {
      return {
        status: "not_ready",
        reason:
          (error as { code?: number }).code === 1
            ? "product_login_missing"
            : "check_failed",
      };
    }
  };
  const active = new Map<
    string,
    (message: SteerMessage) => Promise<SteerOutcome>
  >();
  return {
    id: "codex",
    label: "Codex",
    models: [],
    async listModels(signal) {
      if ((await readiness(signal)).status === "not_ready") return [];
      const models: { id: string; label: string }[] = [];
      let complete = false,
        id = 1;
      const child = startProcess({
        stateDir: home,
        command,
        args: ["app-server"],
        cwd: home,
        env: environment(),
        onFrame: async (raw) => {
          const frame = record(raw);
          if (frame.id !== id || frame.method) return;
          if (frame.error) {
            child.end();
            return;
          }
          if (id === 1) {
            child.write({ method: "initialized" });
            child.write({
              id: ++id,
              method: "model/list",
              params: { limit: 100, includeHidden: false },
            });
            return;
          }
          const result = record(frame.result);
          if (Array.isArray(result.data))
            for (const rawModel of result.data) {
              const model = record(rawModel);
              if (typeof model.model === "string")
                models.push({
                  id: model.model,
                  label:
                    typeof model.displayName === "string"
                      ? model.displayName
                      : model.model,
                });
            }
          if (typeof result.nextCursor === "string")
            child.write({
              id: ++id,
              method: "model/list",
              params: {
                limit: 100,
                includeHidden: false,
                cursor: result.nextCursor,
              },
            });
          else {
            complete = true;
            child.end();
          }
        },
      });
      const stop = () => child.end();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, 10000);
      try {
        if (signal.aborted) stop();
        else
          child.write({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "babojubot", version: "0.0.0" } },
          });
        const exit = await child.done;
        return complete && !signal.aborted && !exit.broken && exit.code === 0
          ? models
          : [];
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    },
    adapter: {
      capabilities: {
        steer: options.mode !== "exec",
        resume: true,
        reinjectInstructionsOnResume: true,
        usageTokens: true,
        usageCost: false,
        precompact: false,
      },
      loginCommand: `CODEX_HOME='${home.replaceAll("'", "'\\''")}' codex login`,
      checkReadiness: readiness,
      ...(options.mode === "exec"
        ? {}
        : {
            async steer(message: SteerMessage) {
              return active.get(message.runId)?.(message) ?? "rejected";
            },
          }),
      async execute(request, control) {
        const checked = await readiness(control.signal);
        if (control.signal.aborted)
          return { ...failed(), stopReason: "cancelled", error: null };
        if (checked.status === "not_ready")
          return {
            ...failed(),
            ...(checked.reason === "product_login_missing"
              ? { errorCode: "login_required" as const }
              : {}),
          };
        let result = failed(),
          threadId = "",
          turnId = "",
          sequence = 0;
        let usage: Usage | null = null;
        let tokens: Record<string, number | null> = {};
        let baseline = record(request.previousSession?.tokens);
        let activities = Promise.resolve();
        const pending = new Map<
          number,
          {
            resolve: (value: Record<string, unknown>) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
          }
        >();
        const env = {
          ...environment(),
          BABOJUBOT_MCP_TOKEN: request.access.token,
        };
        const args = [
          "-c",
          'approval_policy="never"',
          "-c",
          'sandbox_mode="danger-full-access"',
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          `mcp_servers.organization.url=${JSON.stringify(new URL("/api/tools/mcp", request.access.toolsBaseUrl).href)}`,
          "-c",
          'mcp_servers.organization.bearer_token_env_var="BABOJUBOT_MCP_TOKEN"',
        ];
        if (options.mode === "exec")
          return executeExec(request, control, command, args, home, env);
        args.unshift("app-server");
        const child = startProcess({
          stateDir: home,
          command,
          args,
          cwd: request.workspace?.cwd ?? home,
          env,
          onFrame: async (raw) => {
            const frame = record(raw);
            if (typeof frame.id === "number" && !frame.method) {
              const waiter = pending.get(frame.id);
              if (!waiter) return;
              pending.delete(frame.id);
              clearTimeout(waiter.timer);
              if (frame.error)
                waiter.reject(new ProtocolRejection(frame.error));
              else waiter.resolve(record(frame.result));
              return;
            }
            const params = record(frame.params);
            if (params.threadId !== threadId) return;
            if (frame.method === "thread/tokenUsage/updated") {
              const totals = record(record(params.tokenUsage).total);
              tokens = Object.fromEntries(
                [
                  "inputTokens",
                  "outputTokens",
                  "cachedInputTokens",
                  "cacheWriteInputTokens",
                ].map((k) => [k, count(totals[k])])
              );
              const delta = (key: string) =>
                tokens[key] === null
                  ? null
                  : Math.max(
                      0,
                      (tokens[key] ?? 0) - (count(baseline[key]) ?? 0)
                    );
              const input = delta("inputTokens"),
                cache = delta("cachedInputTokens");
              usage = {
                inputTokens:
                  input === null ? null : Math.max(0, input - (cache ?? 0)),
                outputTokens: delta("outputTokens"),
                cacheReadTokens: cache,
                cacheWriteTokens: delta("cacheWriteInputTokens"),
                costUsd: null,
              };
            }
            if (frame.method === "turn/completed") {
              const turn = record(params.turn);
              if (turn.id !== turnId) return;
              active.delete(request.identity.runId);
              result = {
                ...failed(),
                stopReason:
                  turn.status === "completed"
                    ? "completed"
                    : turn.status === "interrupted"
                      ? "cancelled"
                      : "failed",
                error:
                  turn.status === "failed"
                    ? "프로바이더 실행이 실패했습니다."
                    : null,
                usage,
                nextSession: { id: threadId, tokens },
              };
              child.end();
            }
          },
        });
        const rpc = (method: string, params: unknown) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error("Protocol response timed out"));
              child.end();
            }, 3000);
            pending.set(id, { resolve, reject, timer });
            if (!child.write({ id, method, params })) {
              clearTimeout(timer);
              pending.delete(id);
              reject(new Error("Protocol closed"));
            }
          });
        void child.done.then(() => {
          for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(new Error("Protocol closed"));
          }
          pending.clear();
        });
        const cancel = () => {
          if (threadId && turnId)
            child.write({
              id: ++sequence,
              method: "turn/interrupt",
              params: { threadId, turnId },
            });
          child.end();
        };
        control.signal.addEventListener("abort", cancel, { once: true });
        try {
          if (control.signal.aborted) cancel();
          else {
            await rpc("initialize", {
              clientInfo: { name: "babojubot", version: "0.0.0" },
            });
            child.write({ method: "initialized" });
            const config = {
              cwd: request.workspace?.cwd ?? home,
              model: request.model,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              developerInstructions: request.instructions
                .map((f) => f.content)
                .join("\n\n"),
            };
            let started: Record<string, unknown>;
            try {
              started = await rpc(
                request.previousSession?.id ? "thread/resume" : "thread/start",
                {
                  ...config,
                  ...(request.previousSession?.id
                    ? { threadId: request.previousSession.id }
                    : {}),
                }
              );
            } catch (error) {
              if (
                !request.previousSession ||
                !(error instanceof ProtocolRejection) ||
                !error.missingThread
              )
                throw error;
              baseline = {};
              await control.emit({
                type: "progress",
                text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
              });
              started = await rpc("thread/start", config);
            }
            threadId = String(record(started.thread).id);
            const turn = await rpc("turn/start", {
              threadId,
              input: [
                {
                  type: "text",
                  text: JSON.stringify({
                    identity: request.identity,
                    context: request.context,
                    wakeReasons: request.wakeReasons,
                  }),
                },
              ],
            });
            turnId = String(record(turn.turn).id);
            active.set(request.identity.runId, async (message) => {
              if (control.signal.aborted || child.closed) return "rejected";
              const expectedTurnId = turnId;
              try {
                const ack = await rpc("turn/steer", {
                  threadId,
                  expectedTurnId,
                  clientUserMessageId: message.messageId,
                  input: [{ type: "text", text: message.body }],
                });
                return ack.turnId === expectedTurnId ? "accepted" : "rejected";
              } catch (error) {
                if (error instanceof ProtocolRejection) return "rejected";
                throw error;
              }
            });
            activities = activities.then(() =>
              control.emit({
                type: "progress",
                text: "프로바이더가 작업을 시작했습니다.",
              })
            );
          }
        } catch {
          child.end();
        }
        const exit = await child.done;
        control.signal.removeEventListener("abort", cancel);
        active.delete(request.identity.runId);
        await activities;
        if (control.signal.aborted)
          return { ...failed(), stopReason: "cancelled", error: null };
        return exit.broken || exit.code !== 0 ? failed() : result;
      },
    },
  };
}

async function executeExec(
  request: RunRequest,
  control: Parameters<RuntimeAdapter["execute"]>[1],
  command: readonly [string, ...string[]],
  config: string[],
  home: string,
  env: NodeJS.ProcessEnv
): Promise<RunResult> {
  let id: string | null = null,
    result = failed(),
    missingSession = false;
  const args = [
    "exec",
    ...config,
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `developer_instructions=${JSON.stringify(request.instructions.map((f) => f.content).join("\n\n"))}`,
  ];
  if (request.model) args.push("--model", request.model);
  if (typeof request.previousSession?.id === "string")
    args.push("resume", request.previousSession.id);
  args.push("-");
  const child = startProcess({
    stateDir: home,
    command,
    args,
    cwd: request.workspace?.cwd ?? home,
    env,
    onFrame: async (raw) => {
      const frame = record(raw);
      if (
        !id &&
        frame.type === "error" &&
        typeof frame.message === "string" &&
        /no rollout found/i.test(frame.message)
      )
        missingSession = true;
      if (
        frame.type === "thread.started" &&
        typeof frame.thread_id === "string"
      ) {
        id = frame.thread_id;
        await control.emit({
          type: "progress",
          text: "프로바이더가 작업을 시작했습니다.",
        });
      }
      if (frame.type === "turn.completed") {
        const value = record(frame.usage),
          input = count(value.input_tokens),
          cache = count(value.cached_input_tokens);
        result = {
          stopReason: "completed",
          error: null,
          summary: null,
          nextSession: id ? { id } : null,
          usage: {
            inputTokens:
              input === null ? null : Math.max(0, input - (cache ?? 0)),
            outputTokens: count(value.output_tokens),
            cacheReadTokens: cache,
            cacheWriteTokens: count(value.cache_write_input_tokens),
            costUsd: null,
          },
        };
      }
    },
  });
  const cancel = () => {
    child.interrupt();
    child.end();
  };
  control.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (control.signal.aborted) cancel();
    else {
      child.write({
        identity: request.identity,
        context: request.context,
        wakeReasons: request.wakeReasons,
      });
      child.endInput();
    }
    const exit = await child.done;
    if (control.signal.aborted)
      return { ...failed(), stopReason: "cancelled", error: null };
    if (missingSession && request.previousSession && !exit.broken) {
      await control.emit({
        type: "progress",
        text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
      });
      return executeExec(
        { ...request, previousSession: null },
        control,
        command,
        config,
        home,
        env
      );
    }
    return exit.broken || exit.code !== 0 ? failed() : result;
  } finally {
    control.signal.removeEventListener("abort", cancel);
  }
}
