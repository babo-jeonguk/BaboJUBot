import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelOption, RunRequest, RunResult } from "@babojubot/contracts";
import { failureCode, orIfUnreadable } from "@babojubot/contracts";
import { TreeLaunchRefused } from "@babojubot/process";
import { connectionFolders } from "./folders.ts";
import { record } from "./record.ts";
import {
  providerEnvironment,
  saysLoginProblem,
  startProcess,
  startupLimitMs,
} from "./process.ts";

/** 취소를 알린 뒤 프로그램이 스스로 멈추기를 기다리는 한도. */
const cancelGraceMs = 3_000;
/** JSON-RPC 오류 코드: 메서드 미지원(-32601), 잘못된 매개변수(-32602). 과도기 ACP 에이전트의 모델 변경 fallback 판단에만 쓴다. */
const jsonRpcMethodNotFound = -32601;
const jsonRpcInvalidParams = -32602;

/** 호스트 로그인(XDG 설정·Linux 데스크톱 키링)을 읽을 때 유지할 사용자 환경 변수. 격리 실행에는 쓰지 않는다. */
const hostLoginVariables = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/** JSON-RPC로 거절한 요청. 문구는 공개 기록에 넣지 않고 로그인 문제·오류 코드만 가른다. */
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

/** ANSI CSI(`ESC [`)와 OSC(`ESC ]`) 이스케이프 시퀀스를 제거한다. 정규식에 제어 문자를 두지 않는다. */
export function stripAnsi(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) === 0x1b) {
      const next = text[i + 1];
      if (next === "[") {
        let end = i + 2;
        while (end < text.length) {
          const code = text.charCodeAt(end);
          end += 1;
          if (code >= 0x40 && code <= 0x7e) break;
        }
        i = end;
        continue;
      }
      if (next === "]") {
        let end = i + 2;
        while (end < text.length) {
          const code = text.charCodeAt(end);
          if (code === 0x07) {
            end += 1;
            break;
          }
          if (code === 0x1b && text[end + 1] === "\\") {
            end += 2;
            break;
          }
          end += 1;
        }
        i = end;
        continue;
      }
    }
    out += text[i] ?? "";
    i += 1;
  }
  return out;
}

/**
 * 종료 코드 0인 정상 출력에서도 로그인 없음·로그인 요구를 확실히 가른다.
 * 내부에서 ANSI 코드를 먼저 걷어내므로 호출자가 전처리를 빠뜨려도 단어 경계(`\b`)가 어긋나지 않는다.
 */
export const isExplicitlySignedOut = (text: string): boolean =>
  /\b(?:not logged in|not signed in|not authenticated|logged out|signed out|must be logged in|must be signed in|please (?:log ?in|sign ?in)|log ?in required|sign ?in required|authentication required)\b/i.test(
    stripAnsi(text)
  );

/**
 * 종료 코드 0인 평문 출력이 명확한 로그인 확인 문구를 담았는지 판단한다.
 * 빈 출력이나 부정·요구 문맥(`Not authenticated`, `You must be logged in`)은 거짓이다.
 */
export const isPositiveLoginLine = (text: string): boolean => {
  const clean = stripAnsi(text);
  if (isExplicitlySignedOut(clean)) return false;
  return /\b(?:you are logged in|you are signed in|logged in (?:with|as|to)\b|signed in (?:with|as|to)\b|authenticated (?:with|as)\b)/i.test(
    clean
  );
};

/**
 * 실패 응답·stderr·오류 문구가 로그인 문제인지 줄 단위로 판단한다.
 * `"Authenticated with ..."` 같은 정상 로그인 안내 줄은 제외해 `saysLoginProblem`의 `authenticat` 오탐을 막는다.
 */
export const isAcpAuthProblem = (text: string): boolean => {
  const clean = stripAnsi(text);
  for (const line of clean.split("\n")) {
    if (!line.trim() || isPositiveLoginLine(line)) continue;
    if (saysLoginProblem(line) || isExplicitlySignedOut(line)) return true;
  }
  return false;
};

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

/** 문자열 내부 따옴표·이스케이프를 고려해 `start`의 `{` 또는 `[`에 대응하는 닫는 괄호 위치를 찾는다. */
function findBalancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseJsonContainer(text: string): unknown {
  if (!text) return undefined;
  const parsed = orIfUnreadable((): unknown => JSON.parse(text), undefined);
  return parsed !== null && typeof parsed === "object" ? parsed : undefined;
}

