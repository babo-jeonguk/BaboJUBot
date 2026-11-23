// worker 호출의 시도·멈춤·결과 판정(#255 리뷰 SPEC-1·SPEC-4). opencode를 띄우는 일은 그 끄기와 한 쌍(공용 실행의 트리)인 대역으로
// 넣는다. 실제 프로세스로는 끄기 확인 실패(SIGKILL 뒤에도 끝나지 않는 트리)를 만들 수 없어 여기서 본다. 실제 프로세스 시험은
// run-worker.test.ts.
// 세션 확인·한도는 시험이 옮기는 시계(`manualClock`)로 잰다. 시험은 띄움·끄기 시작 같은 상태를 본 뒤에만 시계를 옮겨, 시한과
// 대역의 순서가 실제 시간이 아니라 시험이 정한 차례로 온다(#286 항목 33).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TreeExit, TreeStart } from "@babojubot/process";
import { manualClock, within } from "@babojubot/process/test-support";
import { createWorkerRun, outcome, type WorkerTree } from "./worker-run.ts";

/** 띄운 opencode 트리 대역: 번호와 대표의 종료를 흉내 내는 `end`가 더 있다. */
interface FakeWorker extends WorkerTree {
  pid: number;
  end: (code: number | null, signal?: NodeJS.Signals | null) => void;
}

/**
 * 띄운 opencode 트리 대역. 스스로는 끝나지 않는다. `end(code)`로 대표의 종료를 흉내 내고, `stop()`은 시험이 준 끄기로 끝난다.
 */
function fakeWorker(
  pid: number,
  stop: (tree: FakeWorker) => Promise<void>
): FakeWorker {
  const exit = Promise.withResolvers<TreeExit>();
  const tree: FakeWorker = {
    pid,
    started: Promise.resolve<TreeStart>({ kind: "running" }),
    exited: exit.promise,
    // 지침은 보냈다. 보내기 실패·끝나지 않는 쓰기는 시험이 바꿔 넣는다.
    delivered: Promise.resolve(undefined),
    abandonBrief: () => undefined,
    end: (code, signal = null) => exit.resolve({ code, signal }),
    stop: () => stop(tree),
  };
  return tree;
}

/** 대역을 띄우는 launch와 띄운 목록. `stop`은 각 트리의 끄기다. `launchedCount(n)`은 n번째 띄움이 오면 이행한다. */
function launcher(stop: (tree: FakeWorker) => Promise<void>) {
  const launched: FakeWorker[] = [];
  const waiting: { count: number; arrived: () => void }[] = [];
  return {
    launched,
    launch: () => {
      const tree = fakeWorker(100 + launched.length, stop);
      launched.push(tree);
      for (const wait of waiting.filter((w) => w.count <= launched.length))
        wait.arrived();
      return tree;
    },
    launchedCount: (count: number) =>
      within(
        new Promise<void>((arrived) => {
          if (launched.length >= count) arrived();
          else waiting.push({ count, arrived });
        }),
        10_000,
        `launch ${count} did not come`
      ),
  };
}

const treeStuck = () => Promise.reject(new Error("Process tree did not stop"));
const treeGone = () => Promise.resolve();

/** 호출을 끝까지 돌린다. 대역은 모두 메모리 안이라 곧 끝난다. 끝나지 않으면(시도가 무언가를 끝없이 기다리면) 그렇게 알리고 실패한다. */
async function finish(
  run: ReturnType<typeof createWorkerRun>,
  options: { limitMs: number; session: string; errors: string[] }
) {
  const ended = await within(run.run(), 10_000, "the worker call did not end");
  return { ...ended, outcome: outcome({ ...ended, ...options }) };
}

