import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunRequest, RunResult } from "@babojubot/contracts";
import { failureCode, orIfUnreadable } from "@babojubot/contracts";
import { TreeLaunchRefused } from "@babojubot/process";
import { record } from "./record.ts";
import {
  providerEnvironment,
  saysLoginProblem,
  startProcess,
  startupLimitMs,
} from "./process.ts";

/** 취소를 알린 뒤 프로그램이 스스로 멈추기를 기다리는 한도. */
const cancelGraceMs = 3_000;
/** JSON-RPC Method not found 오류 코드. 구버전 ACP 에이전트의 모델 변경 메서드 fallback 판단에만 쓴다. */
const jsonRpcMethodNotFound = -32601;

/** JSON-RPC로 거절한 요청. 문구는 공개 기록에 넣지 않고 로그인 문제·메서드 미지원만 가른다. */
export class AcpRejection extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "AcpRejection";
    this.code = code;
  }
}

export const acpFailed = (
  error: string | null = "프로바이더 실행이 실패했습니다."
): RunResult => ({
  stopReason: "failed",
  error,
  summary: null,
  usage: null,
  nextSession: null,
});

/**
 * 종료 코드 0인 정상 출력에서 명시적인 로그아웃 상태만 가른다.
 * `saysLoginProblem`의 `authenticat`·`sign in`은 정상 로그인 안내문에도 나타날 수 있으므로 성공 출력에는 쓰지 않는다.
 */
export const isExplicitlySignedOut = (text: string): boolean =>
  /\b(?:not logged in|not signed in|logged out|signed out)\b/i.test(text);

/** 실패 응답·오류 문구가 로그인 문제인지 판단한다. 공통 문구에 없는 "Not signed in"을 포함한다. */
export const isAcpAuthProblem = (text: string): boolean =>
  saysLoginProblem(text) || /\bnot signed in\b/i.test(text);

/** `runProbe`가 던진 오류에서 종료 코드·출력을 타입 단언 없이 꺼낸다. */
export function probeErrorFields(error: unknown): {
  code: string | number | undefined;
  stdout: string;
  stderr: string;
} {
  const fields = record(error);
  const rawCode = fields.code;
  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? rawCode
      : undefined;
  return {
    code,
    stdout: typeof fields.stdout === "string" ? fields.stdout : "",
    stderr: typeof fields.stderr === "string" ? fields.stderr : "",
  };
}

/** ANSI CSI 이스케이프 시퀀스를 제거한다. 정규식에 제어 문자를 두지 않는다. */
export function stripAnsi(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[") {
      let end = i + 2;
      while (end < text.length) {
        const code = text.charCodeAt(end);
        end += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      i = end;
      continue;
    }
    out += text[i] ?? "";
    i += 1;
  }
  return out;
}

function parsePlainObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const parsed = orIfUnreadable((): unknown => JSON.parse(text), undefined);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  return record(parsed);
}

/**
 * 앞뒤에 안내 줄이 섞이거나 여러 줄로 들여쓴 JSON 출력에서 최상위 객체 하나를 읽는다.
 * 읽을 수 없거나 객체가 아니면 `undefined`를 돌려준다.
 */
