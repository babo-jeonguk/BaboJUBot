import { describe, expect, it } from "vitest";
import { RerunLoop, RerunLoops } from "./rerun-loop.ts";

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
  });

  it("folds a request the check makes before its first await into a rerun instead of a second pass alongside", async () => {
    const checks = heldChecks();
    let requestedAgain = false;
    const loop: RerunLoop = new RerunLoop(async () => {
      if (!requestedAgain) {
        requestedAgain = true;
        loop.request();
      }
      await checks.check();
    }, failures().onError);

    loop.request();
    await checks.entered(1);
    expect(checks.passes()).toBe(1);
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

  it("tells onIdle once the last pass ends, not between a pass and its rerun", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError, () =>
      checks.log.push("idle")
    );

    loop.request();
    await checks.entered(1);
    loop.request();
    checks.finish(1);
    await checks.entered(2);
    checks.finish(2);
    await loop.settled();
    loop.request();
    await checks.entered(3);
    checks.finish(3);
    await loop.settled();

    expect(checks.log).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "idle",
      "start 3",
      "end 3",
      "idle",
    ]);
  });

  it("tells onIdle after a failed pass and when close drops the pending rerun", async () => {
    const checks = heldChecks();
    const loop = new RerunLoop(checks.check, failures().onError, () =>
      checks.log.push("idle")
    );

    loop.request();
    await checks.entered(1);
    checks.fail(1, new Error("check failed"));
    await loop.settled();
    loop.request();
    await checks.entered(2);
    loop.request();
    const closed = loop.close();
    checks.finish(2);
    await closed;

    expect(checks.log).toEqual([
      "start 1",
      "end 1",
      "idle",
      "start 2",
      "end 2",
      "idle",
    ]);
  });
});

/** 키마다 따로 멈춰 있는 확인. 키의 n번째 회차는 `of(key).entered(n)`·`of(key).finish(n)`로 다룬다. */
function heldChecksByKey() {
  const byKey = new Map<string, ReturnType<typeof heldChecks>>();
  const of = (key: string) => {
    let found = byKey.get(key);
    if (!found) byKey.set(key, (found = heldChecks()));
    return found;
  };
  return { of, check: (key: string) => of(key).check() };
}

