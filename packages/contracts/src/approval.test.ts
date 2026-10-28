import { describe, expect, it } from "vitest";
import { requestInitialApprovalInputSchema } from "./approval.ts";

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
