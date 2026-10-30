import { describe, expect, it } from "vitest";
import {
  addWorkerInputSchema,
  decideApprovalInputSchema,
  proposedWorkers,
  requestInitialApprovalInputSchema,
  resolveProposedChoice,
} from "./approval.ts";

const request = {
  plan: "# 계획",
  environment: "# 연구 환경",
  team: [{ role: "researcher", count: 2 }],
  template: "basic-research",
};

describe("requestInitialApprovalInputSchema", () => {
  it("takes proposed completion criteria only as an optional field", () => {
    expect(requestInitialApprovalInputSchema.parse(request)).toEqual(request);
    expect(
      requestInitialApprovalInputSchema.parse({
        ...request,
        completionCriteria: " WER 10% 이하 ",
      })
    ).toEqual({ ...request, completionCriteria: "WER 10% 이하" });
  });

  it("rejects blank proposed completion criteria", () => {
    expect(
      requestInitialApprovalInputSchema.safeParse({
        ...request,
        completionCriteria: "  ",
      }).success
    ).toBe(false);
  });
});

describe("proposed provider and model", () => {
  const parseTeam = (member: object) =>
    requestInitialApprovalInputSchema.safeParse({ ...request, team: [member] });

  it("takes a provider with or without a model on a team line and on add_worker", () => {
    expect(
      parseTeam({ role: "researcher", count: 1, provider: "fake" }).success
    ).toBe(true);
    expect(
      parseTeam({
        role: "researcher",
        count: 1,
        provider: "fake",
        model: "fake-large",
      }).success
    ).toBe(true);
    expect(
      addWorkerInputSchema.safeParse({
        role: "researcher",
        provider: "fake",
        model: null,
      }).success
    ).toBe(true);
  });

  it("refuses a model without a provider", () => {
    expect(
      parseTeam({ role: "researcher", count: 1, model: "fake-large" }).success
    ).toBe(false);
    expect(
      addWorkerInputSchema.safeParse({ role: "researcher", model: "m" }).success
    ).toBe(false);
  });

  it("uses the worker default only when the provider is left out", () => {
    const workerDefault = { provider: "fake", model: "fake-large" };
    expect(resolveProposedChoice({}, workerDefault)).toEqual(workerDefault);
    expect(
      resolveProposedChoice({ provider: "fake-2" }, workerDefault)
    ).toEqual({
      provider: "fake-2",
      model: null,
    });
  });
});

describe("decideApprovalInputSchema choices", () => {
  const choices = [{ provider: "fake", model: null }];

  it("takes choices only with an approval", () => {
    expect(
      decideApprovalInputSchema.safeParse({ decision: "approve", choices })
        .success
    ).toBe(true);
    expect(
      decideApprovalInputSchema.safeParse({
        decision: "reject",
        note: "아니요",
        choices,
      }).success
    ).toBe(false);
  });
});

describe("proposedWorkers", () => {
  it("spreads team lines into workers in hiring order", () => {
    const choice = { provider: "fake", model: null };
    const line = { files: [], label: "", count: 1 };
    const workers = proposedWorkers({
      kind: "initial_research",
      proposal: {
        goal: "",
        completionCriteria: "",
        plan: "",
        environment: "",
        template: {
          name: "t",
          label: "t",
          description: "",
          nodeKinds: [],
          linkKinds: [],
          source: "templates/t",
          sourceDigest: "",
        },
        team: [
          { ...line, role: "a", label: "A", count: 2, choice },
          { ...line, role: "b", label: "B" },
        ],
      },
    });
    expect(workers.map((w) => [w.role, w.ordinal, w.choice])).toEqual([
      ["a", 1, choice],
      ["a", 2, choice],
      ["b", 1, undefined],
    ]);
  });
});
