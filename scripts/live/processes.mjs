// 실제 장애 검사·프로바이더 확인이 띄운 시험용 명령을 명령줄로 찾는다(provider-live의 취소 장면, chaos 장면 정리).
// `pgrep`은 POSIX 도구다. 실행 결과를 pid 목록이나 오류로 바꾸는 판정(`pidsFromPgrep`)은 따로 두어 어느 OS에서나 시험한다.
import { spawnSync } from "node:child_process";

/**
 * 명령줄이 `pattern`(확장 정규식)에 맞는 프로세스의 pid. 맞는 것이 없으면 빈 목록이다.
 * `pgrep`을 띄우지 못하거나 시한(10초) 안에 끝나지 않거나 다른 이유로 실패하면 "없음"으로 바꾸지 않고 원인과 함께 던진다.
 */
export function matchingPids(pattern) {
  return pidsFromPgrep(
    spawnSync("pgrep", ["-f", pattern], {
      encoding: "utf8",
      timeout: 10_000,
    }),
    pattern
  );
}

/**
 * `pgrep -f pattern`의 실행 결과(`spawnSync`의 `{ error, status, signal, stdout, stderr }`)를 pid 목록으로 바꾼다.
 * 종료 코드 0은 찾은 pid, 1은 맞는 것이 없음(빈 목록)이다. 띄우지 못함·시한 초과(`error`), 신호로 끝남, 그 밖의 종료 코드
 * (잘못된 정규식 2, 내부 오류 3 등)는 원인과 함께 던진다.
 */
export function pidsFromPgrep(result, pattern) {
  if (result.error)
    throw new Error(`pgrep did not finish for ${pattern}`, {
      cause: result.error,
    });
  if (result.status === 1) return [];
  if (result.status !== 0)
    throw new Error(
      `pgrep failed for ${pattern} (exit ${result.status ?? result.signal}): ${result.stderr.trim()}`
    );
  return result.stdout.split("\n").filter(Boolean).map(Number);
}
