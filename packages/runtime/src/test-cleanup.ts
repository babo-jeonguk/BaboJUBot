// 시험의 정리. 정리 실패가 시험의 원래 실패를 가리지 않고, 한 정리가 실패해도 나머지 정리를 한다(CODING_STANDARDS.md#정리).
// Vitest 시험은 자원을 잡은 직후 `onTestFinished`에 정리를 등록한다. 러너가 등록 역순으로 모두 하고 실패를 따로 알린다.
// 이 파일은 러너의 정리가 맞지 않는 곳에 쓴다: 시험 중간에 끝내야 하는 정리, node:test(본문이 실패하면 `t.after`의 실패를
// 버린다), Playwright 본문과 fixture, 여러 단계를 정리하는 시험 지원 함수.
// 실패는 `AggregateError`로 묶는다. Vitest·Playwright는 목록을 펼쳐 하나씩 보이고, 목록을 펼치지 않는 출력(node:test의 TAP)을
// 위해 메시지에도 모든 실패를 이어 적는다.

/** 정리 단계. 동기로 던지든 거절하든 실패로 모은다. */
export type CleanupStep = () => unknown;

const describe = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);
const joined = (failures: unknown[]) =>
  failures.map(describe).join(" — 그리고 ");

/** 단계를 차례로 모두 시도하고 실패를 돌려준다. */
async function attempt(steps: Iterable<CleanupStep>) {
  const failures: unknown[] = [];
  for (const step of steps)
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  return failures;
}

/** 정리 실패가 하나면 그 오류를 그대로, 여럿이면 함께 묶은 오류. */
function cleanupFailure(failures: unknown[]) {
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, `정리가 실패했다: ${joined(failures)}`);
}

/**
 * 서로 기다리지 않는 정리 단계를 차례로 모두 시도한다. 앞 단계가 실패해도 다음 단계를 하고, 실패를 모두 모아 알린다.
 * 앞 단계가 끝나야 하는 단계(프로그램을 끈 뒤 그 폴더 지우기)는 이것이 끝난 뒤에 이어 부른다. 이것이 던지면 이어지지 않는다.
 */
export async function cleanUpAll(steps: Iterable<CleanupStep>): Promise<void> {
  const failures = await attempt(steps);
  if (failures.length > 0) throw cleanupFailure(failures);
}

/**
 * 폴더와 그 안에서 도는 프로그램의 정리. 폴더를 만든 직후 `cleanUp`을 러너나 `withCleanup`에 등록하고, 프로그램을 띄우면 그
 * 멈춤을 `own`으로 맡긴다. `cleanUp`은 맡긴 멈춤을 역순으로 모두 시도하고, 모두 끝났을 때만 폴더를 지운다. 끝나지 않은 것이
 * 있으면 폴더를 남기고 그 실패를 알린다(살아 있는 프로그램의 폴더는 지우지 못하거나, 지워도 그 프로그램이 남는다).
 * 멈춤과 지우기는 한 번만 한다. 다시 부르거나 동시에 불러도 그 한 실행의 결과를 받으므로, 멈추지 못한 폴더는 다시 불러도 남는다.
 * 실패한 멈춤을 다시 시도하지 않는다. 정리는 러너가 한 번 부르고, 같은 프로그램을 다시 멈추는 일은 그 멈춤 함수가 맡는다.
 */
export function folderCleanup(remove: CleanupStep) {
  const stops: CleanupStep[] = [];
  let cleaning: Promise<void> | undefined;
  return {
    /** 폴더를 지우기 전에 끝나야 하는 것. `stop`은 그것을 멈추고 끝날 때까지 기다린다. 정리가 시작된 뒤에는 맡지 않고 던진다. */
    own(stop: CleanupStep) {
      if (cleaning)
        throw new Error("폴더 정리가 시작된 뒤에는 멈출 것을 맡길 수 없다");
      stops.push(stop);
    },
    cleanUp: () =>
      (cleaning ??= (async () => {
        await cleanUpAll([...stops].reverse());
        await remove();
      })()),
  };
}

/**
 * `body`를 하고, `body`가 `defer`로 등록한 정리를 등록 역순으로 모두 한다. 자원을 잡은 직후 그 정리를 등록한다.
 * 본문만 실패하면 그 실패를 그대로, 정리만 실패하면 정리 실패를 알린다. 둘 다 실패하면 원래 실패를 첫 자리에, 정리 실패를
 * 그 뒤에 둔 `AggregateError`로 함께 알린다.
 */
export async function withCleanup<T>(
  body: (defer: (step: CleanupStep) => void) => Promise<T> | T
): Promise<T> {
  const steps: CleanupStep[] = [];
  let outcome: { failed: false; value: T } | { failed: true; error: unknown };
  try {
    outcome = { failed: false, value: await body((step) => steps.push(step)) };
  } catch (error) {
    outcome = { failed: true, error };
  }
  const failures = await attempt(steps.reverse());
  if (!outcome.failed) {
    if (failures.length > 0) throw cleanupFailure(failures);
    return outcome.value;
  }
  if (failures.length === 0) throw outcome.error;
  const all = [outcome.error, ...failures];
  throw new AggregateError(
    all,
    `시험이 실패했고 정리도 실패했다: ${joined(all)}`,
    { cause: outcome.error }
  );
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * 프로세스가 아직 있는가(신호 0). "프로세스 없음"(ESRCH)만 없는 것으로 보고, 그 밖의 실패는 pid와 원인을 담아 던진다.
 * 권한 거부(EPERM)는 그 번호의 프로세스가 있다는 뜻이지만 시험이 띄운 프로세스인지 알 수 없다(다른 사용자가 번호를 다시 씀).
 * 끝났다고 보면 아직 쓰는 폴더를 지우고, 있다고 보면 대기 상한까지 원인 없이 기다리므로 원인과 함께 바로 실패한다.
 * Windows도 같은 코드를 낸다: 없는 번호와 이미 끝난 프로세스는 ESRCH, 열 권한이 없으면 EPERM이다(libuv `uv_kill`).
 * 거두어지기 전의 좀비는 있는 것으로 답한다(POSIX `kill`). 좀비를 끝난 것으로 볼 곳은 상태를 따로 읽는다(`exited`).
 */
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw new Error(`프로세스 ${pid}가 있는지 확인하지 못했다`, {
      cause: error,
    });
  }
}

/**
 * 시험 정리: 신호(기본 SIGKILL)를 보내고 보냈으면 true. 이미 끝난 대상(ESRCH)은 넘어가 false, 그 밖의 실패는 pid·신호·원인을
 * 담아 던진다. 프로세스 그룹은 음수 번호로 준다. Windows는 SIGKILL·SIGTERM·SIGINT를 강제 종료로 보내고, 이미 끝난 대상은
 * ESRCH로 답한다(libuv `uv_kill`).
 */
export function killUnlessGone(
  pid: number,
  signal: NodeJS.Signals = "SIGKILL"
) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw new Error(`프로세스 ${pid}에 ${signal}을 보내지 못했다`, {
      cause: error,
    });
  }
}
