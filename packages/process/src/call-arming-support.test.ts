import { expect, it } from "vitest";
import { callArming } from "./call-arming-support.ts";

// 호출 문맥으로 고르는 결함의 무장(`@babojubot/process/call-arming`)의 계약. 무장은 감싼 호출과 그것이 일으킨 일에만 보이고, 끝은 그
// 시험의 정리가 정한다. 끝난 뒤에는 그 호출이 남긴 늦은 일도 무장을 찾지 못해 결함이 시험보다 오래 남지 않는다(#286).

/** 시험의 정리 대신 끝을 받아 두는 등록. */
function owner() {
  const ends: (() => void)[] = [];
  return { own: (end: () => void) => void ends.push(end), ends };
}

it("gives a call and the work it starts its arming, and nothing outside it", async () => {
  const calls = callArming<{ name: string }>();
  const { own, ends } = owner();
  const later = Promise.withResolvers<void>();
  const seen = calls.run(
    { name: "a" },
    async () => {
      const first = calls.current();
      await later.promise;
      return [first, calls.current()];
    },
    own
  );
  expect(calls.current()).toBeUndefined();
  later.resolve();
  expect(await seen).toEqual([{ name: "a" }, { name: "a" }]);
  expect(ends).toHaveLength(1);
});

it("finds no arming in a call's late work once its owner ended the arming", async () => {
  const calls = callArming<{ name: string }>();
  const { own, ends } = owner();
  const later = Promise.withResolvers<void>();
  const { late } = calls.run(
    { name: "a" },
    () => ({ late: later.promise.then(() => calls.current()) }),
    own
  );
  for (const end of ends) end();
  later.resolve();
  expect(await late).toBeUndefined();
});

it("keeps one call's arming apart from another's", async () => {
  const calls = callArming<{ name: string }>();
  const { own } = owner();
  const later = Promise.withResolvers<void>();
  const run = (name: string) =>
    calls.run(
      { name },
      async () => {
        await later.promise;
        return calls.current()?.name;
      },
      own
    );
  const [a, b] = [run("a"), run("b")];
  later.resolve();
  expect([await a, await b]).toEqual(["a", "b"]);
});
