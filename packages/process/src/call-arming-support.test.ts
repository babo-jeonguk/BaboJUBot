import { expect, it } from "vitest";
import { callArming } from "./call-arming-support.ts";

// 호출 문맥으로 고르는 결함의 무장(`@babojubot/process/call-arming`)의 계약. 무장은 감싼 호출과 그것이 일으킨 일에만 보이고, 끝은 그
// 시험의 정리가 정한다. 끝난 뒤에는 그 호출이 남긴 늦은 일도 무장을 찾지 못해 결함이 시험보다 오래 남지 않는다(#286). 무장의 문맥에서
// 얻는 자원(획득)은 시작 순간 무장에 등록되고, 끝난 무장의 문맥에서 시작하는 획득은 거절되며, 끝은 진행 중인 획득이 끝나기를 기다린다.

/** 시험의 정리 대신 끝을 받아 두는 등록. */
function owner() {
  const ends: (() => Promise<void>)[] = [];
  return {
    own: (end: () => Promise<void>) => void ends.push(end),
    ends,
    end: () => Promise.all(ends.map((end) => end())),
  };
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
  const { own, end } = owner();
  const later = Promise.withResolvers<void>();
  const { late } = calls.run(
    { name: "a" },
    () => ({ late: later.promise.then(() => calls.current()) }),
    own
  );
  await end();
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

it("refuses an acquisition that starts in an ended arming's context", async () => {
  const calls = callArming<{ made: string[] }>();
  const { own, end } = owner();
  const later = Promise.withResolvers<void>();
  const arming = { made: [] as string[] };
  const { late } = calls.run(
    arming,
    () => ({
      late: later.promise.then(() =>
        calls.acquire(async (armed) => {
          armed.made.push("late");
          return "late";
        })
      ),
    }),
    own
  );
  await end();
  later.resolve();
  await expect(late).rejects.toThrow("ended");
  expect(arming.made).toEqual([]);
});

it("makes no acquisition outside an arming's context", () => {
  const calls = callArming<{ made: string[] }>();
  expect(calls.acquire(async () => "outside")).toBeUndefined();
});

it("ends only after the acquisitions it registered at their start have ended", async () => {
  const calls = callArming<{ made: string[] }>();
  const { own, end } = owner();
  const gate = Promise.withResolvers<void>();
  const order: string[] = [];
  const arming = { made: [] as string[] };
  const acquiring = calls.run(
    arming,
    () =>
      calls.acquire(async (armed) => {
        await gate.promise;
        armed.made.push("folder");
        return "folder";
      }),
    own
  );
  // 획득의 끝을 보는 쪽을 먼저 걸고, 무장을 끝낸 뒤 획득을 푼다. 끝이 획득을 기다리면 획득이 먼저 끝난다.
  const acquired = acquiring?.then(() => order.push("acquired"));
  const ending = end().then(() => order.push("ended"));
  gate.resolve();
  await ending;
  await acquired;
  expect(order).toEqual(["acquired", "ended"]);
  expect(arming.made).toEqual(["folder"]);
});
