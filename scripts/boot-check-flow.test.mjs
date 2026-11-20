// boot-check의 단계 진행과 멈춤을 가짜 단계로 돌린다. 정리하는 쪽은 흐름 하나뿐이므로, 멈춤이 DB를 여는 중이나
// 닫는 중에 와도 그 작업이 끝나기 전에는 정리가 시작되지 않아야 한다. 작업을 붙잡아 둔 채 멈춤을 요청하고, 정리가 아직
// 없는지 본 뒤 작업을 풀어 순서를 확인한다(실제 Postgres는 scripts/boot-check.test.mjs가 돌린다).
// 멈춤 요청은 이유를 남기고 동기로 돌아오므로, 요청 직후가 그 처리의 끝이다. 시간을 기다리지 않는다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStop, runBootCheckFlow } from "./boot-check-flow.mjs";

test("waits for an opening database before it cleans up on stop", async () => {
  const opening = deferred();
  const { events, ops, stop, reached } = fakeRun({
    open: () => opening.promise,
  });
  const run = runBootCheckFlow(ops);
  await reached("open:start");

  stop.request("stop requested");
  assert.deepEqual(after(events, "open:start"), ["stop requested"]);

  opening.resolve("handle");
  const { code } = await run;
  assert.equal(code, 1);
  assert.deepEqual(after(events, "open:start"), [
    "stop requested",
    "open:end",
    "close:handle",
    "stop left Postgres",
    "stop servers",
    "removeFolder",
  ]);
});

test("waits for a closing database before it cleans up on stop", async () => {
  const closing = deferred();
  const { events, ops, stop, reached } = fakeRun({
    close: () => closing.promise,
  });
  const run = runBootCheckFlow(ops);
  await reached("close:handle");

  stop.request("stop requested");
  assert.deepEqual(after(events, "close:handle"), ["stop requested"]);

  closing.resolve();
  const { code } = await run;
  assert.equal(code, 1);
  // 닫은 handle은 다시 닫지 않는다.
  assert.deepEqual(after(events, "close:handle"), [
    "stop requested",
    "stop left Postgres",
    "stop servers",
    "removeFolder",
  ]);
});

test("stops at the next step after a server start and cleans up once", async () => {
  const starting = deferred();
  const { events, ops, stop, reached } = fakeRun({
    serve: (label) => (label === "first start" ? starting.promise : undefined),
  });
  const run = runBootCheckFlow(ops);
  await reached("serve:first start");

  stop.request("stop requested");
  starting.resolve();
  const { code } = await run;
  assert.equal(code, 1);
  assert.deepEqual(events, [
    "serve:first start",
    "stop requested",
    "stop left Postgres",
    "stop servers",
    "removeFolder",
  ]);
});

test("runs every step and cleans up once without a stop", async () => {
  const { events, ops } = fakeRun();
  const { code } = await runBootCheckFlow(ops);
  assert.equal(code, 0);
  assert.deepEqual(events, [
    "serve:first start",
    "serve:start after a killed server",
    "open:start",
    "open:end",
    "close:handle",
    "stop left Postgres",
    "stop servers",
    "removeFolder",
  ]);
});

test("fails and still cleans up when a step fails", async () => {
  const { events, ops } = fakeRun({
    open: () => Promise.reject(new Error("could not open")),
  });
  const { code, failures } = await runBootCheckFlow(ops);
  assert.equal(code, 1);
  assert.deepEqual(
    failures.map((failure) => failure.message),
    ["could not open"]
  );
  assert.equal(events.at(-1), "removeFolder");
  assert.equal(events.filter((event) => event === "removeFolder").length, 1);
});

// #263 외부 리뷰 3회차 S4: 정리의 DB 닫기가 실패해도 서로 독립인 끄기(남은 Postgres 멈춤, 서버 트리 끄기)는 모두 시도하고 두 실패를
// 함께 알린다. 끄기가 하나라도 실패하면 아직 쓰일 수 있는 폴더는 지우지 않는다.
test("still stops the left Postgres and the servers when closing the database fails, and reports both", async () => {
  const { events, ops } = fakeRun({
    close: () => Promise.reject(new Error("could not close")),
  });
  ops.expectCleanStart = (label) => {
    if (label === "open after another killed server")
      throw new Error("not a clean start");
  };
  const { code, failures } = await runBootCheckFlow(ops);
  assert.equal(code, 1);
  assert.deepEqual(after(events, "open:end"), [
    "close:handle",
    "stop left Postgres",
    "stop servers",
  ]);
  assert.match(
    failures.map((failure) => failure.message).join("\n"),
    /not a clean start[\s\S]*could not close/
  );
});

test("gives up after the stop grace when a step never finishes", (t) => {
  // 유예 타이머를 시험이 옮긴다.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let expired = 0;
  const stop = createStop({
    graceMs: 50,
    onGraceExpired: () => expired++,
    log: () => {},
  });
  stop.request("first");
  stop.request("second");
  assert.equal(stop.reason, "first");
  t.mock.timers.tick(49);
  assert.equal(expired, 0);
  t.mock.timers.tick(1);
  assert.equal(expired, 1);
  // 두 번째 요청은 유예를 다시 걸지 않는다.
  t.mock.timers.tick(1_000);
  assert.equal(expired, 1);
});

/** 기록되는 가짜 단계. `overrides`의 함수가 promise를 돌려주면 그 단계는 그 promise가 끝날 때까지 걸려 있다. */
function fakeRun(overrides = {}) {
  const events = [];
  /** 기록을 기다리는 쪽. 기록이 남으면 그 자리에서 풀린다. */
  const waiters = [];
  const note = (event) => {
    events.push(event);
    for (const waiter of waiters.splice(0))
      if (waiter.event === event) waiter.resolve();
      else waiters.push(waiter);
  };
  const reached = (event) =>
    events.includes(event)
      ? Promise.resolve()
      : new Promise((resolve) => waiters.push({ event, resolve }));
  const stop = createStop({
    graceMs: 60_000,
    onGraceExpired: () => note("grace expired"),
    log: (message) => note(message),
  });
  const ops = {
    stop,
    log: () => {},
    async serve(label) {
      note(`serve:${label}`);
      await overrides.serve?.(label);
    },
    expectLeftover: () => {},
    expectCleanStart: () => {},
    async open() {
      note("open:start");
      const handle = overrides.open ? await overrides.open() : "handle";
      note("open:end");
      return handle;
    },
    async close(handle) {
      note(`close:${handle}`);
      await overrides.close?.(handle);
    },
    expectClosed: () => {},
    // 서로 독립인 끄기(남은 Postgres 멈춤, 서버 트리 끄기)와, 그것이 모두 끝나야 하는 폴더 지우기.
    stops: () => [
      async () => {
        note("stop left Postgres");
        await overrides.stopLeftPostgres?.();
      },
      async () => {
        note("stop servers");
      },
    ],
    async removeFolder() {
      note("removeFolder");
    },
  };
  return { events, ops, stop, reached };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const after = (events, marker) => events.slice(events.indexOf(marker) + 1);
