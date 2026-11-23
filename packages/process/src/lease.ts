import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfProbeFailed,
} from "@babojubot/contracts";
import { statFields } from "./proc-stat.ts";

/**
 * 실행 시도의 표식. 실행 시도마다 고유한 값을 프로그램 환경에 넣으면 그 자손이 모두 물려받는다.
 * Claude Code·Codex·Antigravity는 셸 명령을 새 세션에 띄우므로, 프로그램이 갑자기 죽으면 프로세스 그룹으로는 그 명령에 닿지 못하고 이 표식으로만 찾는다(#219).
 * 표식으로 찾아 끄는 일은 감독 실행기가 한다(`supervisor/src/marked.rs`, #268 PR 2): 끄기와 서버가 죽은 경우에는 그 트리의 실행기가,
 * 서버와 실행기가 함께 죽은 뒤의 재시작 복구에서는 정리만 청한 실행기(`cleanThroughSupervisor`)가. 서버는 표식을 만들어 넘길 뿐 찾지 않는다.
 * 알려진 한계: 표식 변수를 일부러 지운 프로그램은 찾지 못한다.
 */
export const leaseVariable = "BABOJUBOT_PROCESS_LEASE";
export const leaseEntry = (lease: string) => `${leaseVariable}=${lease}`;
/**
 * 표식 변수 이름. 실행 시도 안에서 다시 띄운 트리(작업자가 돌리는 시험, 기록 중계 등)는 바깥 트리의 표식을 지운 채 새 표식만
 * 가지면 바깥 트리의 끄기가 그 트리에 닿지 못한다. 그래서 띄우는 쪽이 가진 표식을 모두 물려주고 새 표식은 다음 번호의 이름에 둔다.
 * 첫째 이름은 예전 기록·시험과 같은 `BABOJUBOT_PROCESS_LEASE`다.
 */
const leaseName = (index: number) =>
  index === 0 ? leaseVariable : `${leaseVariable}_${index}`;
const leaseNamePattern = new RegExp(`^${leaseVariable}(?:_\\d+)?$`);
/** 환경 항목 하나(`이름=값`)가 이 표식인가. 표식 변수 이름 가운데 하나에 값이 정확히 같아야 한다. */
export function isLeaseEntry(entry: string, lease: string) {
  const equals = entry.indexOf("=");
  return (
    equals > 0 &&
    leaseNamePattern.test(entry.slice(0, equals)) &&
    entry.slice(equals + 1) === lease
  );
}
/** 환경에 든 표식 값. */
const leasesIn = (env: NodeJS.ProcessEnv) =>
  Object.entries(env).flatMap(([name, value]) =>
    leaseNamePattern.test(name) && value ? [value] : []
  );
/**
 * 새로 띄울 트리의 환경. `env`의 표식 변수는 빼고, `env`와 이 프로세스(`own`, 기본은 지금 환경)가 가진 표식을 앞 번호에,
 * 새 표식 `lease`를 마지막 번호에 둔다. 그래서 이 트리의 자손은 바깥 트리들의 표식도 함께 가진다.
 */
export function withLease(
  env: NodeJS.ProcessEnv,
  lease: string,
  own: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const outer = [...new Set([...leasesIn(own), ...leasesIn(env)])].filter(
    (value) => value !== lease
  );
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !leaseNamePattern.test(name))
    ),
    ...Object.fromEntries(
      [...outer, lease].map((value, index) => [leaseName(index), value])
    ),
  };
}

/** 이 제품이 만드는 표식의 모양(`randomUUID`). */
const markerForm =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 물려받은 표식이 이 제품이 만든 모양이 아니다(개행 등). 그 값은 넘기지 않는다. */
export class ForeignMarker extends Error {
  override name = "ForeignMarker";
}

/**
 * 새로 띄울 트리의 환경을 표식과 나머지로 나눈다(표식은 `withLease`와 같다). 감독 실행기는 나머지만 받아 표식을 지니지 않고, 표식은
 * 제어 통로로 받아 프로그램에만 준다. 그래서 표식 정리가 트리의 관리자인 실행기에 닿지 않는다(#268).
 */
export function leaseEnvironment(
  env: NodeJS.ProcessEnv,
  lease: string,
  own: NodeJS.ProcessEnv = process.env
) {
  const full = withLease(env, lease, own);
  const leases = Object.entries(full).flatMap(([name, value]) =>
    leaseNamePattern.test(name) && value !== undefined
      ? [[name, value] as const]
      : []
  );
  // 표식은 제어 통로의 메시지로 넘긴다. 바깥에서 물려받은 값도 이 제품이 만든 모양이어야 한다(#274 외부 리뷰 2회차 SPEC-3).
  for (const [name] of leases.filter(([, value]) => !markerForm.test(value)))
    throw new ForeignMarker(
      `the inherited run marker ${name} is not in the form this product writes`
    );
  const rest = Object.fromEntries(
    Object.entries(full).filter(([name]) => !leaseNamePattern.test(name))
  );
  return { env: rest, leases };
}

/** 끝났거나(ENOENT·ESRCH) 다른 사용자의 것이라 읽을 수 없는(EACCES·EPERM) 프로세스의 /proc 읽기 오류. */
const unreadable = hasErrorCode("ENOENT", "ESRCH", "EACCES", "EPERM");

/** Linux: 프로세스 시작 시각(부팅 뒤 clock tick, /proc/<pid>/stat 22번째 칸). 그 밖의 시스템이거나 끝난 프로세스면 undefined. 읽지 못하면 원인을 남기고 undefined. */
export function processStartTicks(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  // 끝난 프로세스는 시작 시각이 없다(답이다). 그 밖의 읽기 실패는 원인을 남기고 모르는 것으로 본다.
  const stat = orIfProbeFailed(
    () =>
      orIfMissing(
        () => readFileSync(`/proc/${pid}/stat`, "utf8"),
        hasErrorCode("ENOENT", "ESRCH"),
        undefined
      ),
    undefined,
    (error) =>
      console.warn(
        `[provider] could not read the start time of process ${pid} (${failureCode(error)})`
      )
  );
  if (stat === undefined) return undefined;
  const start = Number(statFields(stat)[19]);
  return Number.isFinite(start) ? start : undefined;
}

/** Linux: 환경 변수 항목 하나가 표식과 정확히 같은가. 끝났거나 읽을 수 없는 프로세스(다른 사용자 등)는 아니다. */
export async function holdsLease(pid: number, lease: string) {
  let environment: string;
  try {
    // 환경 변수에는 UTF-8이 아닌 바이트도 올 수 있다. 바이트를 그대로 옮기는 latin1로 읽는다(표식은 ASCII다).
    environment = await readFile(`/proc/${pid}/environ`, "latin1");
  } catch (e) {
    if (unreadable(e)) return false;
    throw e;
  }
  return environment.split("\0").some((entry) => isLeaseEntry(entry, lease));
}
