import { expect, it, onTestFinished, vi } from "vitest";
import { keepAppending } from "./appending-writer.ts";
import { withCleanup } from "@babojubot/process/test-cleanup";

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
/**
 * writer가 시험의 다음 행동 없이 할 수 있는 일을 모두 마친 뒤 `promise`가 끝났는가. writer는 타이머와 microtask로만 움직이고(덧붙이기는
 * 시험이 붙잡는다) 시험은 가짜 시계를 켠다(`fakeClock`). 그래서 가짜 시계의 타이머를 남김없이 돌리고 microtask가 빈 뒤에는 저절로 일어날
 * 일이 남지 않는다. 이벤트 루프 한 차례만 기다리면 타이머로 미룬 끝남을 놓쳤다(#286).
 */
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true)
  );
  await vi.runAllTimersAsync();
  return done;
};

/** 가짜 시계를 켜고 시험이 끝나면 되돌린다. 첫 덧붙이기는 시계를 1ms 옮겨 시작한다. */
function fakeClock() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

it("waits for an append already in progress before it reports stopped", async () => {
  fakeClock();
  const held = heldAppend();
  const writer = keepAppending("run.log", "더\n", { append: held.append });
  await vi.advanceTimersByTimeAsync(1);
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
      "appends to run.log did not finish within 50 ms"
    );
  } finally {
    held.release();
  }
});

it("does not start the next append before the one in progress has finished", async () => {
  vi.useFakeTimers();
  try {
    const held = heldAppend();
    const writer = keepAppending("run.log", "더\n", { append: held.append });
    await vi.advanceTimersByTimeAsync(50);
    expect(held.calls()).toBe(1);
    held.release();
    await vi.advanceTimersByTimeAsync(50);
    expect(held.calls()).toBeGreaterThan(1);
    await writer.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("waits for the append in progress when the test fails before it stops the writer", async () => {
  fakeClock();
  const held = heldAppend();
  const writer = keepAppending("run.log", "더\n", { append: held.append });
  await vi.advanceTimersByTimeAsync(1);
  await held.firstStarted;
  // 시험 본문이 단언에서 실패해도 등록한 정리가 writer를 멈추고 진행 중인 쓰기를 기다린다.
  const test = withCleanup(async (defer) => {
    defer(() => writer.stop());
    throw new Error("assertion failed");
  });
  expect(await settled(test)).toBe(false);
  held.release();
  await expect(test).rejects.toThrow("assertion failed");
  expect(held.calls()).toBe(1);
});
