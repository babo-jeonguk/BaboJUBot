// tests/hoisted-state-at-call 규칙 시험의 공용 대역 고정물(scripts/lint-rules.test.mjs). 시험 파일의 vi.mock factory가 이 파일의
// 내보낸 함수로 대역을 만들면, 규칙은 이 파일을 읽어 같은 판정을 한다.

/** 대역이 감싸는 진짜 모듈의 면. */
export type Real = { open: (file: string) => Promise<unknown> };

/** 시험이 바꿔 끼우는 결함 칸. */
export const faults: { fails: Error | undefined } = { fails: undefined };

/** 대역이 첫 await 전에 칸을 잡는다(통과). */
export function takingDouble<R extends Real>(real: R) {
  return {
    ...real,
    open: async (file: string) => {
      const { fails } = faults;
      const handle = await real.open(file);
      if (fails) throw fails;
      return handle;
    },
  };
}

/** 대역이 await 뒤에 칸을 다시 찾는다(걸림). */
export function lateDouble<R extends Real>(real: R) {
  return {
    ...real,
    open: async (file: string) => {
      const handle = await real.open(file);
      if (faults.fails) throw faults.fails;
      return handle;
    },
  };
}

/** 칸을 읽지 않는 도움(대역이 언제 불러도 통과). */
export function codeOf(error: unknown) {
  return (error as { code?: unknown } | undefined)?.code;
}

/** 칸을 읽는 도움(대역이 부르면 도움 안의 읽기라 걸림). */
export function currentFailure() {
  return faults.fails;
}

/** 칸을 읽는 함수를 담은 묶음(내보낸 값). 그 함수는 도움이라 어디서 불러도 그 안의 칸 읽기는 걸림. */
export const kit = { current: () => faults.fails };
