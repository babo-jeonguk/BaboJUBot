// scripts/check-test-reports.test.mjs가 돌리는 묶음. 시험이 모두 건너뛰어져 node:test는 0으로 끝난다.
import { test } from "node:test";

test("never runs", { skip: "this fixture skips every test" }, () => {});
