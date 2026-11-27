import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ModelOption,
  ProviderConnection,
  RunRequest,
  RunResult,
} from "@babojubot/contracts";
import { failureCode, orIfUnreadable } from "@babojubot/contracts";
import { TreeLaunchRefused } from "@babojubot/process";
import { record } from "./record.ts";
import {
  commandFor,
  probeTimeoutMs,
  providerEnvironment,
  runProbe,
  saysLoginProblem,
  startProcess,
  startupLimitMs,
} from "./process.ts";

/** 취소를 알린 뒤 프로그램이 스스로 멈추기를 기다리는 한도. */
const cancelGraceMs = 3_000;
/** JSON-RPC로 거절한 요청. 문구는 공개 기록에 넣지 않고 로그인 문제만 가른다. */
class AcpRejection extends Error {}

const failed = (
  error: string | null = "프로바이더 실행이 실패했습니다."
): RunResult => ({
  stopReason: "failed",
  error,
  summary: null,
  usage: null,
  nextSession: null,
});

/**
 * Kiro CLI 3.6의 V3 ACP(`kiro-cli acp --agent-engine=v3`). 로그인은 이 컴퓨터의 `kiro-cli login` 세션이다.
 * 제품 폴더로 HOME을 바꾸면 `~/.kiro`의 로그인이 보이지 않으므로, 이 연결만 사용자의 HOME을 그대로 쓴다.
 * 격리 실행은 하지 않는다. 인증 중계가 없고, 컨테이너에 그 로그인을 넣지 않는다.
 */
