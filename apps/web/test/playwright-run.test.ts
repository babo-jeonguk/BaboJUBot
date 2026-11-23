import { spawn } from "node:child_process";
import { once } from "node:events";
import { within } from "@babojubot/process/test-support";
import { expect, it, onTestFinished } from "vitest";
import { runToEnd } from "../e2e/support/playwright-run.ts";

// 자식을 끝까지 돌리는 도움은 대기가 어떤 이유로 실패하든(시한, 출력 읽기 오류) 자식을 끄고 그 끝을 확인한 뒤에 실패한다(#287 리뷰
// STD-3). 끄기가 시한 분기에만 있으면 출력 오류로 빠져나간 뒤 자식이 남는다.
it("stops the child and sees it end when reading its output fails", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'console.log("ready"); setInterval(() => {}, 1000);'],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  // 시험이 먼저 실패해도 남은 자식을 끈다. `kill()`은 Node가 끝을 본 자식에는 신호를 보내지 않는다.
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const ready = once(child.stdout, "data");
  const running = runToEnd(child, { timeoutMs: 60_000, what: "the child" });
  await within(ready, 10_000, "the child did not start");
  child.stdout.destroy(new Error("injected output failure"));
  await expect(running).rejects.toThrow(/injected output failure/);
  // 거절된 때에는 자식의 끝이 이미 보였다.
  expect({ code: child.exitCode, signal: child.signalCode }).not.toEqual({
    code: null,
    signal: null,
  });
});
