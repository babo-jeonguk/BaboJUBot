// 시험용 명령 찾기가 "없음"과 조회 실패를 구분하는지 본다(#255). 판정은 어느 OS에서나 보고, 실제 pgrep은 POSIX에서만 돌린다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { killUnlessGone, withCleanup } from "@babojubot/runtime/test-cleanup";
import { matchingPids, pidsFromPgrep } from "./processes.mjs";

const pattern = "busy\\.mjs [0-9]+ marker$";
const finished = (fields) => ({
  error: undefined,
  status: 0,
  signal: null,
  stdout: "",
  stderr: "",
  ...fields,
});

test("found processes are the pids pgrep printed", () => {
  assert.deepEqual(
    pidsFromPgrep(finished({ stdout: "101\n202\n" }), pattern),
    [101, 202]
  );
});

test("no match (exit 1) is an empty list", () => {
  assert.deepEqual(pidsFromPgrep(finished({ status: 1 }), pattern), []);
});

test("a lookup that fails is an error with its cause, not an empty list", () => {
  assert.throws(
    () =>
      pidsFromPgrep(
        finished({ status: 2, stderr: "pgrep: invalid regex\n" }),
        pattern
      ),
    /pgrep failed for .* \(exit 2\): pgrep: invalid regex$/
  );
  assert.throws(
    () => pidsFromPgrep(finished({ status: null, signal: "SIGKILL" }), pattern),
    /\(exit SIGKILL\)/
  );
  const missing = Object.assign(new Error("spawnSync pgrep ENOENT"), {
    code: "ENOENT",
  });
  assert.throws(
    () => pidsFromPgrep(finished({ error: missing, status: null }), pattern),
    (error) => error.cause === missing && /did not finish/.test(error.message)
  );
});

// Windows에는 pgrep이 없다. 실제 도구와의 연결은 POSIX에서만 본다.
const noPgrep =
  process.platform === "win32" ? "pgrep does not exist on Windows" : false;
const marker = `babojubot-pgrep-${process.pid}-${Date.now()}`;

test(
  "the real pgrep finds the process whose command line matches",
  { skip: noPgrep },
  async () => {
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
  }
);

test(
  "the real pgrep tells no match apart from a failing lookup",
  { skip: noPgrep },
  () => {
    assert.deepEqual(matchingPids(`${marker}-none$`), []);
    assert.throws(() => matchingPids("["), /pgrep failed for \[/);
  }
);
