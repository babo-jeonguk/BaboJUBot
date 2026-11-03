import { describe, expect, it } from "vitest";
import { createFakeProviders, listProviderModels } from "./providers.ts";

describe("fake provider connections", () => {
  it("names each connection apart and gives each its own fixed models", () => {
    const [first, second] = createFakeProviders(2);
    expect([first!.id, first!.label]).toEqual(["fake", "가짜 프로바이더"]);
    expect([second!.id, second!.label]).toEqual([
      "fake-2",
      "가짜 프로바이더 2",
    ]);
    expect(first!.models.map((m) => m.id)).toEqual(["fake-mini", "fake-max"]);
    expect(second!.models.map((m) => m.id)).toEqual([
      "fake-2-mini",
      "fake-2-max",
    ]);
  });
});

describe("listProviderModels", () => {
  const [base] = createFakeProviders(1);
  const fixed = base!.models;

  it("uses the fetched list, and falls back to the fixed list when fetching fails, times out or comes back empty", async () => {
    const fetched = [{ id: "live-1", label: "받아 온 모델" }];
    expect(
      await listProviderModels({ ...base!, listModels: async () => fetched })
    ).toEqual(fetched);
    expect(await listProviderModels(base!)).toEqual(fixed);
    expect(
      await listProviderModels({
        ...base!,
        listModels: async () => {
          throw new Error("offline");
        },
      })
    ).toEqual(fixed);
    expect(
      await listProviderModels({ ...base!, listModels: async () => [] })
    ).toEqual(fixed);
  });

  it("answers from the fixed list when the wait runs out, then uses the list that arrives late", async () => {
    const fetched = [{ id: "live-1", label: "받아 온 모델" }];
    let calls = 0;
    const connection = {
      ...base!,
      listModels: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return fetched;
      },
    };
    expect(await listProviderModels(connection, { timeoutMs: 5 })).toEqual(
      fixed
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await listProviderModels(connection, { timeoutMs: 5 })).toEqual(
      fetched
    );
    expect(calls).toBe(1);
  });

  it("shares one fetch between callers and does not fetch again while the list is fresh", async () => {
    const fetched = [{ id: "live-1", label: "받아 온 모델" }];
    let calls = 0;
    const connection = {
      ...base!,
      listModels: async () => {
        calls++;
        return fetched;
      },
    };
    await Promise.all([
      listProviderModels(connection),
      listProviderModels(connection),
    ]);
    await listProviderModels(connection);
    expect(calls).toBe(1);
  });

  it("answers at once from an old list and refreshes it behind the caller", async () => {
    let version = 1;
    const connection = {
      ...base!,
      listModels: async () => [{ id: `live-${version}`, label: "모델" }],
    };
    const options = { maxAgeMs: 0 };
    expect(await listProviderModels(connection, options)).toEqual([
      { id: "live-1", label: "모델" },
    ]);
    version = 2;
    expect(await listProviderModels(connection, options)).toEqual([
      { id: "live-1", label: "모델" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await listProviderModels(connection, options)).toEqual([
      { id: "live-2", label: "모델" },
    ]);
  });

  it("stops a fetch that outlives its limit", async () => {
    let aborted = false;
    const connection = {
      ...base!,
      listModels: (signal: AbortSignal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("stopped"));
          })
        ),
    };
    expect(
      await listProviderModels(connection, { timeoutMs: 5, fetchLimitMs: 20 })
    ).toEqual(fixed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborted).toBe(true);
  });
});
