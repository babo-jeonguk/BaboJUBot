// 시험용 명령 찾기가 "없음"과 조회 실패를 구분하는지 실제 pgrep으로 본다(#255).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { killUnlessGone, withCleanup } from "@babojubot/runtime/test-cleanup";
import { matchingPids } from "./processes.mjs";

const marker = `babojubot-pgrep-${process.pid}-${Date.now()}`;

test("finds the process whose command line matches", async () => {
  await withCleanup(async (defer) => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", marker],
      { stdio: "ignore" }
    );
    const exited = once(child, "exit");
    defer(async () => {
      killUnlessGone(child.pid);
      await exited;
    });
    await once(child, "spawn");
    assert.deepEqual(matchingPids(`${marker}$`), [child.pid]);
  });
});

test("no matching process is an empty list", () => {
  assert.deepEqual(matchingPids(`${marker}-none$`), []);
});

test("a failing lookup is an error, not an empty list", () => {
  assert.throws(() => matchingPids("["), /pgrep failed for \[/);
});