/**
 * 앞뒤에 안내 줄이 섞이거나 여러 줄로 들여쓴 출력에서 `openers`로 시작하고 `accept`가 수락하는 JSON 하나를 읽는다.
 * `[1] Loading...` 같은 무관한 브래킷 조각은 `accept`가 거르므로 뒤따르는 실제 JSON을 놓치지 않는다.
 */
function findJsonMatch<T>(
  text: string,
  openers: readonly ("{" | "[")[],
  accept: (value: unknown) => T | undefined
): T | undefined {
  const trimmed = stripAnsi(text).trim();
  const whole = parseJsonContainer(trimmed);
  if (whole !== undefined) {
    const accepted = accept(whole);
    if (accepted !== undefined) return accepted;
  }
  const scan = (lineStartOnly: boolean): T | undefined => {
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch !== "{" && ch !== "[") continue;
      if (!openers.includes(ch)) continue;
      if (lineStartOnly && i > 0 && trimmed[i - 1] !== "\n") continue;
      const end = findBalancedEnd(trimmed, i);
      if (end < 0) continue;
      const parsed = parseJsonContainer(trimmed.slice(i, end + 1));
      if (parsed === undefined) continue;
      const accepted = accept(parsed);
      if (accepted !== undefined) return accepted;
    }
    return undefined;
  };
  return scan(true) ?? scan(false);
}

/** 출력에서 최상위 JSON 객체(`{...}`) 하나를 읽는다. `[1]` 같은 배열 조각은 건너뛴다. */
export function extractJsonObject(
  text: string
): Record<string, unknown> | undefined {
  return findJsonMatch(text, ["{"], (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? record(value)
      : undefined
  );
}

function modelOptionsFromArray(
  items: readonly unknown[]
): ModelOption[] | undefined {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const item of items) {
    let rawId: string;
    let rawLabel: string | undefined;
    if (typeof item === "string") {
      rawId = item;
    } else if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      const row = record(item);
      rawId =
        typeof row.model_id === "string"
          ? row.model_id
          : typeof row.id === "string"
            ? row.id
            : "";
      rawLabel =
        typeof row.model_name === "string"
          ? row.model_name
          : typeof row.name === "string"
            ? row.name
            : typeof row.label === "string"
              ? row.label
              : undefined;
    } else {
      return undefined;
    }
    const id = rawId.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: rawLabel?.trim() || id });
  }
  return models;
}

/**
 * JSON 출력(`{ "models": [...] }` 또는 모델 문자열/객체 최상위 배열)에서 모델 목록을 읽는다.
 * `[2]` 같은 숫자 배열은 모델 목록이 아니므로 `undefined`를 돌려줘 호출자가 평문 파서로 이어 갈 수 있게 한다.
 */
export function extractJsonModels(text: string): ModelOption[] | undefined {
  return findJsonMatch(text, ["{", "["], (value) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return undefined;
      const parsed = modelOptionsFromArray(value);
      return parsed && parsed.length > 0 ? parsed : undefined;
    }
    if (value !== null && typeof value === "object") {
      const candidate = record(value).models;
      if (!Array.isArray(candidate)) return undefined;
      return modelOptionsFromArray(candidate);
    }
    return undefined;
  });
}

/**
 * 평문 글머리 줄에서 모델 목록을 읽는다.
 * 번호 목록(`1.`), 구두점으로 끝나는 토큰, 일반 영문 안내 문장(`- Help`, `- non-interactive mode`, `- run ...`)을 배제하고,
 * 숫자가 든 모델 ID(`grok-4.7`, `Grok-4.8`), 예약어(`auto`), 괄호 메타데이터 또는 2칸 이상 공백 설명이 붙은 식별자를 읽는다.
 */