export function extractJsonObject(
  text: string
): Record<string, unknown> | undefined {
  const trimmed = stripAnsi(text).trim();
  const whole = parsePlainObject(trimmed);
  if (whole) return whole;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = parsePlainObject(trimmed.slice(firstBrace, lastBrace + 1));
    if (sliced) return sliced;
  }
  for (const row of trimmed.split("\n")) {
    const line = row.trim();
    if (!line.startsWith("{")) continue;
    const parsed = parsePlainObject(line);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * 이 컴퓨터의 로그인(`~/.kiro`, `~/.grok` 등)을 그대로 읽어야 하는 호스트 연결의 환경.
 * 제품 폴더로 HOME을 바꾸면 그 로그인이 보이지 않으므로 사용자 HOME을 유지하고 `~/.local/bin`을 PATH 앞에 둔다.
 */
export function hostProviderEnvironment(
  connectionId: string
): NodeJS.ProcessEnv {
  const userHome = process.env.HOME || os.homedir();
  const localBin = path.join(userHome, ".local", "bin");
  return providerEnvironment(connectionId, userHome, {
    PATH: [localBin, process.env.PATH]
      .filter((part) => part)
      .join(path.delimiter),
  });
}

/** ACP `session/new`·`session/load` 응답의 `configOptions`에서 모델 설정 ID를 찾는다. */
function modelConfigId(sessionConfig: Record<string, unknown>): string {
  const options = sessionConfig.configOptions;
  if (!Array.isArray(options)) return "model";
  const entries = options.map(record);
  const byCategory = entries.find(
    (entry) =>
      entry.category === "model" && typeof entry.id === "string" && entry.id
  );
  if (byCategory && typeof byCategory.id === "string") return byCategory.id;
  const byId = entries.find((entry) => entry.id === "model");
  if (byId && typeof byId.id === "string") return byId.id;
  return "model";
}

/** `session/request_permission` 선택지에서 `allow_once`를 우선 고르고, 없으면 다른 `allow*` 선택을 고른다. */
function choosePermissionOption(
  listed: unknown
): { optionId: string } | undefined {
  if (!Array.isArray(listed)) return undefined;
  const options = listed
    .map(record)
    .filter(
      (option): option is Record<string, unknown> & { optionId: string } =>
        typeof option.optionId === "string" && option.optionId.length > 0
    );
  const once = options.find((option) => option.kind === "allow_once");
  if (once) return { optionId: once.optionId };
  const anyAllow = options.find((option) =>
    String(option.kind).startsWith("allow")
  );
  return anyAllow ? { optionId: anyAllow.optionId } : undefined;
}

/** 지침과 이번 깨우기. 실행 시도 토큰은 조직 도구 헤더에만 있고 여기 넣지 않는다. */
function promptText(request: RunRequest): string {
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

export type AcpSessionOptions = {
  /** 진단 로그에 남길 연결 이름(예: `Kiro`, `Grok`). */
  logName: string;
  /** 프로세스 복구 기록을 저장할 연결 폴더(`providers/<연결>`). */
  stateDir: string;
  command: readonly [string, ...string[]];
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** 인증 거절 문구 판정. 기본값은 `isAcpAuthProblem`. */
  isAuthError?: (message: string) => boolean;
};

/**
 * 표준 ACP(Agent Client Protocol) v1 stdio 세션을 한 번 실행한다.
 * - 격리 실행 요청(`request.execution === "container"`)은 인증 중계 없는 호스트 연결이 우회 실행되지 않도록 거절한다.
 * - 조직 도구 bearer는 ACP `session/new`·`session/load`의 `mcpServers`로만 넘기고 디스크나 명령 인수에 쓰지 않는다.
 * - `initialize`의 `agentCapabilities.loadSession`과 `session/new`·`session/load`의 `configOptions`를 읽어
 *   특정 CLI 버전이나 고정 configId에 묶이지 않고 동작한다. `session/set_config_option`이 `-32601`로 거절되는 구버전은
 *   `session/set_model`로 한 번 fallback하며, 모델 자체가 거절되면 실행하지 않고 실패한다.
 */
export async function runAcpSession(
  options: AcpSessionOptions,
  request: RunRequest,
  control: {
    signal: AbortSignal;
    emit: (activity: unknown) => Promise<void>;
  }
): Promise<RunResult> {
  if (request.execution === "container")
    return acpFailed(
      "이 프로바이더 연결은 격리 실행에서 쓸 인증 중계가 아직 검증되지 않아 실행하지 않았습니다."
    );
  if (control.signal.aborted)
    return { ...acpFailed(null), stopReason: "cancelled" };
  const isAuthError = options.isAuthError ?? isAcpAuthProblem;
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const cwd = request.workspace?.cwd
    ? await realpath(request.workspace.cwd)
    : await realpath(options.stateDir);
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
  const sessionParams = (targetSessionId?: string) => ({
    ...(targetSessionId ? { sessionId: targetSessionId } : {}),
    cwd,
    mcpServers,
  });
  const previous =
    typeof request.previousSession?.id === "string"
      ? request.previousSession.id
      : null;
  let sequence = 0;
  let activeSessionId: string | undefined;
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
    if (activeSessionId && prompting && child) {
      child.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: activeSessionId },
      });
      ending ??= setTimeout(() => child?.end(), cancelGraceMs);
    } else child?.end();
  };
  try {
    child = startProcess({
      stateDir: options.stateDir,
      command: options.command,
      args: [...options.args],
      cwd,
      env: options.env,
      onFrame: async (raw) => {
        const frame = record(raw);
        if (typeof frame.id === "number" && !frame.method) {
          const waiter = pending.get(frame.id);
          if (!waiter) return;
          pending.delete(frame.id);
          if (frame.error) {
            const errObj = record(frame.error);
            const rawCode = errObj.code;
            waiter.reject(
              new AcpRejection(
                String(errObj.message ?? ""),
                typeof rawCode === "number" ? rawCode : undefined
              )
            );
          } else waiter.resolve(record(frame.result));
          return;
        }
        if (frame.method === "session/update") {
          const params = record(frame.params);
          if (!prompting || params.sessionId !== activeSessionId) return;
          const update = record(params.update);
          if (update.sessionUpdate !== "tool_call") return;
          const rawTitle =
            typeof update.title === "string" && update.title.trim()
              ? update.title.trim()
              : "tool";
          const safeTitle = request.access.token
            ? rawTitle.replaceAll(request.access.token, "[redacted]")
            : rawTitle;
          await control.emit({
            type: "tool_use",
            tool: safeTitle.slice(0, 100),
            summary: safeTitle.slice(0, 2_000),
          });
          return;
        }
        if (typeof frame.id !== "number" && typeof frame.id !== "string")
          return;
        if (typeof frame.method !== "string") return;
        if (frame.method === "session/request_permission") {
          const chosen = choosePermissionOption(record(frame.params).options);
          child?.write({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              outcome: chosen
                ? { outcome: "selected", optionId: chosen.optionId }
                : { outcome: "cancelled" },
            },
          });
          return;
        }
        // 처리하지 않는 요청을 열어 두면 턴이 끝나지 않는다.
        child?.write({
          jsonrpc: "2.0",
          id: frame.id,
          error: {
            code: jsonRpcMethodNotFound,
            message: "Method not supported",
          },
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
    let modelRefused = false;
    let outcome: Record<string, unknown> | undefined;
    try {
      if (control.signal.aborted) cancel();
      else {
        const initialized = await rpc("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "babojubot", version: "0.0.0" },
        });
        const canLoadSession =
          record(initialized.agentCapabilities).loadSession !== false;
        let sessionConfig: Record<string, unknown> = {};
        if (previous && canLoadSession)
          try {
            sessionConfig = await rpc("session/load", sessionParams(previous));
            activeSessionId = previous;
          } catch (error) {
            if (!(error instanceof AcpRejection)) throw error;
            if (isAuthError(error.message)) {
              sessionError = error.message;
              throw error;
            }
          }
        if (!activeSessionId) {
          const opened = await rpc("session/new", sessionParams());
          if (typeof opened.sessionId !== "string" || !opened.sessionId)
            throw new AcpRejection("session id missing");
          activeSessionId = opened.sessionId;
          sessionConfig = opened;
          if (previous)
            await control.emit({
              type: "progress",
              text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
            });
        }
        if (request.model)
          try {
            await rpc("session/set_config_option", {
              sessionId: activeSessionId,
              configId: modelConfigId(sessionConfig),
              value: request.model,
            });
          } catch (error) {
            if (!(error instanceof AcpRejection)) throw error;
            if (isAuthError(error.message)) {
              sessionError = error.message;
              throw error;
            }
            if (error.code === jsonRpcMethodNotFound) {
              try {
                await rpc("session/set_model", {
                  sessionId: activeSessionId,
                  modelId: request.model,
                });
              } catch (fallbackError) {
                if (fallbackError instanceof AcpRejection) {
                  if (isAuthError(fallbackError.message))
                    sessionError = fallbackError.message;
                  else modelRefused = true;
                }
                throw fallbackError;
              }
            } else {
              modelRefused = true;
              throw error;
            }
          }
        clearTimeout(startup);
        startup = undefined;
        await control.emit({
          type: "progress",
          text: "프로바이더가 작업을 시작했습니다.",
        });
        prompting = true;
        if (control.signal.aborted) cancel();
        else
          outcome = await rpc("session/prompt", {
            sessionId: activeSessionId,
            prompt: [{ type: "text", text: promptText(request) }],
          });
      }
    } catch (error) {
      if (error instanceof AcpRejection && sessionError === undefined)
        sessionError = error.message;
      if (!control.signal.aborted && !modelRefused)
        console.warn(
          `[provider] the ${options.logName} session ended without a result (${failureCode(error)})`
        );
    } finally {
      if (startup) clearTimeout(startup);
      child.end();
      await child.done;
      if (ending) clearTimeout(ending);
      control.signal.removeEventListener("abort", cancel);
    }
    if (control.signal.aborted)
      return { ...acpFailed(null), stopReason: "cancelled" };
    if (sessionError !== undefined && isAuthError(sessionError))
      return { ...acpFailed(), errorCode: "login_required" };
    if (modelRefused)
      return acpFailed("고른 모델을 쓸 수 없어 실행하지 않았습니다.");
    if (outcome?.stopReason === "end_turn" && activeSessionId)
      return {
        stopReason: "completed",
        error: null,
        summary: null,
        usage: null,
        nextSession: { id: activeSessionId },
      };
    return acpFailed();
  } catch (error) {
    if (error instanceof TreeLaunchRefused) throw error;
    if (!control.signal.aborted)
      console.warn(
        `[provider] the ${options.logName} run failed (${failureCode(error)})`
      );
    return control.signal.aborted
      ? { ...acpFailed(null), stopReason: "cancelled" }
      : acpFailed();
  }
}
