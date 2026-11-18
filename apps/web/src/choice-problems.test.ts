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
  const focus = vi.fn();
  const getElementById = vi.fn(() => ({ focus }));
  vi.stubGlobal("document", { getElementById });
  await refreshChoiceProblem(async () => ({ data: { providers } }), refused);
  expect(getElementById).toHaveBeenCalledWith("lead-provider");
  expect(focus).toHaveBeenCalledOnce();
});

test("a list that could not be fetched leaves focus alone", async () => {
  const getElementById = vi.fn();
  vi.stubGlobal("document", { getElementById });
  await refreshChoiceProblem(async () => ({ data: undefined }), refused);
  expect(getElementById).not.toHaveBeenCalled();
});

test("a failure while refreshing is reported and does not escape", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failure = new Error("offline");
  await expect(
    refreshChoiceProblem(() => Promise.reject(failure), refused)
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
});
