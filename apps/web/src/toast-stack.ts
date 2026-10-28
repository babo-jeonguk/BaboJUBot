// 토스트 더미의 규칙. 토스트마다 따로 수명이 있어 새 토스트가 와도 앞 토스트의 남은 시간은 그대로다.
// 화면 없이 시각만 받아 계산하므로 단위 검사로 확인하고, toast.tsx가 가장 먼저 끝나는 시각에 타이머 하나를 건다.

/** 되돌리기 버튼을 누를 수 있게 충분히 오래 보인다. */
export const toastDurationMs = 10_000;
/** 한 번에 보이는 토스트 수. 넘치면 가장 오래된 토스트를 닫는다(폐기 취소는 노드 패널에도 있다). */
export const toastStackLimit = 3;

export type ToastEntry<T> = T & {
  id: number;
  /** 멈춘 뒤 남은 시간. 흐르는 중이면 `runningSince`부터 이만큼 남았었다. */
  remainingMs: number;
  /** 흐르기 시작한 시각. 마우스를 올리거나 포커스가 안에 있어 멈췄으면 없다. */
  runningSince: number | null;
};

/** 새 토스트를 맨 뒤(화면 맨 아래)에 붙이고, 한도를 넘으면 가장 오래된 토스트부터 뺀다. */
export function pushToast<T>(
  stack: readonly ToastEntry<T>[],
  toast: T & { id: number },
  now: number
): readonly ToastEntry<T>[] {
  return [
    ...stack,
    { ...toast, remainingMs: toastDurationMs, runningSince: now },
  ].slice(-toastStackLimit);
}

/** 그 토스트의 시간만 멈춘다. 이미 멈췄으면 같은 더미를 돌려준다. */
export function holdToast<T>(
  stack: readonly ToastEntry<T>[],
  id: number,
  now: number
): readonly ToastEntry<T>[] {
  return update(stack, id, (t) =>
    t.runningSince === null
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
    t.runningSince === null ? { ...t, runningSince: now } : t
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

export function dismissToast<T>(
  stack: readonly ToastEntry<T>[],
  id: number
): readonly ToastEntry<T>[] {
  return stack.filter((t) => t.id !== id);
}

const endsAt = (t: ToastEntry<unknown>) =>
  t.runningSince === null ? null : t.runningSince + t.remainingMs;

/** 흐르는 토스트 가운데 가장 먼저 끝나는 시각. 모두 멈췄거나 없으면 없다. */
export function nextExpiry(stack: readonly ToastEntry<unknown>[]) {
  const ends = stack.flatMap((t) => endsAt(t) ?? []);
  return ends.length ? Math.min(...ends) : null;
}

/** `now`까지 시간이 다 된 토스트를 뺀다. 다 된 토스트가 없으면 같은 더미를 돌려준다. */
export function expireToasts<T>(
  stack: readonly ToastEntry<T>[],
  now: number
): readonly ToastEntry<T>[] {
  const left = stack.filter((t) => {
    const end = endsAt(t);
    return end === null || end > now;
  });
  return left.length === stack.length ? stack : left;
}
