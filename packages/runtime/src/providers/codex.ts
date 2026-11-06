import { lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
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
import {
  startProcess,
  probeTimeoutMs,
  saysLoginProblem,
  commandFor,
  providerEnvironment,
  runProbe,
} from "./process.ts";
import type { ContainerLaunch, ContainerSettings } from "./container.ts";
import { placeAttempt } from "./container.ts";
import { connectionFolders } from "./folders.ts";

export type CodexOptions = {
  dataDir: string;
  mode?: "app-server" | "exec";
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
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
  constructor() {
    super("Protocol request rejected");
  }
}
/** 세션 시작·재개 같은 요청의 응답 제한. 큰 세션을 불러오면 오래 걸린다. */
const requestTimeoutMs = 2 * 60 * 1000;
/** 끼워 넣기 응답 제한. 넘겨도 실행 시도는 끝내지 않는다. */
const steerTimeoutMs = 10_000;
let warnedLinks = false;
/**
 * 모든 조직이 연결의 Codex 로그인 하나를 쓴다. 원본(`original`)은 다른 내용이 없는 로그인 전용 폴더에 두고, `at`(연결 폴더나 조직 폴더의
 * `auth.json`)은 원본을 가리키는 링크로 둔다. Codex는 링크를 따라가 원본 자리에서 바꿔 쓰므로 링크가 남는다.
 * `at`에 보통 파일이 있으면 가장 최근 로그인(예전 연결 폴더 로그인, 링크 대신 파일을 쓴 판)이므로 원본으로 옮긴다.
 * 원본 자리는 모든 조직 컨테이너가 쓸 수 있으므로 보통 파일이 아닌 것(다른 곳을 가리키는 링크 등)은 지운다. 남기면 이 컴퓨터에서 도는 Codex가
 * 로그인을 갱신할 때 링크를 따라가 그 파일을 덮어쓴다.
 * 링크를 만들 수 없는 컴퓨터(권한 없는 Windows)면 `false`이며, 그 실행은 연결 폴더로 돈다.
 */
async function linkLogin(original: string, at: string): Promise<boolean> {
  await mkdir(path.dirname(original), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(at), { recursive: true, mode: 0o700 });
  const source = await lstat(original).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source && !source.isFile())
    await rm(original, { recursive: true, force: true });
  const current = await lstat(at).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current?.isSymbolicLink() && (await readlink(at)) === original)
    return true;
  if (current?.isFile()) await rename(at, original);
  else if (current) await rm(at, { recursive: true, force: true });
  try {
    await symlink(original, at, "file");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 같은 조직의 다른 실행 시도가 먼저 만들었다.
    if (code === "EEXIST") return true;
    if (code === "EPERM" && process.platform === "win32") {
      if (!warnedLinks) {
        warnedLinks = true;
        console.warn(
          "[provider] this machine cannot create file links; Codex runs share the connection folder"
        );
      }
      return false;
    }
    throw error;
  }
  return true;
}