export function parsePlainBulletModels(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const row of stripAnsi(stdout).split("\n")) {
    const match = /^\s*[*+-]\s+(\S+)(.*)$/.exec(row);
    const id = match?.[1];
    if (!id || seen.has(id)) continue;
    if (!/^[A-Za-z][A-Za-z0-9._:/-]*[A-Za-z0-9]$/.test(id)) continue;
    const rest = match?.[2] ?? "";
    const trimmedRest = rest.trim();
    const hasDigit = /\d/.test(id);
    const hasParenthetical = /^\([^)]*\)$/.test(trimmedRest);
    const hasColumnDescription = /^\s{2,}\S/.test(rest);
    const isKnownAlias = id === "auto";
    const valid =
      hasDigit ||
      isKnownAlias ||
      hasParenthetical ||
      (hasColumnDescription && /^[a-z][a-z0-9._:/-]*$/.test(id));
    if (!valid) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

/**
 * 이 컴퓨터의 기존 CLI 로그인·XDG 설정·Linux 데스크톱 키링을 읽어야 하는 호스트 연결의 환경.
 * 격리 실행(컨테이너)에는 쓰지 않는다.
 */
export function hostProviderEnvironment(
  connectionId: string
): NodeJS.ProcessEnv {
  const userHome = process.env.HOME || os.homedir();
  const localBin = path.join(userHome, ".local", "bin");
  const extra: NodeJS.ProcessEnv = {
    PATH: [localBin, process.env.PATH]
      .filter((part) => part)
      .join(path.delimiter),
  };
  for (const name of hostLoginVariables) {
    if (Object.hasOwn(process.env, name) && process.env[name] !== undefined)
      extra[name] = process.env[name];
  }
  return providerEnvironment(connectionId, userHome, extra);
}

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
    let configOptionsKnown = false;
    let configOptions: unknown;
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
          ) {
            configOptionsKnown = true;
            configOptions = update.configOptions;
            return;
          }
          if (!prompting || params.sessionId !== activeSessionId) return;
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
      const discovered = findModelConfigId(configOptions);
      if (discovered !== undefined) {
        try {
          await setByConfigOption(discovered);
          return;
        } catch (error) {
          if (error instanceof AcpRejection && !isAcpAuthProblem(error.message))
            modelRefused = true;
          throw error;
        }
      }
      if (configOptionsKnown) {
        // configOptions가 내려왔지만 모델 항목이 없는 과도기 ACP 에이전트는 session/set_model을 먼저 시도한다.
        try {
          await setByLegacyMethod();
          return;
        } catch (error) {
          if (!(error instanceof AcpRejection)) throw error;
          if (isAcpAuthProblem(error.message)) throw error;
          if (error.code !== jsonRpcMethodNotFound) {
            modelRefused = true;
            throw error;
          }
        }
        try {
          await setByConfigOption("model");
          return;
        } catch (error) {
          if (error instanceof AcpRejection && !isAcpAuthProblem(error.message))
            modelRefused = true;
          throw error;
        }
      }
      // configOptions 자체가 없는 경우: 표준 session/set_config_option을 먼저 시도하고, 메서드·키 미지원(-32601/-32602)이면 session/set_model로 한 번 fallback한다.
      try {
        await setByConfigOption("model");
      } catch (error) {
        if (!(error instanceof AcpRejection)) throw error;
        if (isAcpAuthProblem(error.message)) throw error;
        if (
          error.code === jsonRpcMethodNotFound ||
          error.code === jsonRpcInvalidParams
        ) {
          try {
            await setByLegacyMethod();
            return;
          } catch (fallbackError) {
            if (
              fallbackError instanceof AcpRejection &&
              !isAcpAuthProblem(fallbackError.message)
            )
              modelRefused = true;
            throw fallbackError;
          }
        }
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
            if (Array.isArray(loaded.configOptions)) {
              configOptionsKnown = true;
              configOptions = loaded.configOptions;
            }
          } catch (error) {
            if (!(error instanceof AcpRejection)) throw error;
            if (isAcpAuthProblem(error.message)) throw error;
          }
        if (!activeSessionId) {
          const opened = await rpc("session/new", sessionParams());
          if (typeof opened.sessionId !== "string" || !opened.sessionId)
            throw new AcpRejection("session id missing");
          activeSessionId = opened.sessionId;
          if (Array.isArray(opened.configOptions)) {
            configOptionsKnown = true;
            configOptions = opened.configOptions;
          }
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
    if (sessionError !== undefined && isAcpAuthProblem(sessionError))
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
    if (
      sessionError === undefined &&
      done !== undefined &&
      isAcpAuthProblem(done.stderr)
    )
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
