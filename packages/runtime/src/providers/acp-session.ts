import { mkdir, realpath } from "node:fs/promises";
import type { RunRequest, RunResult } from "@babojubot/contracts";
import { failureCode } from "@babojubot/contracts";
import { TreeLaunchRefused } from "@babojubot/process";
import { connectionFolders } from "./folders.ts";
import { isAuthProblem } from "./host-cli.ts";
import { startProcess, startupLimitMs } from "./process.ts";
import { record } from "./record.ts";

/** 취소를 알린 뒤 프로그램이 스스로 멈추기를 기다리는 한도. */
const cancelGraceMs = 3_000;
/** JSON-RPC 오류 코드: 메서드 미지원(-32601), 잘못된 매개변수(-32602). 과도기 ACP 에이전트의 모델 변경 fallback 판단에만 쓴다. */
const jsonRpcMethodNotFound = -32601;
const jsonRpcInvalidParams = -32602;

/** JSON-RPC로 거절한 요청. 문구는 공개 기록에 넣지 않고 로그인 문제·오류 코드만 가른다. */
class AcpRejection extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "AcpRejection";
    this.code = code;
  }
}

const acpFailed = (
  error: string | null = "프로바이더 실행이 실패했습니다."
): RunResult => ({
  stopReason: "failed",
  error,
  summary: null,
  usage: null,
  nextSession: null,
});

/** ACP `configOptions` 배열에서 모델 설정 항목의 `id`를 찾는다. 없으면 `undefined`다. */
function findModelConfigId(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const entries = configOptions.map(record);
  const byCategory = entries.find(
    (entry) =>
      entry.category === "model" && typeof entry.id === "string" && entry.id
  );
  if (byCategory && typeof byCategory.id === "string") return byCategory.id;
  const byId = entries.find((entry) => entry.id === "model");
  if (byId && typeof byId.id === "string") return byId.id;
  return undefined;
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
  /** 진단 로그에 남길 연결 이름. */
  logName: string;
  /** 제품 데이터 폴더(`BABOJUBOT_HOME`). 연결 폴더(복구 기록)와 조직별 작업 폴더를 `connectionFolders`로 나눈다. */
  dataDir: string;
  /** 연결 ID. */
  connectionId: string;
  command: readonly [string, ...string[]];
  args: readonly string[];
  env: NodeJS.ProcessEnv;
};