test("a stop that cannot confirm the tree gone at --limit ends the call with exit code 4 and its reason", async () => {
  const stopped: number[] = [];
  const { launch, launched, launchedCount } = launcher((tree) => {
    stopped.push(tree.pid);
    return treeStuck();
  });
  const clock = manualClock();
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 600_000,
    limitMs: 60_000,
    clock,
  });
  const running = finish(run, { limitMs: 60_000, session: "", errors: [] });
  await launchedCount(1);
  clock.advance(60_000);
  const ended = await running;
  assert.equal(launched.length, 1);
  assert.deepEqual(stopped, [100]);
  assert.equal(ended.attempts, 1);
  assert.deepEqual(ended.outcome, [
    "could not confirm the worker process tree stopped (limit): Process tree did not stop",
    4,
  ]);
});

test("a failed stop at the start check is not followed by a second worker", async () => {
  const { launch, launched, launchedCount } = launcher(treeStuck);
  const clock = manualClock();
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 600_000,
    clock,
  });
  const running = finish(run, { limitMs: 600_000, session: "", errors: [] });
  await launchedCount(1);
  clock.advance(60_000);
  const ended = await running;
  assert.equal(launched.length, 1);
  assert.equal(ended.attempts, 1);
  assert.deepEqual(ended.outcome, [
    "could not confirm the worker process tree stopped (start-check): Process tree did not stop",
    4,
  ]);
});

test("a stopped attempt ends with its stop even when its leader never exits", async () => {
  // 대표가 끝나지 않아도(exit가 오지 않아도) 끄기가 끝나면 그 시도는 끝난다. 세션이 없으니 한 번 다시 띄운다. 다시 띄운 시도의
  // 세션 확인은 그 시도가 띄워진 뒤에 온다.
  const { launch, launched, launchedCount } = launcher(treeGone);
  const clock = manualClock();
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 600_000,
    clock,
  });
  const running = finish(run, { limitMs: 600_000, session: "", errors: [] });
  await launchedCount(1);
  clock.advance(60_000);
  await launchedCount(2);
  clock.advance(60_000);
  const ended = await running;
  assert.equal(launched.length, 2);
  assert.equal(ended.attempts, 2);
  assert.deepEqual(ended.outcome, ["no session started", 3]);
});

test("an attempt stopped at --limit is not launched again and ends with exit code 4", async () => {
  const { launch, launched, launchedCount } = launcher(treeGone);
  const clock = manualClock();
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 600_000,
    limitMs: 0.5 * 60_000,
    clock,
  });
  const running = finish(run, {
    limitMs: 0.5 * 60_000,
    session: "",
    errors: [],
  });
  await launchedCount(1);
  clock.advance(0.5 * 60_000);
  const ended = await running;
  assert.equal(launched.length, 1);
  assert.deepEqual(ended.outcome, ["stopped after the 0.5-minute limit", 4]);
});

