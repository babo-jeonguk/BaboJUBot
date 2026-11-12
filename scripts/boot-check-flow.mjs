// boot-check의 단계 진행과 멈춤. 정리하는 쪽은 이 흐름 하나다: 멈춤(자기 시한·SIGTERM 등)은 이유만 기록하고, 진행 중인
// 단계(서버 시작, DB 열기·닫기)가 끝난 뒤 다음 단계 경계에서 멈춰 한 곳의 정리로 끝난다. 실제 단계는 scripts/boot-check.mjs가 넘긴다.

/**
 * 멈춤 요청. 처음 이유만 남기고 한 번만 알린다. 멈춤 시한(`graceMs`)이 지나도 흐름이 끝나지 않으면 `onGraceExpired`를 부른다.
 */
export function createStop({ graceMs, onGraceExpired, log }) {
  let reason;
  return {
    get reason() {
      return reason;
    },
    request(why) {
      if (reason) return;
      reason = why;
      log(why);
      setTimeout(onGraceExpired, graceMs).unref();
    },
    /** 멈춤이 요청됐으면 이 단계 경계에서 멈춘다. */
    throwIfStopped(where) {
      if (reason) throw new Error(`${where}: ${reason}`);
    },
  };
}

/**
 * 단계를 차례로 돌리고, 성공·실패·멈춤 어느 경우든 마지막에 한 번 정리한다. 연 DB가 남았으면 정리 전에 닫는다.
 * 돌려주는 `code`는 실패·정리 실패·멈춤이 있으면 1이다.
 */
export async function runBootCheckFlow({
  stop,
  log,
  serve,
  expectLeftover,
  expectCleanStart,
  open,
  close,
  expectClosed,
  cleanUp,
}) {
  let failure;
  let cleanupError;
  let handle;
  try {
    await serve("first start");
    stop.throwIfStopped("first start");
    expectLeftover();
    await serve("start after a killed server");
    stop.throwIfStopped("start after a killed server");
    expectCleanStart("start after a killed server");
    // 서버 없이 열고 닫는다. 남은 DB를 다시 정상 정지하고 띄우며, 닫을 때도 정상 정지해야 한다.
    stop.throwIfStopped("open after another killed server");
    handle = await open();
    expectCleanStart("open after another killed server");
    stop.throwIfStopped("close");
    const opened = handle;
    handle = undefined;
    await close(opened);
    expectClosed();
    stop.throwIfStopped("after close");
  } catch (error) {
    failure = error;
    log(error instanceof Error ? error.message : String(error));
  }
  // 정리는 여기 한 곳에서만 한다. 연 DB는 닫고(정상 정지), 남은 Postgres가 실제로 멈춘 뒤에만 폴더를 지운다.
  try {
    if (handle) {
      const opened = handle;
      handle = undefined;
      await close(opened);
    }
    await cleanUp();
  } catch (error) {
    cleanupError = error;
    const cleanup = error instanceof Error ? error.message : String(error);
    const original = failure
      ? `\noriginal failure: ${failure instanceof Error ? failure.message : failure}`
      : "";
    log(`cleanup failed: ${cleanup}${original}`);
  }
  return {
    code: failure || cleanupError || stop.reason ? 1 : 0,
    failure,
    cleanupError,
  };
}
