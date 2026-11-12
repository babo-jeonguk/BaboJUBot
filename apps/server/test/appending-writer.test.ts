import { expect, it } from "vitest";
import { keepAppending } from "./appending-writer.ts";

// timer를 멈춰도 이미 시작한 쓰기는 계속된다. 그 쓰기가 폴더 정리와 겹치면 끝난 시험 뒤에 오류가 난다.
// writer를 멈추는 쪽은 새 쓰기를 막고, 시작한 쓰기가 모두 끝날 때까지 기다리며, 그 실패를 숨기지 않는다.

/** 덧붙이기를 보류해 진행 중인 쓰기를 만든다. 첫 쓰기가 시작되면 started가 풀린다. */
function heldAppend(fail?: Error) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  return {
    calls: () => calls,
    firstStarted,
    release,
    append: async () => {
      calls++;
      started();
      await gate;
      if (fail) throw fail;
    },
  };
}
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true)
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

it("waits for an append already in progress before it reports stopped", async () => {
  const held = heldAppend();
  const writer = keepAppending("run.log", "더\n", { append: held.append });
  await held.firstStarted;
  const stopped = writer.stop();
  const callsAtStop = held.calls();

  expect(await settled(stopped)).toBe(false);
  held.release();
  await stopped;
  expect(held.calls()).toBe(callsAtStop);
});

it("reports a failed append once it has stopped instead of leaving it unhandled", async () => {
  const held = heldAppend(new Error("ENOENT"));
  const writer = keepAppending("run.log", "더\n", { append: held.append });
  await held.firstStarted;
  const stopped = writer.stop();
  held.release();
  await expect(stopped).rejects.toThrow("ENOENT");
});

it("fails by name when an append in progress never finishes", async () => {
  const held = heldAppend();
  const writer = keepAppending("run.log", "더\n", {
    append: held.append,
    stopTimeoutMs: 50,
  });
  await held.firstStarted;
  try {
    await expect(writer.stop()).rejects.toThrow(
      "appends to run.log did not finish in 50ms"
    );
  } finally {
    held.release();
  }
});
