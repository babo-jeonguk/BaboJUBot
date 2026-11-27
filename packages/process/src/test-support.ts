// node:net·node:http는 값으로 불러오지 않는다(runtime `connect-failure-support.ts` 머리의 대역 경로 제약).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasErrorCode } from "@babojubot/contracts";

// 시험의 대기 상한(`within`)은 node 기본 모듈을 불러오지 않는 파일 하나에 둔다(모듈 대역의 factory가 불러오는 지원 파일도 쓴다).
export { within } from "./within-support.ts";

/**
 * A clock that moves only when the test says (#215). Limits on it measure only the step under test (starting a program takes
 * no time on it however slow the machine is), and the order of timers and program events is set by state, not by real time.
 */
export function manualClock() {
  let now = 0,
    sequence = 0;
  const timers = new Map<
    number,
    { at: number; setAt: number; callback: () => void }
  >();
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      timers.set(++sequence, { at: now + ms, setAt: now, callback });
      return sequence;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    /** The delays of the timers still waiting, in the order they were set. */
    scheduled: () =>
      [...timers.values()].map((timer) => timer.at - timer.setAt),
    /** How long until the earliest waiting timer is due, or undefined when no timer is waiting. */
    untilNext: () =>
      timers.size
        ? Math.min(...[...timers.values()].map((timer) => timer.at)) - now
        : undefined,
    /**
     * Moves the time on and runs, in order, every timer that is due by then, including ones a callback sets on the way (a stop
     * timer that sets a kill timer runs both), each at its own time as on the real clock.
     */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort(([ha, a], [hb, b]) => a.at - b.at || ha - hb)[0];
        if (!next) break;
        const [handle, timer] = next;
        timers.delete(handle);
        now = timer.at;
        timer.callback();
      }
      now = until;
    },
  };
}

/** 확인 명령 하나의 결과. 성공(종료 코드 0)이면 `undefined`, 아니면 명령·종료 코드·신호·오류·stderr를 담은 실패 이유. */
export function commandFailure(
  command: string,
  args: string[],
  timeout = 20_000
): string | undefined {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  if (!result.error && result.status === 0) return undefined;
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return [
    [command, ...args].join(" "),
    `종료 코드 ${result.status ?? "없음"}`,
    ...(result.signal ? [`신호 ${result.signal}`] : []),
    ...(code ? [`오류 ${code}`] : []),
    `stderr: ${result.stderr?.trim() || "(없음)"}`,
  ].join(", ");
}

/**
 * 파일·폴더 권한으로 읽기·쓰기를 막을 수 있는가. root는 권한을 넘어 막은 파일도 읽고 쓰므로 그 시험은 root에서 건너뛴다.
 * CI는 `BABOJUBOT_REQUIRE_PERMISSION_DENIAL=1`로 필수로 정해, root로 돌면 건너뛰지 않고 실패한다. Windows는 이 확인과 따로
 * POSIX 권한 비트를 쓰는 시험만 그 시험 옆에 OS 이유로 건너뛴다.
 */
export function permissionDenial(): boolean {
  return (
    probeEnvironment({
      variable: "BABOJUBOT_REQUIRE_PERMISSION_DENIAL",
      what: "권한으로 막은 파일·폴더",
      probe: () =>
        process.getuid?.() === 0
          ? { missing: "root는 파일 권한을 넘어 읽고 쓴다" }
          : { value: true },
    }) ?? false
  );
}

/**
 * 파일 링크(symlink)를 만들 수 있는가. Windows는 링크 만들기 권한(관리자·개발자 모드)이 있어야 하고 없으면 EPERM이다. 링크 시험은
 * 이것으로 건너뛸지 정한다. CI는 `BABOJUBOT_REQUIRE_FILE_LINKS=1`로 필수로 정해(권한 있는 실행기), 만들 수 없으면 건너뛰지 않고
 * 실패한다. 권한이 없다는 답(EPERM)만 "쓸 수 없음"이고, 그 밖의 실패는 링크 지원과 무관한 원인이라 그대로 던진다.
 * 대상 없이 링크 하나만 임시 폴더에 만들고 바로 지운다. 폴더 링크(junction)는 Windows에서 권한 없이 만들므로 이 확인이 필요 없다.
 */
export function fileLinks(): boolean {
  return (
    probeEnvironment({
      variable: "BABOJUBOT_REQUIRE_FILE_LINKS",
      what: "파일 링크",
      probe: () => {
        const link = path.join(tmpdir(), `babojubot-link-${randomUUID()}`);
        try {
          symlinkSync(`${link}.target`, link, "file");
        } catch (error) {
          if (hasErrorCode("EPERM")(error))
            return {
              missing:
                "파일 링크를 만들 권한이 없다(EPERM). Windows는 관리자 권한이나 개발자 모드에서만 만든다",
            };
          throw error;
        }
        unlinkSync(link);
        return { value: true };
      },
    }) ?? false
  );
}

/**
 * 시험이 쓰는 바깥 환경(Docker, python pty, systemd 사용자 scope)을 확인한다. 쓸 수 있으면 `probe`의 값을, 건너뛸 때는
 * `undefined`를 돌려준다.
 * - `unsupported`: 이 OS가 그 환경을 지원하지 않는 이유. 있으면 확인 없이 그 이유로 건너뛴다.
 * - 지원하는 OS에서 확인이 실패하면, CI가 그 단계에 `variable=1`을 두어 필수로 정했을 때는 확인 결과(명령·종료 코드·stderr)와
 *   함께 던져 시험 파일이 실패한다. 변수가 없으면(로컬) 이유를 출력하고 건너뛴다. `1`·빈 값 밖의 값은 잘못 쓴 것이라 던진다.
 */
export function probeEnvironment<T>({
  variable,
  what,
  unsupported,
  probe,
}: {
  variable: string;
  what: string;
  unsupported?: string;
  probe: () => { value: T } | { missing: string };
}): T | undefined {
  const required = process.env[variable] ?? "";
  if (required !== "" && required !== "1")
    throw new Error(
      `${variable}는 1(필수)이거나 비어 있어야 한다: ${JSON.stringify(required)}`
    );
  if (unsupported) {
    console.log(`[${what}] ${unsupported}. 건너뜁니다.`);
    return undefined;
  }
  const found = probe();
  if ("value" in found) return found.value;
  if (required === "1")
    throw new Error(
      `${variable}=1이라 ${what} 시험은 필수인데 쓸 수 없다: ${found.missing}`
    );
  console.log(`[${what}] 쓸 수 없어 건너뜁니다: ${found.missing}`);
  return undefined;
}

/**
 * 다른 프로세스가 알린 프로세스 번호(pid 파일·출력 줄·서버 응답·구조화된 줄의 값). 숫자이거나 숫자 글자(앞뒤 공백·줄 끝 허용)인
 * 양의 정수만 받는다. 아니면 무엇(`what`)이 무엇을 알렸는지와 함께 던진다. 그대로 `Number`로 바꾸면 빈 글자는 0(프로세스 그룹
 * 전체에 가는 신호)이, 잘린 글자는 NaN(대상 없이 지나가는 확인)이 된다(#288 외부 리뷰 3회차 STD-4 같은 모양).
 */
export function reportedPid(value: unknown, what: string): number {
  const pid =
    typeof value === "string" && /^\s*\d+\s*$/.test(value)
      ? Number(value)
      : value;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0)
    return pid;
  throw new Error(`${what} is not a process number: ${JSON.stringify(value)}`);
}
