import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  lateProblems,
  newOwner,
  runAs,
  settleProblems,
  takeUnowned,
  watchPrograms,
  watchProcessPackage,
} from "./program-watch-support.ts";

// 계약 시험(runtime-contract.ts)의 반환 뒤 판정이 실패해야 할 때 실패하는지 본다. 판정, 활동 기록, 띄운 것의 수집과 그것을 띄운
// 실행 시도로의 귀속을 계약 시험 밖의 작은 단위로 떼어, 결함 사례를 넣으면 정확한 이유로 걸리는지 고정한다
// (#294 외부 리뷰 1회차 SPEC-2 parent 점검, 2회차 SPEC-2-R1·REC-SPEC-1).

/** 시험이 끝을 정하는 약속. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 실제로 시작한 트리 하나를 돌려주는 대역. 끄기·출력·시작 결과는 시험이 정한다. */
function fakeTree(
  start: Promise<{ kind: "running" } | { kind: "failed"; reason: string }>
) {
  const stopped = deferred();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    tree: { started: start, stop: () => stopped.promise, stdout, stderr },
    stopped,
    close() {
      stdout.destroy();
      stderr.destroy();
    },
  };
}

/** 공용 실행 대역. `launchTree`는 넘긴 트리를, `runTree`는 넘긴 결과를 돌려준다. */
function processPackage(
  launch: () => ReturnType<typeof fakeTree>["tree"],
  run: () => Promise<{ started: boolean }> = () =>
    Promise.resolve({ started: true })
) {
  return watchProcessPackage({ launchTree: launch, runTree: run });
}

describe("judging a run when it returns", () => {
  it("finds nothing when the programs the run started all ended before it returned", async () => {
    const owner = newOwner("adapter");
    const fake = fakeTree(Promise.resolve({ kind: "running" }));
    const watched = processPackage(() => fake.tree);
    const tree = runAs(owner, () => watched.launchTree());
    await tree.started;
    const stopping = tree.stop();
    fake.stopped.resolve();
    await stopping;
    fake.close();
    await Promise.all(owner.launches.map((launch) => launch.end));
    owner.markReturned();
    expect(settleProblems(owner, "programs")).toEqual([]);
    expect(lateProblems(owner)).toEqual([]);
  });

  it("names what had not ended when the run returned, even if it ends right after", async () => {
    const owner = newOwner("adapter");
    const fake = fakeTree(Promise.resolve({ kind: "running" }));
    const watched = processPackage(() => fake.tree);
    const tree = runAs(owner, () => watched.launchTree());
    await tree.started;
    owner.markReturned();
    const stopping = tree.stop();
    fake.stopped.resolve();
    await stopping;
    fake.close();
    await Promise.all(owner.launches.map((launch) => launch.end));
    expect(settleProblems(owner, "programs")).toEqual([
      "1 of the 1 launches the run made had not ended (or their end was not confirmed) when it returned",
    ]);
  });

  it("does not take a failed end signal as an end", async () => {
    const owner = newOwner("adapter");
    const done = deferred();
    const watched = watchPrograms({
      startProcess: () => ({ done: done.promise }),
    });
    runAs(owner, () => watched.startProcess());
    done.reject(new Error("cleanup failed"));
    await Promise.all(owner.launches.map((launch) => launch.end));
    owner.markReturned();
    expect(settleProblems(owner, "nothing")).toEqual([
      "1 of the 1 launches the run made had not ended (or their end was not confirmed) when it returned",
    ]);
  });

  it("does not take a tree that was never stopped, or whose output is still open, as ended", async () => {
    const owner = newOwner("adapter");
    const open = fakeTree(Promise.resolve({ kind: "running" }));
    const never = fakeTree(Promise.resolve({ kind: "running" }));
    const trees = [open.tree, never.tree];
    const watched = processPackage(() => trees.shift()!);
    const first = runAs(owner, () => watched.launchTree());
    runAs(owner, () => watched.launchTree());
    const stopping = first.stop();
    open.stopped.resolve();
    await stopping;
    owner.markReturned();
    expect(settleProblems(owner, "programs")).toEqual([
      "2 of the 2 launches the run made had not ended (or their end was not confirmed) when it returned",
    ]);
  });
});

