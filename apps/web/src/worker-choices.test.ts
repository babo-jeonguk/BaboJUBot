import type { ProposedWorker } from "@babojubot/contracts";
import { expect, test } from "vitest";
import { changedChoiceFields, decisionChoices } from "./worker-choices.ts";

const lead = { provider: "fake", model: null };
const other = { provider: "fake-2", model: "fake-2-mini" };
const worker = (choice: ProposedWorker["choice"], ordinal = 1) => ({
  role: "researcher",
  label: "연구원",
  ordinal,
  choice,
});

test("sends nothing when every worker keeps the Lead's proposal", () => {
  expect(decisionChoices([worker(lead)], undefined, undefined)).toEqual({
    shown: [lead],
    ready: true,
    send: undefined,
  });
});

test("sends exactly what the table shows once a worker is changed", () => {
  const workers = [worker(lead), worker(lead, 2)];
  expect(decisionChoices(workers, [undefined, other], undefined).send).toEqual([
    lead,
    other,
  ]);
});

test("cannot approve a request from before Lead proposals until the worker default it shows is known", () => {
  const legacy = [worker(undefined)];
  expect(decisionChoices(legacy, undefined, undefined)).toEqual({
    shown: [undefined],
    ready: false,
    send: undefined,
  });
  // 기본값을 읽으면 그 값을 보이고, 승인하면 보인 값 그대로 보낸다.
  expect(decisionChoices(legacy, undefined, other)).toEqual({
    shown: [other],
    ready: true,
    send: [other],
  });
});

test("marks only the field whose own value differs", () => {
  expect(
    changedChoiceFields(lead, { provider: "fake-2", model: null })
  ).toEqual({ provider: true, model: false });
  expect(changedChoiceFields(lead, { provider: "fake", model: "m" })).toEqual({
    provider: false,
    model: true,
  });
});
