import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  activityLog,
  programCount,
  programsFrom,
  settleProblems,
  watchPrograms,
  watchProcessPackage,
} from "./program-watch-support.ts";

// 계약 시험(runtime-contract.ts)의 반환 뒤 판정이 실패해야 할 때 실패하는지 본다. 판정과 프로그램 관찰을 계약 시험 밖의 작은
// 단위로 떼어, 결함 사례를 넣으면 정확한 이유로 걸리는지 고정한다(#294 외부 리뷰 1회차 SPEC-2 parent 점검).

/** 시험이 끝을 정하는 약속. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("judging a run that returned", () => {
  const clean = {
    launches: "programs" as const,
    started: 1,
    notEnded: 0,
    startedAfterReturn: 0,
  };

  it("finds nothing when the declared programs all ended before the return and none started after", () => {
    expect(settleProblems(clean)).toEqual([]);
    expect(
      settleProblems({ ...clean, launches: "nothing", started: 0 })
    ).toEqual([]);
  });

  it("names a program that had not ended when the run returned", () => {
    expect(settleProblems({ ...clean, started: 2, notEnded: 1 })).toEqual([
      "1 of the 2 programs the run started had not ended (or their end was not confirmed) when it returned",
    ]);
  });

  it("names programs started after the run returned", () => {
    expect(settleProblems({ ...clean, startedAfterReturn: 2 })).toEqual([
      "2 programs started after the run returned",
    ]);
  });

  it("does not let a run that declares programs pass with none seen", () => {
    expect(settleProblems({ ...clean, started: 0 })).toEqual([
      "declares that its runs start programs, but this run started none",
    ]);
  });

  it("does not let a run that declares nothing start programs", () => {
    expect(
      settleProblems({ ...clean, launches: "nothing", started: 3 })
    ).toEqual(["declares that it starts nothing, but this run started 3"]);
  });
});

describe("the activity log of a run", () => {
  it("keeps activities before the return and refuses and keeps one after it, even when the adapter swallows the refusal", async () => {
    const log = activityLog("adapter");
    log.record({ type: "progress", text: "before" });
    log.markReturned();
    // adapter가 거절을 처리해 버리는 경우: 거절은 사라져도 기록은 남는다.
    const swallowed = await Promise.resolve()
      .then(() => log.record({ type: "progress", text: "after" }))
      .then(
        () => "accepted",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error)
      );
    expect(swallowed).toBe(
      'adapter emitted an activity after the run returned: {"type":"progress","text":"after"}'
    );
    expect(log.activities).toEqual([{ type: "progress", text: "before" }]);
    expect(log.late).toEqual([{ type: "progress", text: "after" }]);
  });
});

describe("watching the programs runs start", () => {
  it("counts a run's program and sees it end only when its done is fulfilled", async () => {
    const done = deferred();
    const watched = watchPrograms({
      startProcess: () => ({ done: done.promise }),
    });
    const before = programCount();
    watched.startProcess();
    const [program] = programsFrom(before);
    expect(programCount()).toBe(before + 1);
    expect(program?.state).toBe("running");
    done.resolve();
    await program?.end;
    expect(program?.state).toBe("ended");
  });

  it("does not take a run's failed done as its end", async () => {
    const done = deferred();
    const watched = watchPrograms({
      startProcess: () => ({ done: done.promise }),
    });
    const before = programCount();
    watched.startProcess();
    const [program] = programsFrom(before);
    done.reject(new Error("cleanup failed"));
    await program?.end;
    expect(program?.state).toBe("unconfirmed");
  });

  it("sees a launched tree end only after its stop settled and its output closed", async () => {
    const stopped = deferred();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const watched = watchProcessPackage({
      launchTree: () => ({ stop: () => stopped.promise, stdout, stderr }),
      runTree: () => Promise.resolve(),
    });
    const before = programCount();
    const tree = watched.launchTree();
    const [program] = programsFrom(before);
    expect(programCount()).toBe(before + 1);
    const stopping = tree.stop();
    stopped.resolve();
    await stopping;
    // 끄기는 끝났지만 출력이 아직 열려 있다.
    expect(program?.state).toBe("running");
    stdout.destroy();
    stderr.destroy();
    await program?.end;
    expect(program?.state).toBe("ended");
  });

  it("does not take a tree that was never stopped as ended", () => {
    const watched = watchProcessPackage({
      launchTree: () => ({
        stop: () => Promise.resolve(),
        stdout: null,
        stderr: null,
      }),
      runTree: () => Promise.resolve(),
    });
    const before = programCount();
    watched.launchTree();
    expect(programsFrom(before).map((p) => p.state)).toEqual(["running"]);
  });

  it("sees a short command end when its run settles", async () => {
    const ran = deferred();
    const watched = watchProcessPackage({
      launchTree: () => ({
        stop: () => Promise.resolve(),
        stdout: null,
        stderr: null,
      }),
      runTree: () => ran.promise,
    });
    const before = programCount();
    const run = watched.runTree();
    const [program] = programsFrom(before);
    expect(program?.state).toBe("running");
    ran.resolve();
    await run;
    await program?.end;
    expect(program?.state).toBe("ended");
  });
});