describe("counting the programs a run actually started", () => {
  it("counts a run's program once, though startProcess launches its tree through the shared runner", async () => {
    const owner = newOwner("adapter");
    const fake = fakeTree(Promise.resolve({ kind: "running" }));
    const shared = processPackage(() => fake.tree);
    const done = deferred();
    const watched = watchPrograms({
      startProcess: () => ({ tree: shared.launchTree(), done: done.promise }),
    });
    const { tree } = runAs(owner, () => watched.startProcess());
    await tree.started;
    const stopping = tree.stop();
    fake.stopped.resolve();
    await stopping;
    fake.close();
    done.resolve();
    await Promise.all(owner.launches.map((launch) => launch.end));
    owner.markReturned();
    expect(owner.launches.map((launch) => launch.kind)).toEqual([
      "tree",
      "run",
    ]);
    expect(settleProblems(owner, "programs")).toEqual([]);
    expect(settleProblems(owner, "nothing")).toEqual([
      "declares that it starts nothing, but this run started 1 program",
    ]);
  });

  it("does not count a tree that failed to start or a command that did not start as a started program", async () => {
    const owner = newOwner("adapter");
    const fake = fakeTree(
      Promise.resolve({ kind: "failed", reason: "spawn ENOENT" })
    );
    const watched = processPackage(
      () => fake.tree,
      () => Promise.resolve({ started: false })
    );
    const tree = runAs(owner, () => watched.launchTree());
    const command = runAs(owner, () => watched.runTree());
    await tree.started;
    await command;
    const stopping = tree.stop();
    fake.stopped.resolve();
    await stopping;
    fake.close();
    await Promise.all(owner.launches.map((launch) => launch.end));
    owner.markReturned();
    expect(owner.launches.map((launch) => launch.started)).toEqual([
      "no",
      "no",
    ]);
    expect(settleProblems(owner, "programs")).toEqual([
      "declares that its runs start programs, but this run started none",
    ]);
    expect(settleProblems(owner, "nothing")).toEqual([]);
  });

  it("counts a short command that started", async () => {
    const owner = newOwner("adapter");
    const watched = processPackage(
      () => fakeTree(Promise.resolve({ kind: "running" })).tree,
      () => Promise.resolve({ started: true })
    );
    await runAs(owner, () => watched.runTree());
    await Promise.all(owner.launches.map((launch) => launch.end));
    owner.markReturned();
    expect(settleProblems(owner, "programs")).toEqual([]);
  });
});

describe("tying each launch to the run that made it", () => {
  // 실행 시도가 일으킨 타이머·promise 이어짐·입출력 콜백은 그 실행 시도의 문맥에서 돈다(Node AsyncLocalStorage). 실제 adapter의
  // 프로그램 출력 처리 같은 입출력 콜백은 계약 시험(runtime-contract.ts)이 귀속 없는 실행이 없는지로 본다.
  it("keeps the run through timers, immediates and promise continuations it set up", async () => {
    takeUnowned();
    const owner = newOwner("adapter");
    const watched = processPackage(
      () => fakeTree(Promise.resolve({ kind: "running" })).tree
    );
    // 띄운 실행의 결과는 그 약속이 넘겨받아 시험이 기다린다.
    const fromTimer = deferred<unknown>();
    const fromImmediate = deferred<unknown>();
    const continued = runAs(owner, () => {
      setTimeout(() => fromTimer.resolve(watched.runTree()), 0);
      setImmediate(() => fromImmediate.resolve(watched.runTree()));
      return Promise.resolve().then(() => watched.runTree());
    });
    await Promise.all([fromTimer.promise, fromImmediate.promise, continued]);
    expect(owner.launches.map((launch) => launch.kind)).toEqual([
      "command",
      "command",
      "command",
    ]);
    expect(takeUnowned()).toEqual([]);
  });

  it("names a launch that came after the run returned, whenever it comes", async () => {
    const owner = newOwner("adapter");
    const watched = processPackage(
      () => fakeTree(Promise.resolve({ kind: "running" })).tree
    );
    const later = deferred();
    const launching = runAs(owner, () =>
      later.promise.then(() => watched.runTree())
    );
    owner.markReturned();
    later.resolve();
    await launching;
    expect(owner.launches).toEqual([]);
    expect(lateProblems(owner)).toEqual([
      "adapter launched 1 program after the run returned",
    ]);
  });

  it("gives a late launch to the run that made it, not to the next run working at that moment", async () => {
    const first = newOwner("adapter");
    const second = newOwner("adapter");
    const watched = processPackage(
      () => fakeTree(Promise.resolve({ kind: "running" })).tree
    );
    const later = deferred();
    const launching = runAs(first, () =>
      later.promise.then(() => watched.runTree())
    );
    first.markReturned();
    // 다음 실행 시도가 일하는 동안 앞 실행 시도의 미룬 일이 프로그램을 띄운다.
    await runAs(second, async () => {
      later.resolve();
      await launching;
    });
    expect(second.launches).toEqual([]);
    expect(lateProblems(first)).toEqual([
      "adapter launched 1 program after the run returned",
    ]);
  });

  it("keeps a launch made outside any run apart instead of dropping it", () => {
    const watched = processPackage(
      () => fakeTree(Promise.resolve({ kind: "running" })).tree
    );
    takeUnowned();
    const run = watched.runTree();
    expect(takeUnowned().map((launch) => launch.kind)).toEqual(["command"]);
    expect(takeUnowned()).toEqual([]);
    return run;
  });
});

describe("the activity log of a run", () => {
  it("keeps activities before the return and refuses and keeps one after it, even when the adapter swallows the refusal", async () => {
    const owner = newOwner("adapter");
    owner.record({ type: "progress", text: "before" });
    owner.markReturned();
    const swallowed = await Promise.resolve()
      .then(() => owner.record({ type: "progress", text: "after" }))
      .then(
        () => "accepted",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error)
      );
    expect(swallowed).toBe(
      'adapter emitted an activity after the run returned: {"type":"progress","text":"after"}'
    );
    expect(owner.activities).toEqual([{ type: "progress", text: "before" }]);
    expect(lateProblems(owner)).toEqual([
      'adapter emitted an activity after the run returned: {"type":"progress","text":"after"}',
    ]);
  });
});
