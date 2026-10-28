// 토스트 더미의 규칙. 토스트마다 따로 수명이 있어 새 토스트가 와도 앞 토스트의 남은 시간은 그대로다.
// 한 번에 보이는 수를 넘친 토스트는 버리지 않고 기다렸다가, 앞 토스트가 닫히면 차례로 나타나 그때부터 시간이 흐른다.
// 화면 없이 시각만 받아 계산하므로 단위 검사로 확인하고, toast.tsx가 가장 먼저 끝나는 시각에 타이머 하나를 건다.

/** 되돌리기 버튼을 누를 수 있게 충분히 오래 보인다. */
export const toastDurationMs = 10_000;
/** 한 번에 보이는 토스트 수. 넘친 토스트는 차례를 기다린다. */
export const toastStackLimit = 3;

export type ToastEntry<T> = T & {
  id: number;
  /** 멈춘 뒤 남은 시간. 흐르는 중이면 `runningSince`부터 이만큼 남았었다. */
  remainingMs: number;
  /** 흐르기 시작한 시각. 마우스를 올리거나 포커스가 안에 있어 멈췄거나, 아직 차례를 기다리면 없다. */
  runningSince: number | null;
  /** 화면에 나타났다. 기다리는 토스트는 보이지 않고 시간도 흐르지 않는다. */
  shown: boolean;
};

/** 새 토스트를 맨 뒤(화면 맨 아래)에 붙인다. 보이는 자리가 다 찼으면 차례를 기다린다. */
export function pushToast<T>(
  stack: readonly ToastEntry<T>[],
  toast: T & { id: number },
  now: number
): readonly ToastEntry<T>[] {
  const shown = stack.length < toastStackLimit;
  return [
    ...stack,
    {
      ...toast,
      remainingMs: toastDurationMs,
      runningSince: shown ? now : null,
      shown,
    },
  ];
}

/** 화면에 보이는 토스트. 오래된 것이 위, 새것이 아래다. */
export const visibleToasts = <T>(stack: readonly ToastEntry<T>[]) =>
  stack.filter((t) => t.shown);

/** 빈 자리만큼 기다리던 토스트를 차례로 나타내고 그때부터 시간을 흘린다. */
function promote<T>(
  stack: readonly ToastEntry<T>[],
  now: number
): readonly ToastEntry<T>[] {
  if (stack.slice(0, toastStackLimit).every((t) => t.shown)) return stack;
  return stack.map((t, index) =>
    index < toastStackLimit && !t.shown
      ? { ...t, shown: true, runningSince: now }
      : t
  );
}

/** 그 토스트의 시간만 멈춘다. 이미 멈췄으면 같은 더미를 돌려준다. */
export function holdToast<T>(
  stack: readonly ToastEntry<T>[],
  id: number,
  now: number
): readonly ToastEntry<T>[] {
  return update(stack, id, (t) =>
    !t.shown || t.runningSince === null
      ? t
      : {
          ...t,
          remainingMs: t.remainingMs - (now - t.runningSince),
          runningSince: null,
        }
  );
}

/** 멈춘 토스트의 남은 시간을 다시 흘린다. 흐르는 중이면 같은 더미를 돌려준다. */
export function releaseToast<T>(
  stack: readonly ToastEntry<T>[],
  id: number,
  now: number
): readonly ToastEntry<T>[] {
  return update(stack, id, (t) =>
    t.shown && t.runningSince === null ? { ...t, runningSince: now } : t
  );
}

/** 바뀐 토스트가 없으면 같은 더미라 화면이 다시 그리지 않는다. */
function update<T>(
  stack: readonly ToastEntry<T>[],
  id: number,
  change: (toast: ToastEntry<T>) => ToastEntry<T>
): readonly ToastEntry<T>[] {
  const index = stack.findIndex((t) => t.id === id);
  if (index < 0) return stack;
  const changed = change(stack[index]!);
  return changed === stack[index] ? stack : stack.with(index, changed);
}

/** 그 토스트를 닫고, 빈 자리에 기다리던 토스트를 나타낸다. */
export function dismissToast<T>(
  stack: readonly ToastEntry<T>[],
  id: number,
  now: number
): readonly ToastEntry<T>[] {
  const left = stack.filter((t) => t.id !== id);
  return left.length === stack.length ? stack : promote(left, now);
}

const endsAt = (t: ToastEntry<unknown>) =>
  t.runningSince === null ? null : t.runningSince + t.remainingMs;

/** 흐르는 토스트 가운데 가장 먼저 끝나는 시각. 모두 멈췄거나 없으면 없다. */
export function nextExpiry(stack: readonly ToastEntry<unknown>[]) {
  const ends = stack.flatMap((t) => endsAt(t) ?? []);
  return ends.length ? Math.min(...ends) : null;
}

/** `now`까지 시간이 다 된 토스트를 빼고 빈 자리에 기다리던 토스트를 나타낸다. 다 된 토스트가 없으면 같은 더미를 돌려준다. */
export function expireToasts<T>(
  stack: readonly ToastEntry<T>[],
  now: number
): readonly ToastEntry<T>[] {
  const left = stack.filter((t) => {
    const end = endsAt(t);
    return end === null || end > now;
  });
  return left.length === stack.length ? stack : promote(left, now);
}
