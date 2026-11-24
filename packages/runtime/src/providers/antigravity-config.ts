import { fileURLToPath } from "node:url";
import { orIfUnreadable } from "@babojubot/contracts";
import { runTree } from "@babojubot/process";
import {
  cleanupReasons,
  type ScriptCleanupReason,
} from "./antigravity-config-reasons.ts";

export const ownerMark = "babojubot-antigravity-v1";

/**
 * 예전 판(#148 전)이 실행마다 작업 폴더에 둔 Antigravity 설정(`.agents/mcp_config.json`)의 남은 것을 서버 시작 때 지운다.
 * 지금은 조직 도구를 ACP 세션을 열 때 실행 시도에만 주므로 작업 폴더에 설정을 쓰지 않는다.
 * Node에는 폴더 핸들로 다루는 기능이 없어, 확인한 뒤 경로로 다시 접근하면 그 사이 .agents가 다른 조직을 가리키도록 바뀔 수 있다.
 * 작업 폴더는 커널이 폴더 자체를 붙들므로, 별도 프로세스(`antigravity-config-clear.ts`)가 .agents로 들어가 확인한 폴더인지 본 뒤
 * 그 안에서만 작업한다. 폴더 들어가기와 파일 열기는 @babojubot/files가 맡는다.
 */
export const configScriptFile = fileURLToPath(
  new URL("./antigravity-config-clear.ts", import.meta.url)
);

/**
 * 스크립트의 까닭을 다 읽지 못한 상태. 정해진 모양이 아닌 줄이 있음, 수집 상한에 닿아 뒤가 버려짐, 지우지 못했다고 끝났는데
 * 까닭이 없음. 읽은 까닭만으로 다 말한 것처럼 넘기지 않는다.
 */
type OutputProblem =
  "unreadable_output" | "truncated_output" | "missing_output";
const outputProblems: Record<OutputProblem, string> = {
  unreadable_output: "unreadable output",
  truncated_output: "reasons cut off",
  missing_output: "no reasons given",
};
const isOutputProblem = (
  reason: ScriptCleanupReason | OutputProblem
): reason is OutputProblem => Object.hasOwn(outputProblems, reason);

/** 정리 스크립트가 지우지 못한 까닭. 스크립트의 정해진 값과 직렬화한 이름만 담는다(사람이 읽을 글은 옮기지 않는다). */
export type CleanupReason = {
  reason: ScriptCleanupReason | OutputProblem;
  name: string;
  keptAs?: string;
  code?: string;
};

const reasonNames = new Set<string>(cleanupReasons);
const isReasonName = (value: unknown): value is ScriptCleanupReason =>
  typeof value === "string" && reasonNames.has(value);

/** 정리하지 못한 까닭. 서버 기록에는 이 까닭들만 남는다. */
export class ConfigNotCleared extends Error {
  readonly reasons: CleanupReason[];
  constructor(reasons: CleanupReason[]) {
    super("configuration not cleared");
    this.reasons = reasons;
  }
}

/** 정리하지 못한 까닭을 한 문장으로 적는다. 정해진 까닭과 직렬화한 이름만 쓴다. */
export function describeCleanup(reasons: CleanupReason[]): string {
  return reasons
    .map((reason) => {
      if (isOutputProblem(reason.reason)) return outputProblems[reason.reason];
      let text = `${reason.reason} ${JSON.stringify(reason.name)}`;
      if (reason.keptAs !== undefined)
        text += ` as ${JSON.stringify(reason.keptAs)}`;
      if (reason.code !== undefined) text += ` (${reason.code})`;
      return text;
    })
    .join("; ");
}

/** 스크립트가 표준 오류에 남긴 JSON 한 줄. 정해진 모양일 때만 까닭으로 읽는다. */
function cleanupReason(line: string): CleanupReason | undefined {
  const value = orIfUnreadable((): unknown => JSON.parse(line), undefined);
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as {
    reason?: unknown;
    name?: unknown;
    keptAs?: unknown;
    code?: unknown;
  };
  if (!isReasonName(fields.reason)) return undefined;
  if (typeof fields.name !== "string") return undefined;
  if (fields.keptAs !== undefined && typeof fields.keptAs !== "string")
    return undefined;
  if (fields.code !== undefined && typeof fields.code !== "string")
    return undefined;
  return {
    reason: fields.reason,
    name: fields.name,
    ...(fields.keptAs !== undefined ? { keptAs: fields.keptAs } : {}),
    ...(fields.code !== undefined ? { code: fields.code } : {}),
  };
}

/**
 * 지우지 못했다고 끝난 정리 스크립트의 표준 오류를 까닭으로 읽는다. 한 줄에 JSON 하나이며, 정해진 모양이 아닌 줄이 있으면 내용 없이
 * `unreadable_output` 하나를 더한다(사람이 읽을 글은 옮기지 않는다). 출력이 수집 상한에 닿았으면(`truncated`) `truncated_output`을,
 * 읽은 것이 하나도 없으면 `missing_output`을 더한다.
 */
export function readCleanupReasons(
  stderr: string,
  truncated: boolean
): CleanupReason[] {
  const reasons: CleanupReason[] = [];
  let unreadable = false;
  for (const line of stderr.split("\n")) {
    if (!line.trim()) continue;
    const reason = cleanupReason(line);
    if (reason) reasons.push(reason);
    else unreadable = true;
  }
  if (unreadable) reasons.push({ reason: "unreadable_output", name: "" });
  if (truncated) reasons.push({ reason: "truncated_output", name: "" });
  if (reasons.length === 0)
    reasons.push({ reason: "missing_output", name: "" });
  return reasons;
}

/** 정리 스크립트 출력의 수집 상한. 넘는 부분은 버리고 스크립트는 끝까지 돈다(도중에 끄면 옮긴 파일을 되돌리지 못한다). */
const outputLimit = 64 * 1024;

/** 설정을 다루는 Node.js 프로세스를 공용 실행으로 끝까지 돌린다. 상한(30초)에 닿으면 그 트리를 끄고 확인한 뒤 실패로 던진다. */
async function run(cwd: string) {
  const result = await runTree({
    command: [process.execPath],
    args: [configScriptFile, JSON.stringify([ownerMark])],
    cwd,
    // 서버의 실행 옵션(NODE_OPTIONS 등)을 넘기지 않는다. Windows는 시스템 폴더 위치만 있으면 된다.
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    limitMs: 30_000,
    maxOutputBytes: outputLimit,
    overflow: "truncate",
  });
  if (!result.started)
    throw new Error(
      `the configuration script could not start: ${result.reason}`,
      {
        cause: result.error,
      }
    );
  if (result.stopped)
    throw new Error(
      `the configuration script was stopped at its ${result.stopped} limit${result.signal ? ` (signal ${result.signal})` : ""}`
    );
  if (result.code === null)
    throw new Error(
      `the configuration script ended by ${result.signal ?? "an unknown cause"}`
    );
  // 표준 오류는 한 줄에 JSON 하나다. 수집 상한까지 찼으면 그 뒤가 버려졌을 수 있으므로 잘린 것으로 본다(넘침을 따로 알리지 않는다).
  if (result.code === 3)
    throw new ConfigNotCleared(
      readCleanupReasons(
        result.stderr.toString("utf8"),
        result.stderr.length >= outputLimit
      )
    );
  if (result.code !== 0)
    throw new Error(`the configuration script failed (exit ${result.code})`);
}

/** 우리 표시가 있는 설정과 임시 파일을 지운다. 표시 없는 파일이나 링크가 있으면 까닭과 함께 오류다. */
export async function clearOwnedConfig(cwd: string) {
  await run(cwd);
}
