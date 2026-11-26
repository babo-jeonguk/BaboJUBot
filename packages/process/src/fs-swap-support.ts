// 이 파일은 `vi.mock("node:fs/promises")` 대역의 factory가 불러온다. 그래서 `node:fs/promises`를 형으로만 불러오고, 진짜 모듈은
// factory가 받은 것(`importOriginal()`)을 넘겨받는다. 값으로 불러오면 대역이 만들어지기 전에 자기 자신을 기다려 시험이 불러오는
// 단계에서 멈춘다(`packages/runtime/src/providers/connect-failure-support.ts` 머리 주석과 같은 까닭).
import type * as fsPromises from "node:fs/promises";

// 경로를 한 번 보고(열기·조회) 다시 보는 제품 코드가 그 사이 바뀐 파일을 앞서 본 것으로 믿지 않는지 시험한다. 시험이 무장한
// 경로에 대역 함수가 처음 닿으면, 그 호출이 끝난 직후 그 경로를 다른 파일(`replacement`)로 바꾼다.
//
// 시험 파일에서: `vi.mock("node:fs/promises", async (importOriginal) => { const real = await importOriginal(); const swapped =
// (await import("@babojubot/process/fs-swap")).swapAfter(real, ["open"]); return { ...real, ...swapped, default: { ...real, ...swapped } }; })`.
// 시험마다 `armSwap`으로 무장하고, 끝나면 `resetSwap()`으로 푼다(afterEach).
//
// 무장은 경로마다 객체 하나이고, 바꾸기를 시작했는지(`used`)를 그 객체가 기록한다(옮기기가 실패하면 그 호출이 그 오류로 거절된다). 대역은 지금 시험이 누구인지 보지 않고 불린 경로로
// 무장을 찾는다. 시험은 자기가 만든 임시 폴더의 경로로 무장하므로, 앞 시험의 늦은 호출(시험이 끝난 뒤에 시작한 것 포함)은 다음 시험의
// 무장을 찾지 못하고 진짜와 같이 돈다(#286 PR 3b-3b-2: 대역이 await 뒤에 "지금 시험"의 칸을 다시 찾던 것). 찾기는 불린 순간(첫 await
// 전)에 한다.

type Arming = { replacement: string; used: boolean };

/** 경로 → 그 경로의 무장. 없으면 대역은 그 경로에서 진짜와 같다. */
const armings = new Map<string, Arming>();

/**
 * `path`에 대역 함수가 처음 닿은 호출이 끝나면 `replacement`를 그 경로로 옮긴다(한 번만). 같은 경로를 다시 무장하면 던진다(앞 무장이
 * 남은 채 덮으면 어느 시험의 것인지 모르게 된다). 돌려준 무장의 `used`로 바꾸기를 시작했는지 시험이 본다(제품이 그 경로에 닿지
 * 않았으면 바꾸기 없이 통과하지 않게). 옮기기가 실패하면 그 호출이 그 오류로 거절된다.
 */
export function armSwap({
  path,
  replacement,
}: {
  path: string;
  replacement: string;
}): { readonly used: boolean } {
  if (armings.has(path)) throw new Error(`${path} is already armed to swap`);
  const arming = { replacement, used: false };
  armings.set(path, arming);
  return arming;
}

/** 무장을 모두 푼다(afterEach). 이미 불린 호출은 불린 순간 찾은 무장만 본다. */
export function resetSwap() {
  armings.clear();
}

type Swappable = "open" | "lstat" | "stat" | "readFile" | "access";

/**
 * `names`의 함수를 감싼 대역 묶음. 불린 순간 첫 인수의 경로로 무장을 찾는다. 진짜 호출이 이행한 뒤 그 무장을 아직 쓰지 않았으면 쓴
 * 것으로 적고(같은 동기 구간) 바꾸기를 기다린 뒤 진짜 결과를 돌려준다. 거절한 호출은 무장을 쓰지 않는다.
 */
export function swapAfter<N extends Swappable>(
  real: typeof fsPromises,
  names: readonly N[]
): Pick<typeof fsPromises, N> {
  const doubles: Partial<Record<Swappable, unknown>> = {};
  for (const name of names) {
    const call = real[name] as (...args: unknown[]) => Promise<unknown>;
    doubles[name] = async (...args: unknown[]) => {
      const path = String(args[0]);
      const arming = armings.get(path);
      const result = await call(...args);
      if (arming && !arming.used) {
        arming.used = true;
        await real.rename(arming.replacement, path);
      }
      return result;
    };
  }
  return doubles as Pick<typeof fsPromises, N>;
}
