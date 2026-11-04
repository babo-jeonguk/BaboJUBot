import { expect, it } from "vitest";

it("fails on purpose to prove ci / test goes red", () => {
  expect(1).toBe(2);
});
