// boot-check의 단계 진행과 멈춤을 가짜 단계로 돌린다. 정리하는 쪽은 흐름 하나뿐이므로, 멈춤이 DB를 여는 중이나
// 닫는 중에 와도 그 작업이 끝나기 전에는 정리가 시작되지 않아야 한다. 작업을 붙잡아 둔 채 멈춤을 요청하고, 정리가 아직
// 없는지 본 뒤 작업을 풀어 순서를 확인한다(실제 Postgres는 scripts/boot-check.test.mjs가 돌린다).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStop, runBootCheckFlow } from "./boot-check-flow.mjs";

test("waits for an opening database before it cleans up on stop", async () => {
  const opening = deferred();
  const { events, ops, stop } = fakeRun({ open: () => opening.promise });
  const run = runBootCheckFlow(ops);
  await until(() => events.includes("open:start"));

  stop.request("stop requested");
  await settle();
  assert.deepEqual(after(events, "open:start"), ["stop requested"]);

  opening.resolve("handle");
  const { code } = await run;
  assert.equal(code, 1);
  assert.deepEqual(after(events, "open:start"), [
    "stop requested",
    "open:end",
    "close:handle",
    "cleanUp",
  ]);
});

test("waits for a closing database before it cleans up on stop", async () => {
  const closing = deferred();
  const { events, ops, stop } = fakeRun({ close: () => closing.promise });
  const run = runBootCheckFlow(ops);
  await until(() => events.includes("close:handle"));

  stop.request("stop requested");
  await settle();
  assert.deepEqual(after(events, "close:handle"), ["stop requested"]);

  closing.resolve();
  const { code } = await run;
  assert.equal(code, 1);
  // 닫은 handle은 다시 닫지 않는다.
  assert.deepEqual(after(events, "close:handle"), [
    "stop requested",
    "cleanUp",
  ]);
});

test("stops at the next step after a server start and cleans up once", async () => {
  const starting = deferred();
  const { events, ops, stop } = fakeRun({
    serve: (label) => (label === "first start" ? starting.promise : undefined),
  });
  const run = runBootCheckFlow(ops);
  await until(() => events.includes("serve:first start"));

  stop.request("stop requested");
  starting.resolve();
  const { code } = await run;
  assert.equal(code, 1);
  assert.deepEqual(events, ["serve:first start", "stop requested", "cleanUp"]);
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
    "cleanUp",
  ]);
});

test("fails and still cleans up when a step fails", async () => {
  const { events, ops } = fakeRun({
    open: () => Promise.reject(new Error("could not open")),
  });
  const { code, failure } = await runBootCheckFlow(ops);
  assert.equal(code, 1);
  assert.equal(failure.message, "could not open");
  assert.equal(events.at(-1), "cleanUp");
  assert.equal(events.filter((event) => event === "cleanUp").length, 1);
});

test("gives up after the stop grace when a step never finishes", async () => {
  let expired = 0;
  const stop = createStop({
    graceMs: 50,
    onGraceExpired: () => expired++,
    log: () => {},
  });
  stop.request("first");
  stop.request("second");
  assert.equal(stop.reason, "first");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(expired, 1);
});

/** 기록되는 가짜 단계. `overrides`의 함수가 promise를 돌려주면 그 단계는 그 promise가 끝날 때까지 걸려 있다. */
function fakeRun(overrides = {}) {
  const events = [];
  const stop = createStop({
    graceMs: 60_000,
    onGraceExpired: () => events.push("grace expired"),
    log: (message) => events.push(message),
  });
  const ops = {
    stop,
    log: () => {},
    async serve(label) {
      events.push(`serve:${label}`);
      await overrides.serve?.(label);
    },
    expectLeftover: () => {},
    expectCleanStart: () => {},
    async open() {
      events.push("open:start");
      const handle = overrides.open ? await overrides.open() : "handle";
      events.push("open:end");
      return handle;
    },
    async close(handle) {
      events.push(`close:${handle}`);
      await overrides.close?.(handle);
    },
    expectClosed: () => {},
    async cleanUp() {
      events.push("cleanUp");
    },
  };
  return { events, ops, stop };
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(check) {
  for (let i = 0; !check(); i++) {
    if (i > 200) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
