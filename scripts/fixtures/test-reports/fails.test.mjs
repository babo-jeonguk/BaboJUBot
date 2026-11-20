// scripts/check-test-reports.test.mjs가 돌리는 묶음. 실패한 시험이 실패 종료로 이어지는지 본다.
import assert from "node:assert/strict";
import { test } from "node:test";

test("breaks", () => {
  assert.equal(1 + 1, 3);
});
