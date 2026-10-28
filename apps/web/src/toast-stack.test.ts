import { describe, expect, test } from "vitest";
import {
  dismissToast,
  expireToasts,
  holdToast,
  nextExpiry,
  pushToast,
  releaseToast,
  visibleToasts,
  toastDurationMs,
  toastStackLimit,
  type ToastEntry,
} from "./toast-stack.ts";

type Entry = ToastEntry<{ message: string }>;
const push = (stack: readonly Entry[], id: number, now: number) =>
  pushToast(stack, { id, message: `토스트 ${id}` }, now);
const ids = (stack: readonly Entry[]) => stack.map((t) => t.id);

describe("toast stack", () => {
  test("a new toast leaves the earlier one its own remaining time", () => {
    let stack = push([], 1, 0);
    stack = push(stack, 2, 4_000);
    expect(ids(stack)).toEqual([1, 2]);
    expect(nextExpiry(stack)).toBe(toastDurationMs);

    // 앞 토스트는 제 10초에 닫히고, 뒤 토스트는 그 뒤 4초를 더 남는다.
    stack = expireToasts(stack, toastDurationMs);
    expect(ids(stack)).toEqual([2]);
    expect(nextExpiry(stack)).toBe(4_000 + toastDurationMs);
    expect(expireToasts(stack, 4_000 + toastDurationMs)).toEqual([]);
  });

  test("holding one toast pauses only that toast, and releasing resumes its remaining time", () => {
    let stack = push(push([], 1, 0), 2, 0);
    stack = holdToast(stack, 1, 3_000);
    expect(nextExpiry(stack)).toBe(toastDurationMs);
    stack = expireToasts(stack, 60_000);
    expect(ids(stack)).toEqual([1]);
    expect(nextExpiry(stack)).toBeNull();

    // 3초 흐른 뒤 멈췄으니 놓은 때부터 7초가 남는다.
    stack = releaseToast(stack, 1, 60_000);
    expect(nextExpiry(stack)).toBe(67_000);
    expect(ids(expireToasts(stack, 66_999))).toEqual([1]);
    expect(expireToasts(stack, 67_000)).toEqual([]);
  });

  test("holding a held toast, releasing a running one or expiring nothing keeps the same stack", () => {
    const stack = push([], 1, 0);
    expect(releaseToast(stack, 1, 5)).toBe(stack);
    expect(releaseToast(stack, 9, 5)).toBe(stack);
    const held = holdToast(stack, 1, 5);
    expect(holdToast(held, 1, 8)).toBe(held);
    expect(expireToasts(stack, toastDurationMs - 1)).toBe(stack);
  });

  test(`shows at most ${toastStackLimit} toasts and keeps the rest waiting without their time running`, () => {
    let stack: readonly Entry[] = [];
    for (let id = 1; id <= toastStackLimit + 2; id++)
      stack = push(stack, id, 0);
    expect(ids(visibleToasts(stack))).toEqual([1, 2, 3]);
    expect(nextExpiry(stack)).toBe(toastDurationMs);
    // 기다리는 토스트는 멈추거나 놓아도 바뀌지 않는다.
    expect(holdToast(stack, 4, 5)).toBe(stack);
    expect(releaseToast(stack, 4, 5)).toBe(stack);
  });

  test("a waiting toast appears at the bottom when a shown one closes and gets its full time from then", () => {
    let stack: readonly Entry[] = [];
    for (let id = 1; id <= toastStackLimit + 2; id++)
      stack = push(stack, id, 0);

    // 가운데 토스트를 닫으면 남은 둘은 위로 붙고, 기다리던 4가 맨 아래에 나타난다.
    stack = dismissToast(stack, 2, 3_000);
    expect(ids(visibleToasts(stack))).toEqual([1, 3, 4]);
    // 시간이 다 된 1·3이 닫히면 5가 나타나고, 4·5는 나타난 때부터 10초를 받는다.
    stack = expireToasts(stack, toastDurationMs);
    expect(ids(visibleToasts(stack))).toEqual([4, 5]);
    expect(nextExpiry(stack)).toBe(3_000 + toastDurationMs);
    stack = expireToasts(stack, 3_000 + toastDurationMs);
    expect(ids(visibleToasts(stack))).toEqual([5]);
    expect(nextExpiry(stack)).toBe(2 * toastDurationMs);
    expect(dismissToast(stack, 99, 0)).toBe(stack);
  });
});
