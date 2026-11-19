import { describe, expect, it } from "vitest";
import {
  attemptAll,
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
  settled,
} from "./failure.ts";

/** Node 파일 오류처럼 `code`를 가진 오류. */
const coded = (code: string) =>
  Object.assign(new Error(`${code}: failed`), { code });
const missing = (error: unknown) => hasErrorCode("ENOENT", "ESRCH")(error);

describe("hasErrorCode", () => {
  it("matches only errors whose code is one of the given codes", () => {
    expect(missing(coded("ENOENT"))).toBe(true);
    expect(missing(coded("ESRCH"))).toBe(true);
    expect(missing(coded("EACCES"))).toBe(false);
    expect(missing(new Error("ENOENT"))).toBe(false);
    expect(missing({ code: 2 })).toBe(false);
    expect(missing("ENOENT")).toBe(false);
    expect(missing(undefined)).toBe(false);
  });
});

describe("orIfMissing", () => {
  it("returns the value read when nothing fails", async () => {
    expect(orIfMissing(() => "text", missing, "")).toBe("text");
    await expect(
      orIfMissing(() => Promise.resolve("text"), missing, "")
    ).resolves.toBe("text");
  });

  it("returns the fallback only for the missing error", async () => {
    expect(
      orIfMissing(
        () => {
          throw coded("ENOENT");
        },
        missing,
        "none"
      )
    ).toBe("none");
    await expect(
      orIfMissing(() => Promise.reject(coded("ESRCH")), missing, "none")
    ).resolves.toBe("none");
  });

  it("throws every other error unchanged", async () => {
    const denied = coded("EACCES");
    expect(() =>
      orIfMissing(
        () => {
          throw denied;
        },
        missing,
        "none"
      )
    ).toThrow(denied);
    await expect(
      orIfMissing(() => Promise.reject(denied), missing, "none")
    ).rejects.toBe(denied);
    // 비동기 함수가 기다리기 전에 던져도 같은 판정을 거친다.
    await expect(
      orIfMissing(
        async () => {
          throw denied;
        },
        missing,
        "none"
      )
    ).rejects.toBe(denied);
  });
});

describe("continueAfterFailure", () => {
  it("returns the result and reports nothing when the work succeeds", async () => {
    const reported: unknown[] = [];
    expect(
      continueAfterFailure(
        () => 3,
        (e) => reported.push(e)
      )
    ).toBe(3);
    await expect(
      continueAfterFailure(
        () => Promise.resolve(4),
        (e) => reported.push(e)
      )
    ).resolves.toBe(4);
    expect(reported).toEqual([]);
  });

  it("reports the failure and goes on without a value", async () => {
    const reported: unknown[] = [];
    const first = coded("EBUSY");
    const second = coded("EPERM");
    expect(
      continueAfterFailure(
        () => {
          throw first;
        },
        (e) => reported.push(e)
      )
    ).toBeUndefined();
    await expect(
      continueAfterFailure(
        () => Promise.reject(second),
        (e) => reported.push(e)
      )
    ).resolves.toBeUndefined();
    expect(reported).toEqual([first, second]);
  });

  it("lets a failing report surface instead of hiding it", async () => {
    const broken = new Error("report failed");
    expect(() =>
      continueAfterFailure(
        () => {
          throw coded("EBUSY");
        },
        () => {
          throw broken;
        }
      )
    ).toThrow(broken);
    await expect(
      continueAfterFailure(
        () => Promise.reject(coded("EBUSY")),
        () => {
          throw broken;
        }
      )
    ).rejects.toBe(broken);
  });
});

describe("orIfUnreadable", () => {
  it("returns what was read, or the fixed negative result when reading fails", async () => {
    expect(
      orIfUnreadable(() => JSON.parse("[1]") as unknown, undefined)
    ).toEqual([1]);
    expect(orIfUnreadable(() => JSON.parse("{") as unknown, undefined)).toBe(
      undefined
    );
    expect(orIfUnreadable(() => new URL("not a url").host, false)).toBe(false);
    await expect(
      orIfUnreadable(() => Promise.resolve(true), false)
    ).resolves.toBe(true);
    await expect(
      orIfUnreadable(() => Promise.reject(new Error("closed")), false)
    ).resolves.toBe(false);
  });
});

describe("settled", () => {
  it("resolves once the promise is fulfilled or rejected, without its value", async () => {
    await expect(settled(Promise.resolve(5))).resolves.toBeUndefined();
    await expect(
      settled(Promise.reject(new Error("failed")))
    ).resolves.toBeUndefined();
  });

  it("waits for the promise before resolving", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => (finish = resolve));
    let done = false;
    const waiting = settled(work).then(() => (done = true));
    // 이미 끝난 작업을 기다린 settled가 풀린 것을 신호로 쓴다. 작업을 보지 않고 풀리는 구현이라면 먼저 만든 쪽이 이때 이미 풀렸다.
    await settled(Promise.resolve());
    expect(done).toBe(false);
    finish();
    await waiting;
    expect(done).toBe(true);
  });

  it("keeps the failure for whoever holds the original promise", async () => {
    const failure = new Error("failed");
    const work = Promise.reject(failure);
    // 순서 고리는 앞선 실패를 넘기지 않고, 원래 promise를 가진 쪽은 그 실패를 그대로 받는다.
    const next = settled(work).then(() => "next");
    await expect(next).resolves.toBe("next");
    await expect(work).rejects.toBe(failure);
  });
});

describe("failureCode", () => {
  it("names a failure by its code, then by its kind", () => {
    expect(failureCode(coded("EACCES"))).toBe("EACCES");
    expect(failureCode(new TypeError("secret text"))).toBe("TypeError");
    expect(failureCode(Object.assign(new Error("x"), { code: 7 }))).toBe(
      "Error"
    );
    expect(failureCode("plain")).toBe("unknown");
    expect(failureCode(undefined)).toBe("unknown");
  });
});

describe("attemptAll", () => {
  // 서로 독립인 정리(끄기·닫기·지우기)를 차례로 기다리면 앞 정리가 실패한 곳에서 뒤 정리를 건너뛴다(#263 외부 리뷰 S1·S2).
  it("does every step though an earlier one fails, and throws the failures together", async () => {
    const done: string[] = [];
    const first = new Error("first failed");
    const third = new Error("third failed");
    const attempt = attemptAll(
      [
        async () => {
          done.push("first");
          throw first;
        },
        () => {
          done.push("second");
        },
        async () => {
          done.push("third");
          throw third;
        },
      ],
      "cleanup failed"
    );
    await expect(attempt).rejects.toMatchObject({
      name: "AggregateError",
      message: "cleanup failed: first failed — 그리고 third failed",
      errors: [first, third],
    });
    expect(done).toEqual(["first", "second", "third"]);
  });

  it("does the steps in order, one after another", async () => {
    const done: string[] = [];
    let releaseFirst!: () => void;
    const attempt = attemptAll(
      [
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = () => {
              done.push("first");
              resolve();
            };
          }),
        () => {
          done.push("second");
        },
      ],
      "cleanup failed"
    );
    await settled(Promise.resolve());
    expect(done).toEqual([]);
    releaseFirst();
    await attempt;
    expect(done).toEqual(["first", "second"]);
  });

  it("throws a single failure as it is", async () => {
    const only = new Error("only");
    await expect(
      attemptAll([() => Promise.reject(only), () => undefined], "x")
    ).rejects.toBe(only);
  });
});
