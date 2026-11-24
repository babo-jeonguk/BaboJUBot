import { spawn } from "node:child_process";
import { once } from "node:events";
import { within } from "@babojubot/process/test-support";
import { expect, it, onTestFinished } from "vitest";
import { runToEnd, runToEndStopMs } from "../e2e/support/playwright-run.ts";

/** 이 시험이 runToEnd에 주는 시한. 시험 시한은 runToEnd의 최악의 길(이 시한 + 끈 뒤 끝 확인)에 정리의 여유(20초)를 더한다. */
const runMs = 30_000;

// 자식을 끝까지 돌리는 도움은 대기가 어떤 이유로 실패하든(시한, 출력 읽기 오류) 자식을 끄고 그 끝을 확인한 뒤에 실패한다(#287 리뷰
// STD-3). 끄기가 시한 분기에만 있으면 출력 오류로 빠져나간 뒤 자식이 남는다.
it(
  "stops the child and sees it end when reading its output fails",
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", 'console.log("ready"); setInterval(() => {}, 1000);'],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    // 자식의 끝은 띄운 직후부터 기록한다(거절하지 않는다). 시험이 먼저 실패해도 정리가 자식을 끄고 그 끝을 상한 안에 확인한다.
    // `kill()`은 Node가 끝을 본 자식에는 신호를 보내지 않는다.
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve())
    );
    onTestFinished(async () => {
      child.kill("SIGKILL");
      await within(exited, runToEndStopMs, "the test's child did not exit");
    });
    const ready = once(child.stdout, "data");
    const running = runToEnd(child, { timeoutMs: runMs, what: "the child" });
    await within(ready, 10_000, "the child did not start");
    child.stdout.destroy(new Error("injected output failure"));
    await expect(running).rejects.toThrow(/injected output failure/);
    // 거절된 때에는 도움이 SIGKILL로 끈 자식의 끝이 이미 보였다. 끈 자식은 POSIX·Windows 모두 종료 코드 없이 그 신호로 끝난 것으로
    // 보인다: Node는 신호가 오면 `signalCode`만 적고, Windows의 libuv는 끈 신호를 `exit_signal`로 넘긴다.
    expect({ code: child.exitCode, signal: child.signalCode }).toEqual({
      code: null,
      signal: "SIGKILL",
    });
  },
  runMs + runToEndStopMs + 20_000
);