describe("RerunLoops", () => {
  it("runs each key on its own, one pass at a time per key", async () => {
    const checks = heldChecksByKey();
    const loops = new RerunLoops(checks.check, failures().onError);

    loops.request("a");
    await checks.of("a").entered(1);
    // a가 도는 동안에도 b는 따로 돈다.
    loops.request("b");
    await checks.of("b").entered(1);
    loops.request("a");
    checks.of("a").finish(1);
    await checks.of("a").entered(2);
    checks.of("a").finish(2);
    checks.of("b").finish(1);
    await loops.settledAll();

    expect(checks.of("a").log).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
    ]);
    expect(checks.of("b").log).toEqual(["start 1", "end 1"]);
  });

  it("forgets a key once its passes end, and runs it again on the next request", async () => {
    const checks = heldChecksByKey();
    const loops = new RerunLoops(checks.check, failures().onError);

    loops.request("a");
    await checks.of("a").entered(1);
    expect(loops.busy("a")).toBe(true);
    loops.request("a");
    checks.of("a").finish(1);
    await checks.of("a").entered(2);
    // 재실행 사이에는 쉬지 않으므로 잊지 않는다.
    expect(loops.busy("a")).toBe(true);
    checks.of("a").finish(2);
    await loops.settled("a");
    expect(loops.busy("a")).toBe(false);

    loops.request("a");
    expect(loops.busy("a")).toBe(true);
    await checks.of("a").entered(3);
    const settled = loops
      .settled("a")
      .then(() => checks.of("a").log.push("settled"));
    await nextTurn();
    checks.of("a").finish(3);
    await settled;

    expect(loops.busy("a")).toBe(false);
    expect(checks.of("a").log).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "start 3",
      "end 3",
      "settled",
    ]);
  });

  it("folds a request for the same key that the check makes before its first await into a rerun", async () => {
    const checks = heldChecksByKey();
    let requestedAgain = false;
    const loops: RerunLoops = new RerunLoops(async (key) => {
      if (!requestedAgain) {
        requestedAgain = true;
        loops.request(key);
      }
      await checks.check(key);
    }, failures().onError);

    loops.request("a");
    await checks.of("a").entered(1);
    expect(checks.of("a").passes()).toBe(1);
    const settled = loops
      .settled("a")
      .then(() => checks.of("a").log.push("settled"));
    checks.of("a").finish(1);
    await checks.of("a").entered(2);
    expect(loops.busy("a")).toBe(true);
    await nextTurn();
    checks.of("a").finish(2);
    await settled;

    expect(loops.busy("a")).toBe(false);
    expect(checks.of("a").log).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "settled",
    ]);
  });

  it("keeps waiting for a key that starts again right after it was forgotten", async () => {
    const checks = heldChecksByKey();
    const forgotten: string[] = [];
    const loops: RerunLoops = new RerunLoops(
      checks.check,
      failures().onError,
      (key) => {
        forgotten.push(key);
        // 잊은 바로 그 순간에 같은 키가 다시 온다(다른 경로의 깨우기처럼). 새 루프가 생긴다.
        if (forgotten.length === 1) loops.request(key);
      }
    );

    loops.request("a");
    await checks.of("a").entered(1);
    const settled = loops
      .settled("a")
      .then(() => checks.of("a").log.push("settled"));
    checks.of("a").finish(1);
    await checks.of("a").entered(2);
    expect(forgotten).toEqual(["a"]);
    expect(loops.busy("a")).toBe(true);
    await nextTurn();
    checks.of("a").finish(2);
    await settled;

    expect(forgotten).toEqual(["a", "a"]);
    expect(loops.busy("a")).toBe(false);
    expect(checks.of("a").log).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "settled",
    ]);
  });

  it("resolves at once for a key that is not running", async () => {
    const checks = heldChecksByKey();
    const loops = new RerunLoops(checks.check, failures().onError);

    await loops.settled("a");
    await loops.settledAll();

    expect(checks.of("a").passes()).toBe(0);
  });

  it("waits for every key, including one requested by another key's pass", async () => {
    const order: string[] = [];
    const aDone = gate();
    const bEntered = gate();
    const bDone = gate();
    const loops: RerunLoops = new RerunLoops(async (key) => {
      order.push(`start ${key}`);
      if (key === "a") {
        await aDone.promise;
        // 기다리기를 시작한 뒤에 다른 키가 생긴다(dispatcher의 자리 촉진처럼).
        loops.request("b");
      } else {
        bEntered.resolve();
        await bDone.promise;
      }
      order.push(`end ${key}`);
    }, failures().onError);

    loops.request("a");
    const settled = loops.settledAll().then(() => order.push("settled"));
    aDone.resolve();
    await bEntered.promise;
    await nextTurn();
    bDone.resolve();
    await settled;

    expect(order).toEqual(["start a", "start b", "end a", "end b", "settled"]);
    expect(loops.busy("a")).toBe(false);
    expect(loops.busy("b")).toBe(false);
  });

  it("hands a failed pass to onError with its key and forgets the key", async () => {
    const checks = heldChecksByKey();
    const errors: [string, unknown][] = [];
    const loops = new RerunLoops(checks.check, (key, error) =>
      errors.push([key, error])
    );
    const failure = new Error("check failed");

    loops.request("a");
    await checks.of("a").entered(1);
    checks.of("a").fail(1, failure);
    await loops.settled("a");

    expect(errors).toEqual([["a", failure]]);
    expect(loops.busy("a")).toBe(false);
  });

  it("on close, waits for every running key, drops pending reruns and ignores later requests", async () => {
    const checks = heldChecksByKey();
    const loops = new RerunLoops(checks.check, failures().onError);

    loops.request("a");
    loops.request("b");
    await checks.of("a").entered(1);
    await checks.of("b").entered(1);
    loops.request("a");
    const closed = loops.close().then(() => checks.of("a").log.push("closed"));
    await nextTurn();
    checks.of("a").finish(1);
    checks.of("b").finish(1);
    await closed;
    loops.request("a");
    loops.request("c");

    expect(checks.of("a").log).toEqual(["start 1", "end 1", "closed"]);
    expect(checks.of("b").log).toEqual(["start 1", "end 1"]);
    expect(checks.of("c").passes()).toBe(0);
    expect(loops.busy("a")).toBe(false);
    expect(loops.busy("c")).toBe(false);
  });
});
