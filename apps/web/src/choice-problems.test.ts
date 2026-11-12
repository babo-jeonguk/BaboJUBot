import type { ProviderSummary } from "@babojubot/contracts";
import { expect, test } from "vitest";
import { choiceProblem, firstChoiceProblem } from "./choice-problems.ts";

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
