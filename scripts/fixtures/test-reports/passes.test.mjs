// scripts/check-test-reports.test.mjs가 run-node-tests.mjs로 돌리는 묶음. 통과·묶음 안 통과·건너뜀·todo를 하나씩 둔다.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

test("adds", () => {
  assert.equal(1 + 1, 2);
});
describe("group", () => {
  test("nested", () => {
    assert.ok(true);
  });
});
test("skipped on purpose", { skip: "this fixture shows a skip" }, () => {});
test("later", { todo: "this fixture shows a todo" }, () => {});
