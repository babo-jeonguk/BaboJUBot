import { afterEach, describe, expect, it, vi } from "vitest";
import { RefusalLog } from "../src/refusal-log.ts";

// 격리 실행의 외부 연결 거부를 실행 활동에 남기는 기록. 같은 거부는 실행 시도마다 한 번, 많아도 정해진 수까지 남긴다.
// 실행 시도가 끝나면 그 실행 시도의 상태를 버려 서버 메모리가 실행 이력에 비례해 늘지 않는다.
afterEach(() => {
  vi.restoreAllMocks();
});

function log({
  running = () => true,
  write = async () => true,
  limit,
}: {
  running?: (runId: string) => boolean;
  write?: (runId: string, text: string) => Promise<boolean>;
  limit?: number;
} = {}) {
  const writes = vi.fn(write);
  return {
    writes,
    log: new RefusalLog({
      write: writes,
      running,
      ...(limit === undefined ? {} : { limit }),
    }),
  };
}

describe("refusals of a run", () => {
  it("writes the same refusal once, even when it arrives again while the first is being saved", async () => {
    const { log: refusals, writes } = log();
    await Promise.all([
      refusals.record("run", "example.invalid:443 not_allowed", "거부"),
      refusals.record("run", "example.invalid:443 not_allowed", "거부"),
    ]);
    await refusals.record("run", "example.invalid:443 not_allowed", "거부");
    await refusals.record("run", "other.invalid:443 not_allowed", "다른 거부");
    expect(writes.mock.calls).toEqual([
      ["run", "거부"],
      ["run", "다른 거부"],
    ]);
  });

  it("writes at most the limit of different refusals", async () => {
    const { log: refusals, writes } = log({ limit: 3 });
    for (const host of ["a", "b", "c", "d"])
      await refusals.record("run", `${host}:443 not_allowed`, host);
    expect(writes).toHaveBeenCalledTimes(3);
  });

  it("forgets a run once it finishes", async () => {
    const { log: refusals } = log();
    await refusals.record("run", "example.invalid:443 not_allowed", "거부");
    expect(refusals.trackedRuns).toBe(1);
    refusals.finished("run");
    expect(refusals.trackedRuns).toBe(0);
  });

  it("does not keep anything for a refusal that arrives after the run finished", async () => {
    const { log: refusals, writes } = log({ running: () => false });
    await refusals.record("run", "example.invalid:443 not_allowed", "거부");
    expect(writes).not.toHaveBeenCalled();
    expect(refusals.trackedRuns).toBe(0);
  });

  it("forgets a run whose refusal could not be kept because the run had already ended", async () => {
    const { log: refusals } = log({ write: async () => false });
    await refusals.record("run", "example.invalid:443 not_allowed", "거부");
    expect(refusals.trackedRuns).toBe(0);
  });

  it("writes a refusal again after saving it failed, and reports the failure", async () => {
    const failure = Object.assign(
      new Error("injected: saving the activity failed"),
      { code: "INJECTED_SAVE_FAILED" }
    );
    let attempts = 0;
    const { log: refusals, writes } = log({
      write: async () => {
        if (attempts++ === 0) throw failure;
        return true;
      },
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errored = vi.spyOn(console, "error").mockImplementation(() => {});

    await refusals.record("run", "example.invalid:443 not_allowed", "거부");
    await refusals.record("run", "example.invalid:443 not_allowed", "거부");

    expect(writes).toHaveBeenCalledTimes(2);
    // 진단에는 오류 문구 대신 원인 코드를 남긴다(CODING_STANDARDS.md#제품-코드).
    expect(warned.mock.calls).toEqual([
      ["[isolation] could not record a relay refusal (INJECTED_SAVE_FAILED)"],
    ]);
    expect(errored.mock.calls).toEqual([]);
  });
});
