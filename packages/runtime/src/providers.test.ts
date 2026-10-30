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
    let aborted = false;
    expect(
      await listProviderModels(
        {
          ...base!,
          listModels: (signal) =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () => {
                aborted = true;
                resolve(fetched);
              })
            ),
        },
        { timeoutMs: 10 }
      )
    ).toEqual(fixed);
    expect(aborted).toBe(true);
  });
});
