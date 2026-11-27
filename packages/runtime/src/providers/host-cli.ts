import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ModelOption } from "@babojubot/contracts";
import { orIfUnreadable } from "@babojubot/contracts";
import { providerEnvironment, saysLoginProblem } from "./process.ts";
import { record } from "./record.ts";

/** 호스트 로그인(XDG 설정·Linux 데스크톱 키링)을 읽을 때 유지할 사용자 환경 변수. 격리 실행에는 쓰지 않는다. */
const hostLoginVariables = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

/**
 * 종료 코드 0인 정상 출력에서도 로그인 없음·로그인 요구를 확실히 가른다.
 * 내부에서 ANSI 코드를 먼저 걷어내므로 호출자가 전처리를 빠뜨려도 단어 경계(`\b`)가 어긋나지 않는다.
 */
export const isExplicitlySignedOut = (text: string): boolean =>
  /\b(?:not logged in|not signed in|not authenticated|logged out|signed out|must be logged in|must be signed in|please (?:log ?in|sign ?in)|log ?in required|sign ?in required|authentication required)\b/i.test(
    stripVTControlCharacters(text)
  );

/**
 * 종료 코드 0인 평문 한 줄이 명확한 로그인 확인 문구를 담았는지 판단한다.
 * 빈 줄, 부정·요구·만료 문맥, 또는 `401`·`unauthorized`·`failed`·`error`가 같은 줄에 섞인 오류 문장은 거짓이다.
 */
export const isPositiveLoginLine = (text: string): boolean => {
  const clean = stripVTControlCharacters(text);
  if (
    isExplicitlySignedOut(clean) ||
    /\b(?:401|unauthori[sz]ed|failed|error|expired|invalid|revoked|previously)\b/i.test(
      clean
    )
  )
    return false;
  return /\b(?:you are logged in|you are signed in|logged in (?:with|as|to)\b|signed in (?:with|as|to)\b|authenticated (?:with|as)\b)/i.test(
    clean
  );
};

/** 여러 줄 출력 중 하나라도 명확한 로그인 확인 줄을 담았는지 줄 단위로 판단한다. */
export const hasPositiveLoginLine = (text: string): boolean =>
  stripVTControlCharacters(text)
    .split("\n")
    .some((line) => isPositiveLoginLine(line));

/**
 * 실패 응답·stderr·오류 문구가 로그인 문제인지 줄 단위로 판단한다.
 * `"Authenticated with ..."` 같은 정상 로그인 안내 줄은 제외해 `saysLoginProblem`의 `authenticat` 오탐을 막는다.
 */
export const isAuthProblem = (text: string): boolean => {
  const clean = stripVTControlCharacters(text);
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
  const trimmed = stripVTControlCharacters(text).trim();
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
    if (!id || seen.has(id)) continue;
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
 * 번호 목록(`1.`), 구두점으로 끝나는 토큰, 일반 영문 문장·도움말(`- Help`, `- Help (show usage)`,
 * `- login   Sign in`, `- v2 API enabled`, `- non-interactive mode`)을 배제하고,
 * 단독 버전 ID(`- grok-4.5`), 구조화된 모델 ID의 괄호 메타데이터 줄(`* grok-fast (default)`,
 * `* claude-opus (default) - desc`), 또는 2칸 이상 공백 열 설명(`* auto  Automatic selection`)을 읽는다.
 */
export function parsePlainBulletModels(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const row of stripVTControlCharacters(stdout).split("\n")) {
    const match = /^\s*[*+-]\s+(\S+)(.*)$/.exec(row);
    const id = match?.[1];
    if (!id || seen.has(id)) continue;
    if (!/^[A-Za-z][A-Za-z0-9._:/-]*[A-Za-z0-9]$/.test(id)) continue;
    const rest = match?.[2] ?? "";
    const trimmedRest = rest.trim();
    const hasNoTrailing = trimmedRest === "";
    const hasParenthetical = /^\([^)]*\)/.test(trimmedRest);
    const hasColumnDescription = /^\s{2,}\S/.test(rest);
    const isStructuredModelId = id === "auto" || /[0-9._:/-]/.test(id);
    const valid =
      (hasNoTrailing && (/\d/.test(id) || id === "auto")) ||
      ((hasParenthetical || hasColumnDescription) && isStructuredModelId);
    if (!valid) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

/** JSON 모델 목록을 우선 읽고, JSON이 아니면 평문 글머리 목록을 읽는다. */
export function parseCliModels(stdout: string): ModelOption[] {
  return extractJsonModels(stdout) ?? parsePlainBulletModels(stdout);
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
