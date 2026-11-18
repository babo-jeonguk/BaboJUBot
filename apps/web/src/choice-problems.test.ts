import type { ProviderSummary } from "@babojubot/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
  choiceProblem,
  firstChoiceProblem,
  refreshChoiceProblem,
} from "./choice-problems.ts";

const connection = (id: string, models: string[]) =>
  ({
    id,
    label: id,
    models: models.map((m) => ({ id: m, label: m })),
  }) as unknown as ProviderSummary;
const providers = [connection("fake", ["fake-mini"]), connection("fake-2", [])];

test("a choice of a listed connection and its listed or default model has no problem", () => {
  expect(choiceProblem(providers, { provider: "fake", model: null })).toBe(
    undefined
  );
  expect(
    choiceProblem(providers, { provider: "fake", model: "fake-mini" })
  ).toBe(undefined);
});

test("a connection the server does not have is the provider field's problem", () => {
  expect(choiceProblem(providers, { provider: "gone", model: "x" })).toBe(
    "unknown_provider"
  );
});

test("a model missing from the chosen connection's list is the model field's problem", () => {
  expect(choiceProblem(providers, { provider: "fake", model: "old" })).toBe(
    "unknown_model"
  );
});

test("an empty model list does not make a model wrong, as on the server", () => {
  expect(choiceProblem(providers, { provider: "fake-2", model: "old" })).toBe(
    undefined
  );
});

test("the first problem in field order names its field, or none when every choice is valid", () => {
  expect(
    firstChoiceProblem(providers, [
      { idPrefix: "lead", choice: { provider: "fake", model: null } },
      { idPrefix: "worker", choice: { provider: "fake", model: "old" } },
      { idPrefix: "third", choice: { provider: "gone", model: null } },
    ])
  ).toEqual({ fieldId: "worker-model", problem: "unknown_model" });
  expect(
    firstChoiceProblem(providers, [
      { idPrefix: "lead", choice: { provider: "fake", model: null } },
    ])
  ).toBe(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const refused = [
  { idPrefix: "lead", choice: { provider: "gone", model: null } },
];

test("after a refusal the fresh list moves focus to the field with the problem", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const focus = vi.fn();
  const getElementById = vi.fn(() => ({ focus }));
  vi.stubGlobal("document", { getElementById });
  await refreshChoiceProblem(
    async () => ({ data: { providers }, error: null }),
    refused
  );
  expect(getElementById).toHaveBeenCalledWith("lead-provider");
  expect(focus).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
});

// 조회 실패는 거부가 아니라 결과의 `error`로 온다.
test("a list that could not be fetched is reported and leaves focus alone", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const getElementById = vi.fn();
  vi.stubGlobal("document", { getElementById });
  const failure = new Error("offline");
  await refreshChoiceProblem(
    async () => ({ data: undefined, error: failure }),
    refused
  );
  expect(getElementById).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
});

test("a failed refresh is reported and the list already held is still used", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const focus = vi.fn();
  vi.stubGlobal("document", { getElementById: () => ({ focus }) });
  const failure = new Error("offline");
  await refreshChoiceProblem(
    async () => ({ data: { providers }, error: failure }),
    refused
  );
  expect(focus).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
});
