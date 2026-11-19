// worker 호출의 시도·멈춤·결과 판정(#255 리뷰 SPEC-1·SPEC-4). opencode를 띄우는 일은 그 끄기와 한 쌍(공용 실행의 트리)인 대역으로
// 넣는다. 실제 프로세스로는 끄기 확인 실패(SIGKILL 뒤에도 끝나지 않는 트리)를 만들 수 없어 여기서 본다. 실제 프로세스 시험은
// run-worker.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerRun, outcome } from "./worker-run.mjs";

/**
 * 띄운 opencode 트리 대역. 스스로는 끝나지 않는다. `end(code)`로 대표의 종료를 흉내 내고, `stop()`은 시험이 준 끄기로 끝난다.
 */
function fakeWorker(pid, stop) {
  let reportExit;
  const tree = {
    pid,
    started: Promise.resolve({ kind: "running" }),
    exited: new Promise((resolve) => {
      reportExit = resolve;
    }),
    end: (code, signal = null) => reportExit({ code, signal }),
    stop: () => stop(tree),
  };
  return tree;
}

/** 대역을 띄우는 launch와 띄운 목록. `stop`은 각 트리의 끄기다. */
function launcher(stop) {
  const launched = [];
  return {
    launched,
    launch: () => {
      const tree = fakeWorker(100 + launched.length, stop);
      launched.push(tree);
      return tree;
    },
  };
}

const treeStuck = () => Promise.reject(new Error("Process tree did not stop"));
const treeGone = () => Promise.resolve();

async function finish(run, options) {
  const ended = await run.run();
  return { ...ended, outcome: outcome({ ...ended, ...options }) };
}

test("a stop that cannot confirm the tree gone at --limit ends the call with exit code 4 and its reason", async () => {
  const stopped = [];
  const { launch, launched } = launcher((tree) => {
    stopped.push(tree.pid);
    return treeStuck();
  });
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 20,
  });
  const ended = await finish(run, { limitMs: 20, session: "", errors: [] });
  assert.equal(launched.length, 1);
  assert.deepEqual(stopped, [100]);
  assert.equal(ended.attempts, 1);
  assert.deepEqual(ended.outcome, [
    "could not confirm the worker process tree stopped (limit): Process tree did not stop",
    4,
  ]);
});

test("a failed stop at the start check is not followed by a second worker", async () => {
  const { launch, launched } = launcher(treeStuck);
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 10,
    limitMs: 60_000,
  });
  const ended = await finish(run, { limitMs: 60_000, session: "", errors: [] });
  assert.equal(launched.length, 1);
  assert.equal(ended.attempts, 1);
  assert.deepEqual(ended.outcome, [
    "could not confirm the worker process tree stopped (start-check): Process tree did not stop",
    4,
  ]);
});

test("a stopped attempt ends with its stop even when its leader never exits", async () => {
  // 대표가 끝나지 않아도(exit가 오지 않아도) 끄기가 끝나면 그 시도는 끝난다. 세션이 없으니 한 번 다시 띄운다.
  const { launch, launched } = launcher(treeGone);
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 10,
    limitMs: 60_000,
  });
  const ended = await finish(run, { limitMs: 60_000, session: "", errors: [] });
  assert.equal(launched.length, 2);
  assert.equal(ended.attempts, 2);
  assert.deepEqual(ended.outcome, ["no session started", 3]);
});

test("an attempt stopped at --limit is not launched again and ends with exit code 4", async () => {
  const { launch, launched } = launcher(treeGone);
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 20,
  });
  const ended = await finish(run, {
    limitMs: 0.5 * 60_000,
    session: "",
    errors: [],
  });
  assert.equal(launched.length, 1);
  assert.deepEqual(ended.outcome, ["stopped after the 0.5-minute limit", 4]);
});

test("a signal to the runner stops the attempt, starts no other and ends with 128 + its number", async () => {
  const stopped = [];
  const { launch, launched } = launcher((tree) => {
    stopped.push(tree.pid);
    return treeGone();
  });
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 60_000,
  });
  const running = finish(run, { limitMs: 60_000, session: "", errors: [] });
  run.requestStop("SIGTERM");
  const ended = await running;
  assert.equal(launched.length, 1);
  assert.deepEqual(stopped, [100]);
  assert.deepEqual(ended.outcome, ["stopped by SIGTERM", 143]);
});

test("a signal whose stop fails keeps the stop failure as the result", async () => {
  const { launch } = launcher(treeStuck);
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 60_000,
  });
  const running = finish(run, { limitMs: 60_000, session: "", errors: [] });
  run.requestStop("SIGINT");
  const ended = await running;
  assert.deepEqual(ended.outcome, [
    "could not confirm the worker process tree stopped (SIGINT): Process tree did not stop",
    4,
  ]);
});

// 스스로 끝난 worker도 남긴 명령(백그라운드 셸 등)이 있을 수 있다. 시도는 그 트리를 끈 결과로 끝난다.
test("a worker that ends on its own with a session finishes after its tree is stopped", async () => {
  const stopped = [];
  let session = false;
  const { launch, launched } = launcher((tree) => {
    stopped.push(tree.pid);
    return treeGone();
  });
  const run = createWorkerRun({
    launch: () => {
      const tree = launch();
      // 세션을 만든 뒤 스스로 끝난다.
      queueMicrotask(() => {
        session = true;
        tree.end(0);
      });
      return tree;
    },
    hasSession: () => session,
    startCheckMs: 60_000,
    limitMs: 60_000,
  });
  const ended = await finish(run, {
    limitMs: 60_000,
    session: "ses-1",
    errors: [],
  });
  assert.equal(launched.length, 1);
  assert.deepEqual(stopped, [100]);
  assert.deepEqual(ended.outcome, ["finished", 0]);
});

test("a worker that ends on its own but whose tree cannot be confirmed stopped ends with exit code 4", async () => {
  let session = false;
  const { launch, launched } = launcher(treeStuck);
  const run = createWorkerRun({
    launch: () => {
      const tree = launch();
      queueMicrotask(() => {
        session = true;
        tree.end(0);
      });
      return tree;
    },
    hasSession: () => session,
    startCheckMs: 60_000,
    limitMs: 60_000,
  });
  const ended = await finish(run, {
    limitMs: 60_000,
    session: "ses-1",
    errors: [],
  });
  assert.equal(launched.length, 1);
  assert.deepEqual(ended.outcome, [
    "could not confirm the worker process tree stopped (after it ended): Process tree did not stop",
    4,
  ]);
});

// Windows에서 묶음 실행기를 쓸 수 없으면 공용 실행이 띄우기를 거절한다. 그 이유가 시작 실패로 남고 다시 띄우지 않는다.
test("a refused launch ends the call with exit code 4 and its reason", async () => {
  let launches = 0;
  const run = createWorkerRun({
    launch: () => {
      launches += 1;
      throw new Error("the Windows job object launcher is not available");
    },
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 60_000,
  });
  const ended = await finish(run, { limitMs: 60_000, session: "", errors: [] });
  assert.equal(launches, 1);
  assert.deepEqual(ended.outcome, [
    "spawn failed: the Windows job object launcher is not available",
    4,
  ]);
});