export function createCodexProvider(options: CodexOptions): ProviderConnection {
  const id = options.id ?? "codex";
  const folders = connectionFolders(options.dataDir, id);
  const home = folders.connection;
  /** 연결의 로그인 원본. 컨테이너에는 이 폴더만 함께 쓰기로 넣는다. */
  const loginFolder = path.join(home, "login");
  const original = path.join(loginFolder, "auth.json");
  const command = options.command ?? commandFor(id, "codex");
  const environment = (codexHome = home) =>
    providerEnvironment(id, codexHome, { CODEX_HOME: codexHome });
  const readiness = async (
    signal: AbortSignal
  ): Promise<ProviderReadinessCheck> => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await linkLogin(original, path.join(home, "auth.json"));
    const probe = (args: string[]) =>
      runProbe(command, args, {
        env: environment(),
        cwd: home,
        signal,
        timeout: probeTimeoutMs,
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
    id,
    label: options.label ?? "Codex",
    isolatable: true,
    login: { command, args: ["login"], env: environment() },
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
      const timer = setTimeout(stop, 60000);
      try {
        if (signal.aborted) stop();
        else
          child.write({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "babojubot", version: "0.0.0" } },
          });
        await child.done;
        return complete && !signal.aborted ? models : [];
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
      loginCommand: `pnpm provider:login ${id}`,
      checkReadiness: readiness,
      ...(options.mode === "exec"
        ? {}
        : {
            async steer(message: SteerMessage) {
              return active.get(message.runId)?.(message) ?? "rejected";
            },
          }),
      async execute(request, control) {
        await mkdir(home, { recursive: true, mode: 0o700 });
        if (control.signal.aborted)
          return { ...failed(), stopReason: "cancelled", error: null };
        // 그 조직의 제품 폴더로 돈다. 로그인은 연결의 원본 하나를 링크로 쓴다.
        const organization = folders.organization(
          request.identity.organizationId
        );
        await linkLogin(original, path.join(home, "auth.json"));
        const linked = await linkLogin(
          original,
          path.join(organization, "auth.json")
        );
        // 링크 없이 연결 폴더를 컨테이너에 넣지 않는다.
        if (!linked && request.execution === "container") return failed();
        const codexHome = linked ? organization : home;
        const cwd = request.workspace?.cwd ?? codexHome;
        const placement = placeAttempt(options.container, codexHome, request);
        if (!placement) return failed();
        const container = placement.container?.({
          cwd,
          program: "codex",
          shared: linked ? [loginFolder] : [],
        });
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
          ...environment(codexHome),
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
          return executeExec(request, control, {
            command,
            config: args,
            stateDir: home,
            cwd,
            env,
            container,
          });
        args.unshift("app-server");
        const child = startProcess({
          // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
          stateDir: home,
          command,
          args,
          cwd,
          env,
          container,
          onFrame: async (raw) => {
            const frame = record(raw);
            if (typeof frame.id === "number" && !frame.method) {
              const waiter = pending.get(frame.id);
              if (!waiter) return;
              pending.delete(frame.id);
              clearTimeout(waiter.timer);
              if (frame.error) waiter.reject(new ProtocolRejection());
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
              if (
                turn.status === "failed" &&
                saysLoginProblem(record(turn.error).message)
              )
                result.errorCode = "login_required";
              child.end();
            }
          },
        });
        const rpc = (
          method: string,
          params: unknown,
          timeoutMs = requestTimeoutMs,
          endOnTimeout = true
        ) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error("Protocol response timed out"));
              if (endOnTimeout) child.end();
            }, timeoutMs);
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
              cwd,
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
              // 문구에 기대지 않는다. 프로그램이 재개를 거절하면 새 세션으로 시작한다.
              if (
                !request.previousSession ||
                !(error instanceof ProtocolRejection)
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
                const ack = await rpc(
                  "turn/steer",
                  {
                    threadId,
                    expectedTurnId,
                    clientUserMessageId: message.messageId,
                    input: [{ type: "text", text: message.body }],
                  },
                  steerTimeoutMs,
                  false
                );
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
        await child.done;
        control.signal.removeEventListener("abort", cancel);
        active.delete(request.identity.runId);
        await activities;
        if (control.signal.aborted)
          return { ...failed(), stopReason: "cancelled", error: null };
        return result;
      },
    },
  };
}

async function executeExec(
  request: RunRequest,
  control: Parameters<RuntimeAdapter["execute"]>[1],
  launch: {
    command: readonly [string, ...string[]];
    config: string[];
    /** 프로세스 기록 폴더(연결 폴더). */
    stateDir: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    container?: ContainerLaunch;
  }
): Promise<RunResult> {
  const { command, config, stateDir, cwd, env, container } = launch;
  let id: string | null = null,
    result = failed(),
    loginProblem = false;
  const before = record(request.previousSession?.tokens);
  // 재개한 세션의 사용량은 누적값이다. 이 실행 시도의 몫만 남긴다.
  const delta = (key: string, value: number | null) =>
    value === null ? null : Math.max(0, value - (count(before[key]) ?? 0));
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
    stateDir,
    command,
    args,
    cwd,
    env,
    container,
    onFrame: async (raw) => {
      const frame = record(raw);
      if (
        (frame.type === "error" && saysLoginProblem(frame.message)) ||
        (frame.type === "turn.failed" &&
          saysLoginProblem(record(frame.error).message))
      )
        loginProblem = true;
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
          totals = {
            input_tokens: count(value.input_tokens),
            cached_input_tokens: count(value.cached_input_tokens),
            cache_write_input_tokens: count(value.cache_write_input_tokens),
            output_tokens: count(value.output_tokens),
          },
          input = delta("input_tokens", totals.input_tokens),
          cache = delta("cached_input_tokens", totals.cached_input_tokens);
        result = {
          stopReason: "completed",
          error: null,
          summary: null,
          nextSession: id ? { id, tokens: totals } : null,
          usage: {
            inputTokens:
              input === null ? null : Math.max(0, input - (cache ?? 0)),
            outputTokens: delta("output_tokens", totals.output_tokens),
            cacheReadTokens: cache,
            cacheWriteTokens: delta(
              "cache_write_input_tokens",
              totals.cache_write_input_tokens
            ),
            costUsd: null,
          },
        };
        child.end();
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
    await child.done;
    if (control.signal.aborted)
      return { ...failed(), stopReason: "cancelled", error: null };
    // 문구에 기대지 않는다. 이전 세션으로 시작조차 못 했으면 새 세션으로 한 번 다시 시도한다.
    if (!id && request.previousSession && !loginProblem) {
      await control.emit({
        type: "progress",
        text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
      });
      return executeExec(
        { ...request, previousSession: null },
        control,
        launch
      );
    }
    return result.stopReason === "failed" && loginProblem
      ? { ...result, errorCode: "login_required" as const }
      : result;
  } finally {
    control.signal.removeEventListener("abort", cancel);
  }
}
