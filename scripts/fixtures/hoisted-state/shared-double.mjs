// tests/hoisted-state-at-call 규칙 시험의 공용 대역 고정물(scripts/lint-rules.test.mjs). 시험 파일의 vi.mock factory가 이 파일의
// 내보낸 함수로 대역을 만들면, 규칙은 이 파일을 읽어 같은 판정을 한다.

/** 시험이 바꿔 끼우는 결함 칸. */
export const faults = { fails: undefined };

/** 대역이 첫 await 전에 칸을 잡는다(통과). */
export function takingDouble(real) {
  return {
    ...real,
    open: async (file) => {
      const { fails } = faults;
      const handle = await real.open(file);
      if (fails) throw fails;
      return handle;
    },
  };
}

/** 대역이 await 뒤에 칸을 다시 찾는다(걸림). */
export function lateDouble(real) {
  return {
    ...real,
    open: async (file) => {
      const handle = await real.open(file);
      if (faults.fails) throw faults.fails;
      return handle;
    },
  };
}
