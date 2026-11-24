import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { awaitedLater } from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";
import { expect, it, onTestFinished } from "vitest";
import { runToEnd, runToEndStopMs } from "../e2e/support/playwright-run.ts";

/** 이 시험이 runToEnd에 주는 시한. 시험 시한은 runToEnd의 최악의 길(이 시한 + 끈 뒤 끝 확인 둘)에 정리의 여유(20초)를 더한다. */
const runMs = 30_000;
const testMs = runMs + 2 * runToEndStopMs + 20_000;

/**
 * 시험이 띄운 자식. 끝은 띄운 직후부터 기록한다: 시작이 실패하면(`error`) 오지 않는 `exit`를 기다리지 않고 그 실패로 거절한다.
 * 시험이 먼저 실패해도 정리가 자식을 끄고 그 끝을 상한 안에 확인한다. `kill()`은 Node가 끝을 본 자식에는 신호를 보내지 않는다.
 */
function spawnChild(code: string) {
  const child = spawn(process.execPath, ["-e", code], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = awaitedLater(
    new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    })
  );
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await within(exited, runToEndStopMs, "the test's child did not exit");
  });
  return child;
}

/** 끈 자식은 POSIX·Windows 모두 종료 코드 없이 SIGKILL로 끝난 것으로 보인다(Windows의 libuv는 끈 신호를 `exit_signal`로 넘긴다). */
function expectKilled(child: ChildProcess) {
  expect({ code: child.exitCode, signal: child.signalCode }).toEqual({
    code: null,
    signal: "SIGKILL",
  });
}

// 자식을 끝까지 돌리는 도움은 대기가 어떤 이유로 실패하든(시한, 출력 읽기 오류) 자식을 끄고 그 끝을 확인한 뒤에 실패한다(#287 리뷰
// STD-3). 끄기가 시한 분기에만 있으면 출력 오류로 빠져나간 뒤 자식이 남는다.
it(
  "stops the child and sees it end when reading its output fails",
  async () => {
    const child = spawnChild(
      'console.log("ready"); setInterval(() => {}, 1000);'
    );
    const ready = once(child.stdout, "data");
    // 준비를 기다리는 동안 거절될 수 있다(시작 실패). 그 거절은 아래에서 받는다.
    const running = awaitedLater(
      runToEnd(child, { timeoutMs: runMs, what: "the child" })
    );
    await within(ready, 10_000, "the child did not start");
    child.stdout.destroy(new Error("injected output failure"));
    await expect(running).rejects.toEqual(new Error("injected output failure"));
    // 거절된 때에는 도움이 SIGKILL로 끈 자식의 끝이 이미 보였다.
    expectKilled(child);
  },
  testMs
);

// 끈 자식의 끝(`exit`)만 보면 그 출력을 물려받은 자손이 남아도 모른다. 도움은 출력이 닫히는 것도 따로 상한 안에 확인하고, 닫히지
// 않으면 원래 실패와 함께 알린다(#286 병합분 감사 항목 6). 자손은 자식이 넘긴 이 시험의 입력이 끝나면 끝나므로 시험이 끝낸다.
it(
  "reports a descendant that still holds the output after the child is stopped",
  async () => {
    const child = spawnChild(`
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], {
        stdio: ["inherit", "ignore", "inherit"],
      });
      descendant.once("spawn", () => console.log("ready"));
      setInterval(() => {}, 1000);
    `);
    const stderrClosed = new Promise<void>((resolve) =>
      child.stderr.once("close", () => resolve())
    );
    // 자손이 쥔 출력은 그 입력이 끝나야 닫힌다. 정리가 입력을 끝내고 닫힘을 상한 안에 확인한다.
    onTestFinished(async () => {
      child.stdin.end();
      await within(
        stderrClosed,
        runToEndStopMs,
        "the test's descendant did not let go of the output"
      );
    });
    const ready = once(child.stdout, "data");
    const running = awaitedLater(
      runToEnd(child, { timeoutMs: runMs, what: "the child" })
    );
    await within(ready, 10_000, "the child did not start");
    child.stdout.destroy(new Error("injected output failure"));
    const failure = await running.then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error: Error) => error.message)
    ).toEqual([
      "injected output failure",
      `the child: the output of the stopped child did not close within ${runToEndStopMs} ms`,
    ]);
    expectKilled(child);
  },
  testMs
);