export function createKiroProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
}): ProviderConnection {
  const connectionId = options.id ?? "kiro";
  const command = options.command ?? commandFor(connectionId, "kiro-cli");
  const userHome = process.env.HOME || os.homedir();
  const localBin = path.join(userHome, ".local", "bin");
  const env = providerEnvironment(connectionId, userHome, {
    // 로그인 셸이 아니면 kiro-cli가 ~/.local/bin에만 있는 경우가 있다.
    PATH: [localBin, process.env.PATH]
      .filter((part) => part)
      .join(path.delimiter),
  });
  const stateDir = path.join(options.dataDir, "providers", connectionId);
  const probe = async (args: string[], signal: AbortSignal) =>
    (
      await runProbe(command, args, {
        cwd: os.tmpdir(),
        env,
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
        const output = await probe(["whoami"], signal);
        if (!/logged in/i.test(output) || saysLoginProblem(output))
          return { status: "not_ready", reason: "product_login_missing" };
        return { status: "ready", reason: null };
      } catch (error) {
        const detail = error as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
        };
        if (detail.code === "ENOENT")
          return { status: "not_ready", reason: "program_missing" };
        const text = `${detail.stdout ?? ""}\n${detail.stderr ?? ""}`;
        if (saysLoginProblem(text))
          return { status: "not_ready", reason: "product_login_missing" };
        console.warn(
          `[provider] the Kiro login check failed (${failureCode(error)})`
        );
        return { status: "not_ready", reason: "check_failed" };
      }
    },
    async execute(request, control) {
      if (control.signal.aborted)
        return { ...failed(null), stopReason: "cancelled" };
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const cwd = request.workspace?.cwd
        ? await realpath(request.workspace.cwd)
        : await realpath(stateDir);
      const mcpServers = [
        {
          type: "http",
          name: "organization",
          url: new URL("/api/tools/mcp", request.access.toolsBaseUrl).href,
          headers: [
            { name: "Authorization", value: `Bearer ${request.access.token}` },
          ],
        },
      ];
      const sessionParams = (sessionId?: string) => ({
        ...(sessionId ? { sessionId } : {}),
        cwd,
        mcpServers,
        ...(request.model
          ? { _meta: { kiro: { modelId: request.model } } }
          : {}),
      });
      const previous =
        typeof request.previousSession?.id === "string"
          ? request.previousSession.id
          : null;
      let sequence = 0;
      let sessionId: string | undefined;
      let prompting = false;
      const pending = new Map<
        number,
        {
          resolve: (value: Record<string, unknown>) => void;
          reject: (error: Error) => void;
        }
      >();
      let startup: ReturnType<typeof setTimeout> | undefined;
      let ending: ReturnType<typeof setTimeout> | undefined;
      let child: ReturnType<typeof startProcess> | undefined;
      const cancel = () => {
        if (sessionId && prompting && child) {
          child.write({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId },
          });
          ending ??= setTimeout(() => child?.end(), cancelGraceMs);
        } else child?.end();
      };
      try {
        child = startProcess({
          stateDir,
          command,
          args: ["acp", "--agent-engine", "v3", "--auth-method", "cli"],
          cwd,
          env,
          onFrame: async (raw) => {
            const frame = record(raw);
            if (typeof frame.id === "number" && !frame.method) {
              const waiter = pending.get(frame.id);
              if (!waiter) return;
              pending.delete(frame.id);
              if (frame.error)
                waiter.reject(
                  new AcpRejection(String(record(frame.error).message ?? ""))
                );
              else waiter.resolve(record(frame.result));
              return;
            }
            if (frame.method === "session/update") {
              const params = record(frame.params);
              if (!prompting || params.sessionId !== sessionId) return;
              const update = record(params.update);
              if (update.sessionUpdate !== "tool_call") return;
              const title =
                typeof update.title === "string" && update.title.trim()
                  ? update.title.trim()
                  : "tool";
              await control.emit({
                type: "tool_use",
                tool: title.slice(0, 100),
                summary: title.slice(0, 2_000),
              });
              return;
            }
            if (typeof frame.id !== "number") return;
            if (frame.method === "session/request_permission") {
              const listed = record(frame.params).options;
              const allow = (Array.isArray(listed) ? listed : [])
                .map(record)
                .find(
                  (option) =>
                    typeof option.optionId === "string" &&
                    String(option.kind).startsWith("allow")
                );
              child?.write({
                jsonrpc: "2.0",
                id: frame.id,
                result: {
                  outcome: allow
                    ? { outcome: "selected", optionId: allow.optionId }
                    : { outcome: "cancelled" },
                },
              });
              return;
            }
            // 처리하지 않는 요청을 열어 두면 턴이 끝나지 않는다.
            child?.write({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32601, message: "Method not supported" },
            });
          },
        });
        const rpc = (method: string, params: unknown) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            if (!child?.write({ jsonrpc: "2.0", id, method, params })) {
              pending.delete(id);
              reject(new Error("Protocol closed"));
            }
          });
        control.signal.addEventListener("abort", cancel, { once: true });
        startup = setTimeout(() => child?.end(), startupLimitMs);
        void child.done.then(() => {
          for (const waiter of pending.values())
            waiter.reject(new Error("Protocol closed"));
          pending.clear();
        });
        let sessionError: string | undefined;
        let outcome: Record<string, unknown> | undefined;
        try {
          if (control.signal.aborted) cancel();
          else {
            await rpc("initialize", {
              protocolVersion: 1,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
              clientInfo: { name: "babojubot", version: "0.0.0" },
            });
            if (previous)
              try {
                await rpc("session/load", sessionParams(previous));
                sessionId = previous;
              } catch (error) {
                if (!(error instanceof AcpRejection)) throw error;
                if (saysLoginProblem(error.message)) {
                  sessionError = error.message;
                  throw error;
                }
                await control.emit({
                  type: "progress",
                  text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
                });
              }
            if (!sessionId) {
              const opened = await rpc("session/new", sessionParams());
              if (typeof opened.sessionId !== "string" || !opened.sessionId)
                throw new AcpRejection("session id missing");
              sessionId = opened.sessionId;
            }
            if (request.model)
              try {
                await rpc("session/set_config_option", {
                  sessionId,
                  configId: "model",
                  value: request.model,
                });
              } catch (error) {
                if (error instanceof AcpRejection) {
                  child.end();
                  await child.done;
                  return failed("고른 모델을 쓸 수 없어 실행하지 않았습니다.");
                }
                throw error;
              }
            clearTimeout(startup);
            startup = undefined;
            await control.emit({
              type: "progress",
              text: "프로바이더가 작업을 시작했습니다.",
            });
            prompting = true;
            if (control.signal.aborted) cancel();
            outcome = await rpc("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: promptText(request) }],
            });
          }
        } catch (error) {
          if (error instanceof AcpRejection) sessionError = error.message;
          if (!control.signal.aborted)
            console.warn(
              `[provider] the Kiro session ended without a result (${failureCode(error)})`
            );
        } finally {
          if (startup) clearTimeout(startup);
          child.end();
          await child.done;
          if (ending) clearTimeout(ending);
          control.signal.removeEventListener("abort", cancel);
        }
        if (control.signal.aborted)
          return { ...failed(null), stopReason: "cancelled" };
        if (sessionError !== undefined && saysLoginProblem(sessionError))
          return { ...failed(), errorCode: "login_required" };
        if (outcome?.stopReason === "end_turn" && sessionId)
          return {
            stopReason: "completed",
            error: null,
            summary: null,
            usage: null,
            nextSession: { id: sessionId },
          };
        return failed();
      } catch (error) {
        if (error instanceof TreeLaunchRefused) throw error;
        if (!control.signal.aborted)
          console.warn(
            `[provider] the Kiro run failed (${failureCode(error)})`
          );
        return control.signal.aborted
          ? { ...failed(null), stopReason: "cancelled" }
          : failed();
      }
    },
  };
  return {
    id: connectionId,
    label: options.label ?? "Kiro CLI",
    login: { command, args: ["login"], env },
    adapter,
    models: [
      { id: "auto", label: "auto" },
      { id: "claude-haiku-5.5", label: "Claude Haiku 5.5" },
    ],
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

/** 목록 JSON. 앞뒤에 안내 줄이 있어도 객체로 시작하는 줄을 읽는다. */
function modelsFrom(stdout: string): ModelOption[] {
  const line = stdout
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.startsWith("{"));
  if (!line) return [];
  const parsed = orIfUnreadable((): unknown => JSON.parse(line), undefined);
  if (parsed === undefined) return [];
  const models = record(parsed).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((item) => {
    const row = record(item);
    const id = typeof row.model_id === "string" ? row.model_id.trim() : "";
    const label =
      typeof row.model_name === "string" && row.model_name.trim()
        ? row.model_name.trim()
        : id;
    return id ? [{ id, label }] : [];
  });
}

/** 지침과 이번 깨우기. 실행 시도 토큰은 조직 도구 헤더에만 있고 여기 넣지 않는다. */
function promptText(request: RunRequest) {
  return (
    request.instructions.map((file) => file.content).join("\n\n") +
    "\n\n" +
    JSON.stringify({
      identity: request.identity,
      context: request.context,
      wakeReasons: request.wakeReasons,
    })
  );
}