/**
 * 표준 ACP(Agent Client Protocol) v1 stdio 세션을 한 번 실행한다.
 * - 격리 실행 요청(`request.execution === "container"`)은 인증 중계 없는 호스트 연결이 우회 실행되지 않도록 거절한다.
 * - 프로세스 복구 기록은 연결 폴더(`providers/<연결>`)에만 두고, `workspace`가 없는 `planning` 실행의 `cwd`는
 *   조직별 폴더(`providers/<연결>/organizations/<조직>`)로 분리해 복구 기록과 다른 조직에서 격리한다.
 * - 조직 도구 bearer는 ACP `session/new`·`session/load`의 `mcpServers`로만 넘기고 디스크나 명령 인수에 쓰지 않는다.
 * - `initialize`의 `agentCapabilities.loadSession`과 세션 `configOptions`(`config_option_update` 포함)를 읽어
 *   모델 변경 메서드(`session/set_config_option` / 과도기·구버전 `session/set_model`)를 일반화한다.
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
  try {
    const folders = connectionFolders(options.dataDir, options.connectionId);
    await mkdir(folders.connection, { recursive: true, mode: 0o700 });
    let cwd: string;
    if (request.workspace?.cwd) {
      cwd = await realpath(request.workspace.cwd);
    } else {
      const organizationDir = folders.organization(
        request.identity.organizationId
      );
      await mkdir(organizationDir, { recursive: true, mode: 0o700 });
      cwd = await realpath(organizationDir);
    }
    if (control.signal.aborted)
      return { ...acpFailed(null), stopReason: "cancelled" };

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
    let configOptions: unknown[] | undefined;
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

    const child = startProcess({
      stateDir: folders.connection,
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
          const update = record(params.update);
          if (
            update.sessionUpdate === "config_option_update" &&
            Array.isArray(update.configOptions) &&
            (params.sessionId === activeSessionId ||
              (!activeSessionId && params.sessionId === previous))
          )
            configOptions = update.configOptions;
          return;
        }
        if (typeof frame.id !== "number" && typeof frame.id !== "string")
          return;
        if (typeof frame.method !== "string") return;
        if (frame.method === "session/request_permission") {
          // 취소된 실행에 뒤늦게 도착한 권한 요청은 승인하지 않고 cancelled로 거절한다.
          const chosen = control.signal.aborted
            ? undefined
            : choosePermissionOption(record(frame.params).options);
          child.write({
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
        child.write({
          jsonrpc: "2.0",
          id: frame.id,
          error: {
            code: jsonRpcMethodNotFound,
            message: "Method not supported",
          },
        });
      },
    });
    const cancel = () => {
      if (activeSessionId && prompting) {
        const sent = child.write({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId: activeSessionId },
        });
        if (sent) ending ??= setTimeout(() => child.end(), cancelGraceMs);
        else child.end();
      } else child.end();
    };
    const rpc = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        if (!child.write({ jsonrpc: "2.0", id, method, params })) {
          pending.delete(id);
          reject(new Error("Protocol closed"));
        }
      });
    control.signal.addEventListener("abort", cancel, { once: true });
    startup = setTimeout(() => child.end(), startupLimitMs);
    void child.done.then(() => {
      for (const waiter of pending.values())
        waiter.reject(new Error("Protocol closed"));
      pending.clear();
    });
    let sessionError: string | undefined;
    let modelRefused = false;
    let outcome: Record<string, unknown> | undefined;
    let done: Awaited<ReturnType<typeof startProcess>["done"]> | undefined;

    /** 첫 시도가 `fallbackCodes`에 해당하는 거절일 때만 `fallback`을 한 번 더 시도한다. */
    const tryModelWithFallback = async (
      primary: () => Promise<Record<string, unknown>>,
      fallback: () => Promise<Record<string, unknown>>,
      fallbackCodes: readonly number[]
    ): Promise<void> => {
      try {
        await primary();
      } catch (error) {
        if (
          error instanceof AcpRejection &&
          !isAuthProblem(error.message) &&
          error.code !== undefined &&
          fallbackCodes.includes(error.code)
        ) {
          await fallback();
          return;
        }
        throw error;
      }
    };

    const selectModel = async (
      targetSessionId: string,
      model: string
    ): Promise<void> => {
      const setByConfigOption = (configId: string) =>
        rpc("session/set_config_option", {
          sessionId: targetSessionId,
          configId,
          value: model,
        });
      const setByLegacyMethod = () =>
        rpc("session/set_model", {
          sessionId: targetSessionId,
          modelId: model,
        });
      try {
        const discovered = findModelConfigId(configOptions);
        if (discovered !== undefined) {
          await setByConfigOption(discovered);
          return;
        }
        if (configOptions !== undefined) {
          // configOptions가 내려왔지만 모델 항목이 없는 과도기 ACP 에이전트는 session/set_model을 먼저 시도한다.
          await tryModelWithFallback(
            setByLegacyMethod,
            () => setByConfigOption("model"),
            [jsonRpcMethodNotFound]
          );
          return;
        }
        // configOptions 자체가 없는 경우: 표준 session/set_config_option 후 -32601/-32602일 때만 session/set_model로 fallback한다.
        await tryModelWithFallback(
          () => setByConfigOption("model"),
          setByLegacyMethod,
          [jsonRpcMethodNotFound, jsonRpcInvalidParams]
        );
      } catch (error) {
        if (error instanceof AcpRejection && !isAuthProblem(error.message))
          modelRefused = true;
        throw error;
      }
    };

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
        if (previous && canLoadSession)
          try {
            const loaded = await rpc("session/load", sessionParams(previous));
            activeSessionId = previous;
            if (Array.isArray(loaded.configOptions))
              configOptions = loaded.configOptions;
          } catch (error) {
            if (!(error instanceof AcpRejection)) throw error;
            if (isAuthProblem(error.message)) throw error;
            // 실패한 session/load 도중 받은 configOptions가 새 세션으로 누출되지 않게 초기화한다.
            configOptions = undefined;
          }
        if (!activeSessionId) {
          const opened = await rpc("session/new", sessionParams());
          if (typeof opened.sessionId !== "string" || !opened.sessionId)
            throw new AcpRejection("session id missing");
          activeSessionId = opened.sessionId;
          if (Array.isArray(opened.configOptions))
            configOptions = opened.configOptions;
          if (previous)
            await control.emit({
              type: "progress",
              text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
            });
        }
        if (request.model) await selectModel(activeSessionId, request.model);
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
      if (error instanceof AcpRejection) sessionError = error.message;
      if (!control.signal.aborted && !modelRefused)
        console.warn(
          `[provider] the ${options.logName} session ended without a result (${failureCode(error)})`
        );
    } finally {
      if (startup) clearTimeout(startup);
      child.end();
      done = await child.done;
      if (ending) clearTimeout(ending);
      control.signal.removeEventListener("abort", cancel);
    }
    if (control.signal.aborted)
      return { ...acpFailed(null), stopReason: "cancelled" };
    if (sessionError !== undefined && isAuthProblem(sessionError))
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
    if (done !== undefined && isAuthProblem(done.stderr))
      return { ...acpFailed(), errorCode: "login_required" };
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
