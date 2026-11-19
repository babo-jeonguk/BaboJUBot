import { describe, expect, it } from "vitest";
import { RerunLoop } from "./rerun-loop.ts";

/** 풀거나 거절할 수 있는 Promise. 시험이 회차의 시작과 끝을 정한다. */
function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 시험이 열 때까지 멈춰 있는 확인. n번째 회차가 시작하면 `entered(n)`이 풀리고, `finish(n)`·`fail(n, error)`로 끝난다.
 * 회차의 시작·끝과 시험이 덧붙인 기록은 `log`에 차례대로 남는다.
 */
function heldChecks() {
  const log: string[] = [];
  const gates = new Map<
    number,
    { entered: ReturnType<typeof gate>; done: ReturnType<typeof gate> }
  >();
  const of = (n: number) => {
    let found = gates.get(n);
    if (!found) gates.set(n, (found = { entered: gate(), done: gate() }));
    return found;
  };
  let passes = 0;
  const check = async () => {
    const n = ++passes;
    log.push(`start ${n}`);
    of(n).entered.resolve();
    try {
      await of(n).done.promise;
    } finally {
      log.push(`end ${n}`);
    }
  };
  return {
    log,
    check,
    passes: () => passes,
    entered: (n: number) => of(n).entered.promise,
    finish: (n: number) => of(n).done.resolve(),
    fail: (n: number, error: unknown) => of(n).done.reject(error),
  };
}

/** 확인 실패를 모은다. 공용 함수는 실패를 넘겨받은 함수에 맡기고 다음 요청을 계속 처리한다. */
function failures() {
  const errors: unknown[] = [];
  return { errors, onError: (error: unknown) => errors.push(error) };
}

/** 틀린 구현이라면 기다리던 쪽이 이 사이에 먼저 풀린다. 이벤트 루프 차례 하나는 그때까지의 microtask를 모두 처리한다. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("RerunLoop", () => {
  it("runs one pass at a time and folds the requests made during a pass into one rerun", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    loop.request();
    await checks.entered(1);
    expect(loop.busy).toBe(true);
    loop.request();
    loop.request();
    loop.request();
    // 도는 중의 요청은 지금 회차를 겹쳐 시작하지 않는다.
    expect(checks.passes()).toBe(1);
    checks.finish(1);
    await checks.entered(2);
    checks.finish(2);
    await loop.settled();

    expect(checks.log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(loop.busy).toBe(false);
  });

  it("does not rerun when nothing was requested during the pass", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    loop.request();
    await checks.entered(1);
    checks.finish(1);
    await loop.settled();

    expect(checks.log).toEqual(["start 1", "end 1"]);
  });

  it("waits through the rerun until no pass is left", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    loop.request();
    await checks.entered(1);
    loop.request();
    const settled = loop.settled().then(() => checks.log.push("settled"));
    checks.finish(1);
    await checks.entered(2);
    await nextTurn();
    checks.finish(2);
    await settled;

    expect(checks.log).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "settled",
    ]);
  });

  it("resolves at once when no pass is running", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    await loop.settled();

    expect(checks.passes()).toBe(0);
  });

  it("runs now when idle and waits for that pass", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    const ran = loop.runNow().then(() => checks.log.push("ran"));
    await checks.entered(1);
    await nextTurn();
    checks.finish(1);
    await ran;

    expect(checks.log).toEqual(["start 1", "end 1", "ran"]);
  });

  it("when a pass is running, runs now as the rerun and waits for the rerun, not the pass that was running", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    loop.request();
    await checks.entered(1);
    // 이미 도는 회차는 이 호출 전에 읽은 상태로 돌 수 있으므로, 호출 뒤에 시작한 회차를 기다린다.
    const ran = loop.runNow().then(() => checks.log.push("ran"));
    checks.finish(1);
    await checks.entered(2);
    await nextTurn();
    checks.finish(2);
    await ran;

    expect(checks.log).toEqual(["start 1", "end 1", "start 2", "end 2", "ran"]);
  });

  it("folds runNow and requests made during the same pass into one rerun", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    loop.request();
    await checks.entered(1);
    const ran = loop.runNow();
    loop.request();
    const ranToo = loop.runNow();
    checks.finish(1);
    await checks.entered(2);
    checks.finish(2);
    await Promise.all([ran, ranToo]);
    await loop.settled();

    expect(checks.log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("hands a failed pass to onError and keeps serving the next request", async () => {
    const checks = heldChecks();
    const { errors, onError } = failures();
    const loop = new RerunLoop(checks.check, onError);
    const failure = new Error("check failed");

    loop.request();
    await checks.entered(1);
    loop.request();
    checks.fail(1, failure);
    await checks.entered(2);
    checks.finish(2);
    await loop.settled();

    expect(errors).toEqual([failure]);
    expect(checks.log).toEqual(["start 1", "end 1", "start 2", "end 2"]);

    // 실패한 뒤에도 새 요청을 받고, 기다리는 쪽에 실패를 던지지 않는다.
    const ran = loop.runNow();
    await checks.entered(3);
    checks.fail(3, failure);
    await expect(ran).resolves.toBeUndefined();
    expect(errors).toEqual([failure, failure]);
  });

  it("treats a check that throws before its first await as a failed pass", async () => {
    const { errors, onError } = failures();
    const failure = new Error("thrown at once");
    let passes = 0;
    const loop = new RerunLoop(() => {
      passes++;
      if (passes === 1) throw failure;
      return Promise.resolve();
    }, onError);

    expect(() => loop.request()).not.toThrow();
    await loop.settled();
    await loop.runNow();

    expect(errors).toEqual([failure]);
    expect(passes).toBe(2);
  });

  it("on close, waits for the running pass, drops the pending rerun and ignores later requests", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError);

    loop.request();
    await checks.entered(1);
    loop.request();
    const closed = loop.close().then(() => checks.log.push("closed"));
    await nextTurn();
    checks.finish(1);
    await closed;

    loop.request();
    await loop.runNow();
    await loop.settled();

    expect(checks.log).toEqual(["start 1", "end 1", "closed"]);
    expect(loop.busy).toBe(false);
  });
});
