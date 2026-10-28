import { describe, expect, test } from "vitest";
import {
  dismissToast,
  expireToasts,
  holdToast,
  nextExpiry,
  pushToast,
  releaseToast,
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

  test(`shows at most ${toastStackLimit} toasts, dropping the oldest, newest last`, () => {
    let stack: readonly Entry[] = [];
    for (let id = 1; id <= toastStackLimit + 1; id++)
      stack = push(stack, id, id);
    expect(ids(stack)).toEqual([2, 3, 4]);
    expect(ids(dismissToast(stack, 3))).toEqual([2, 4]);
  });
});