test("a signal to the runner stops the attempt, starts no other and ends with 128 + its number", async () => {
  const stopped: number[] = [];
  const { launch, launched } = launcher((tree) => {
    stopped.push(tree.pid);
    return treeGone();
  });
  const run = createWorkerRun({
    launch,
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 60_000,
    clock: manualClock(),
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
    clock: manualClock(),
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
  const stopped: number[] = [];
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
    clock: manualClock(),
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
    clock: manualClock(),
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

// 감독 실행기를 쓸 수 없으면 공용 실행이 띄우기를 거절한다. 그 이유가 시작 실패로 남고 다시 띄우지 않는다.
test("a refused launch ends the call with exit code 4 and its reason", async () => {
  let launches = 0;
  const run = createWorkerRun({
    launch: () => {
      launches += 1;
      throw new Error("the supervisor is not available");
    },
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 60_000,
    clock: manualClock(),
  });
  const ended = await finish(run, { limitMs: 60_000, session: "", errors: [] });
  assert.equal(launches, 1);
  assert.deepEqual(ended.outcome, [
    "spawn failed: the supervisor is not available",
    4,
  ]);
});

// 지침을 보내지 못한 시도(worker가 읽기 전에 끝나 EPIPE 등)는 모델의 오류 이벤트가 아니라 실행 실패다. 오류 이벤트(종료 코드 2)는
// 상위 호출자에게 다음 모델로 넘어가라는 뜻이라 그 신호를 내지 않고, 이유와 함께 종료 코드 4로 끝난다(#284 리뷰).
test("an attempt whose brief could not be sent ends the call with exit code 4 and the reason, not as an error event", async () => {
  const run = createWorkerRun({
    launch: () => {
      const tree = fakeWorker(100, treeGone);
      tree.delivered = Promise.resolve("EPIPE");
      // 지침을 읽지 않고 곧바로 끝난다.
      queueMicrotask(() => tree.end(0));
      return tree;
    },
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 60_000,
    clock: manualClock(),
  });
  const ended = await finish(run, { limitMs: 60_000, session: "", errors: [] });
  assert.equal(ended.attempts, 2);
  assert.equal(ended.result.sendFailure, "EPIPE");
  assert.deepEqual(ended.outcome, ["could not send the brief: EPIPE", 4]);
});

// 보내기 실패는 그 시도에 묶인다. 첫 시도가 지침을 보내지 못하고 세션 없이 끝나 다시 띄운 둘째 시도가 지침을 보내고 마치면, 결과에
// 첫 시도의 실패가 남지 않는다. 시도는 자기 보내기가 끝난 뒤에 끝나므로 앞 시도의 늦은 실패가 뒤 시도에 닿을 수도 없다.
test("a brief failure belongs to its attempt: a second attempt that sends the brief finishes without it", async () => {
  let session = false;
  const deliveries = ["EPIPE", undefined];
  const { launch, launched } = launcher(treeGone);
  const run = createWorkerRun({
    launch: () => {
      const tree = launch();
      tree.delivered = Promise.resolve(deliveries[launched.length - 1]);
      const second = launched.length === 2;
      queueMicrotask(() => {
        // 첫 시도는 세션 없이, 둘째 시도는 세션을 만든 뒤 스스로 끝난다.
        if (second) session = true;
        tree.end(0);
      });
      return tree;
    },
    hasSession: () => session,
    startCheckMs: 60_000,
    limitMs: 60_000,
    clock: manualClock(),
  });
  const ended = await finish(run, {
    limitMs: 60_000,
    session: "ses-1",
    errors: [],
  });
  assert.equal(ended.attempts, 2);
  assert.equal(ended.result.sendFailure, undefined);
  assert.deepEqual(ended.outcome, ["finished", 0]);
});

/**
 * 지침 쓰기가 끝나지 않는 시도(살아 있는 worker가 표준 입력을 읽지 않아 큰 지침의 쓰기가 보류됨)의 대역. `delivered`는 스스로 끝나지
 * 않고, `abandonBrief()`가 불리면 그 기록을 남기고 "다 보내지 못함"을 돌려준다(run-worker는 이때 자기가 쥔 입력을 닫는다).
 */
function unfinishedBrief(tree: FakeWorker, abandoned: number[]) {
  tree.delivered = new Promise<string | undefined>(() => {});
  tree.abandonBrief = () => {
    abandoned.push(tree.pid);
    return "unfinished";
  };
  return tree;
}

// 끄기가 트리의 끝을 확인하지 못하면 지침을 읽을 쪽이 남았을 수 있어 쓰기는 끝나지 않을 수 있다. 시도는 그 쓰기를 기다리지 않고
// 접어 끄기 실패와 그 원인으로 끝난다. 보내기 결과는 그 시도 결과에 남지만 끄기 실패를 가리지 않는다(#284 리뷰 2회차 SPEC-1).
// 고치기 전에는 시도가 끝나지 않는 쓰기를 기다려 호출이 끝나지 않았다.
test("a stop that fails while the brief is still being written ends the call with the stop failure, without waiting for the write", async () => {
  const abandoned: number[] = [];
  const { launch, launched, launchedCount } = launcher(treeStuck);
  const clock = manualClock();
  const run = createWorkerRun({
    launch: () => unfinishedBrief(launch(), abandoned),
    hasSession: () => false,
    startCheckMs: 600_000,
    limitMs: 60_000,
    clock,
  });
  const running = finish(run, { limitMs: 60_000, session: "", errors: [] });
  await launchedCount(1);
  clock.advance(60_000);
  const ended = await running;
  assert.equal(launched.length, 1);
  assert.deepEqual(abandoned, [100]);
  assert.equal(ended.result.sendFailure, "unfinished");
  assert.deepEqual(ended.outcome, [
    "could not confirm the worker process tree stopped (limit): Process tree did not stop",
    4,
  ]);
});

// 시작하지 못한 시도는 끄기를 거치지 않으므로 트리의 끝이 확인되지 않았다. 끝나지 않은 쓰기를 접고 시작 실패로 끝난다.
test("an attempt that failed to start while the brief is still being written ends with the start failure", async () => {
  const abandoned: number[] = [];
  const { launch } = launcher(treeGone);
  const run = createWorkerRun({
    launch: () => {
      const tree = unfinishedBrief(launch(), abandoned);
      tree.started = Promise.resolve({ kind: "failed", reason: "ENOENT" });
      return tree;
    },
    hasSession: () => false,
    startCheckMs: 60_000,
    limitMs: 60_000,
    clock: manualClock(),
  });
  const ended = await finish(run, {
    limitMs: 60_000,
    session: "",
    errors: [],
  });
  assert.deepEqual(abandoned, [100]);
  assert.equal(ended.attempts, 1);
  assert.deepEqual(ended.outcome, ["spawn failed: ENOENT", 4]);
});

/**
 * 기다리기 시작하면(`then`) `onWait`를 부르는 Promise. 시도가 지침 쓰기의 결과를 기다리기 시작한 것을 신호로 본다(`await`도
 * `then`을 부른다).
 */
class WatchedWrite extends Promise<string | undefined> {
  onWait: () => void = () => {};
  override then<A = string | undefined, B = never>(
    onFulfilled?: ((sent: string | undefined) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    this.onWait();
    return super.then(onFulfilled, onRejected);
  }
}

// 끄기가 트리의 끝을 확인한 시도는 읽을 쪽이 남지 않아 쓰기가 반드시 끝난다(보냄 또는 EPIPE). 그 결과를 기다려 남기고 쓰기를
// 접지 않는다: 접으면 다 보낸 지침을 못 보낸 것으로 잘못 볼 수 있다. 차례는 신호로 정한다: 한도가 끄기를 부르고(끄기 시작), 시험이
// 끄기를 끝내면(정지 완료) 시도가 쓰기를 기다리는지 접는지 정하고(쓰기 보류), 그 뒤에야 쓰기가 EPIPE로 끝난다.
test("an attempt whose tree was confirmed stopped waits for the brief's write instead of abandoning it", async () => {
  const stopping = Promise.withResolvers<void>();
  const stopDone = Promise.withResolvers<void>();
  /** 끄기가 끝난 뒤 시도가 고른 일: 쓰기를 기다림, 또는 쓰기를 접음. */
  const chosen = Promise.withResolvers<"waits" | "abandons">();
  let release: (sent: string | undefined) => void = () => {};
  const write = new WatchedWrite((resolve) => (release = resolve));
  write.onWait = () => chosen.resolve("waits");
  const { launch, launchedCount } = launcher(() => {
    stopping.resolve();
    return stopDone.promise;
  });
  const clock = manualClock();
  const run = createWorkerRun({
    launch: () => {
      const tree = launch();
      tree.delivered = write;
      tree.abandonBrief = () => {
        chosen.resolve("abandons");
        return "unfinished";
      };
      return tree;
    },
    hasSession: () => true,
    startCheckMs: 600_000,
    limitMs: 60_000,
    clock,
  });
  const running = finish(run, {
    limitMs: 60_000,
    session: "ses-1",
    errors: [],
  });
  await launchedCount(1);
  clock.advance(60_000);
  await within(stopping.promise, 10_000, "the limit did not stop the tree");
  stopDone.resolve();
  assert.equal(
    await within(
      chosen.promise,
      10_000,
      "the attempt neither waited for the write nor abandoned it after the stop"
    ),
    "waits"
  );
  release("EPIPE");
  const ended = await running;
  assert.equal(ended.result.sendFailure, "EPIPE");
  assert.deepEqual(ended.outcome, ["could not send the brief: EPIPE", 4]);
});
