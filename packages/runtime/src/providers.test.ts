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

  it("shows the ID when a program gives a model no usable name, so one row cannot break the whole list", async () => {
    const models = await listProviderModels({
      ...base!,
      listModels: async () => [
        { id: "empty", label: "" },
        { id: "blank", label: "   " },
        { id: "named", label: "이름 있음" },
      ],
    });
    expect(models).toEqual([
      { id: "empty", label: "empty" },
      { id: "blank", label: "blank" },
      { id: "named", label: "이름 있음" },
    ]);
  });

  it("answers from the fixed list when the wait runs out, then uses the list that arrives late", async () => {
    const fetched = [{ id: "live-1", label: "받아 온 모델" }];
    let calls = 0;
    // The list arrives only when the test lets it, so the wait surely runs out first however slow the machine is (#215).
    let arrive!: () => void;
    const late = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const connection = {
      ...base!,
      listModels: async () => {
        calls++;
        await late;
        return fetched;
      },
    };
    expect(await listProviderModels(connection, { timeoutMs: 5 })).toEqual(
      fixed
    );
    arrive();
    // The fetch the first caller gave up on goes on: a caller that waits gets its list, and a later one gets it at once.
    expect(await listProviderModels(connection, { timeoutMs: 15_000 })).toEqual(
      fetched
    );
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

  it("waits for a new list when the caller asks for a fresh one", async () => {
    let version = 1;
    const connection = {
      ...base!,
      listModels: async () => [{ id: `live-${version}`, label: "모델" }],
    };
    await listProviderModels(connection);
    version = 2;
    expect(await listProviderModels(connection)).toEqual([
      { id: "live-1", label: "모델" },
    ]);
    expect(await listProviderModels(connection, { fresh: true })).toEqual([
      { id: "live-2", label: "모델" },
    ]);
    expect(await listProviderModels(connection)).toEqual([
      { id: "live-2", label: "모델" },
    ]);
  });

  it("stops a fetch that outlives its limit", async () => {
    let stopped!: () => void;
    const aborted = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const connection = {
      ...base!,
      listModels: (signal: AbortSignal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => {
            stopped();
            reject(new Error("stopped"));
          })
        ),
    };
    expect(
      await listProviderModels(connection, { timeoutMs: 5, fetchLimitMs: 20 })
    ).toEqual(fixed);
    // The fetch is stopped by its limit; a fetch left running would never settle this and the test would run out (#215).
    await aborted;
  });
});
