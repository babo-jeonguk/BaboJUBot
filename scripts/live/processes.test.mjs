// 시험용 명령 찾기가 "없음"과 조회 실패를 구분하는지 본다(#255). 판정은 어느 OS에서나 보고, 실제 pgrep은 POSIX에서만 돌린다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";
import { matchingPids, pidsFromPgrep, stillRunning } from "./processes.mjs";

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
    (error) =>
      error instanceof Error &&
      error.cause === missing &&
      /did not finish/.test(error.message)
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
      // 시험이 띄운 자식은 자식 객체로 끈다: Node는 끝을 본 자식에는 신호를 보내지 않아, 끝난 자식의 번호가 다른 프로세스에 다시
      // 쓰였어도 그쪽으로 가지 않는다(#287 리뷰 STD-4). 띄우지 못했으면 보낼 곳이 없고 `exited`가 그 실패로 거절한다.
      defer(async () => {
        child.kill("SIGKILL");
        await within(exited, 10_000, "a killed child did not exit");
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

test("a stopped process is no longer running, and one left alive is named", async () => {
  await withCleanup(async (defer) => {
    const spawnIdle = () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        }
      );
      const exited = once(child, "exit");
      // 시험이 띄운 자식은 자식 객체로 끈다: Node는 끝을 본 자식에는 신호를 보내지 않아, 끝난 자식의 번호가 다른 프로세스에 다시
      // 쓰였어도 그쪽으로 가지 않는다(#287 리뷰 STD-4). 띄우지 못했으면 보낼 곳이 없고 `exited`가 그 실패로 거절한다.
      defer(async () => {
        child.kill("SIGKILL");
        await within(exited, 10_000, "a killed child did not exit");
      });
      return once(child, "spawn").then(() => child);
    };
    const stopped = await spawnIdle();
    const alive = await spawnIdle();
    if (stopped.pid === undefined)
      throw new Error("the stopped child has no pid");
    stopped.kill("SIGKILL");
    // 끝난 것은 상한 안에서 빠지고, 끄지 않은 것은 상한(0.5초)이 지나도 남은 것으로 나온다.
    assert.deepEqual(await stillRunning([stopped.pid, alive.pid], 500), [
      alive.pid,
    ]);
  });
});
