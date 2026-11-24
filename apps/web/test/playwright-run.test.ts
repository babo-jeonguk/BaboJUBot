import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { attemptAll } from "@babojubot/contracts";
import {
  awaitedLater,
  withCleanup,
  type CleanupStep,
} from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";
import { expect, it } from "vitest";
import { runToEnd, runToEndStopMs } from "../e2e/support/playwright-run.ts";

/**
 * 이 시험이 runToEnd에 주는 시한. 시험 시한은 runToEnd의 최악의 길(이 시한 + 끈 뒤 확인 둘)과 정리의 최악의 길(확인 둘)에 여유(20초)를
 * 더한다.
 */
const runMs = 30_000;
const testMs = runMs + 4 * runToEndStopMs + 20_000;

/**
 * 시험이 띄운 자식. 끝은 띄운 직후부터 기록한다: 시작이 실패하면(`error`) 오지 않는 `exit`를 기다리지 않고 그 실패로 거절한다.
 * 자식과 그 출력을 물려받은 자손은 한 정리 단위다. 정리는 자식을 끄고 넷째 파이프(자손이 읽는다)를 닫은 뒤, 종료와 출력 닫힘을 각각
 * 상한 안에 확인하고 실패는 모두 알린다. `kill()`은 Node가 끝을 본 자식에는 신호를 보내지 않는다.
 */
function spawnChild(defer: (step: CleanupStep) => void, code: string) {
  const child = spawn(process.execPath, ["-e", code], {
    // 넷째 파이프는 정리가 닫을 때까지 열려 있다. Node는 자식이 끝나면 stdin을 닫지만 이것은 닫지 않는다.
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const exited = awaitedLater(
    new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    })
  );
  // 출력이 닫힌 때. 자식과 출력을 물려받은 자손이 모두 놓아야 닫힌다.
  const outputClosed = Promise.all(
    [child.stdout, child.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => stream.once("close", () => resolve()))
    )
  );
  defer(async () => {
    child.kill("SIGKILL");
    (child.stdio[3] as Writable).end();
    await attemptAll([
      () => within(exited, runToEndStopMs, "the test's child did not exit"),
      () =>
        within(
          outputClosed,
          runToEndStopMs,
          "the output of the test's child and its descendant did not close"
        ),
    ]);
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
  () =>
    withCleanup(async (defer) => {
      const child = spawnChild(
        defer,
        'console.log("ready"); setInterval(() => {}, 1000);'
      );
      const ready = once(child.stdout, "data");
      // 준비를 기다리는 동안 거절될 수 있다(시작 실패). 그 거절은 아래에서 받는다.
      const running = awaitedLater(
        runToEnd(child, { timeoutMs: runMs, what: "the child" })
      );
      await within(ready, 10_000, "the child did not start");
      child.stdout.destroy(new Error("injected output failure"));
      const failure = await running.then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toEqual(
        new Error("injected output failure")
      );
      // 거절된 때에는 도움이 SIGKILL로 끈 자식의 끝이 이미 보였다.
      expectKilled(child);
    }),
  testMs
);

// 끈 자식의 끝(`exit`)만 보면 그 출력을 물려받은 자손이 남아도 모른다. 도움은 출력이 닫히는 것도 따로 상한 안에 확인하고, 닫히지
// 않으면 원래 실패와 함께 알린다(#286 병합분 감사 항목 6). 자손은 자식이 넘긴 이 시험의 넷째 파이프가 끝나면 끝나므로 정리가 끝낸다.
it(
  "reports a descendant that still holds the output after the child is stopped",
  () =>
    withCleanup(async (defer) => {
      const child = spawnChild(
        defer,
        `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", "require('node:fs').createReadStream('', { fd: 3 }).on('close', () => process.exit(0)).resume();"], {
        stdio: ["ignore", "ignore", "inherit", 3],
      });
      descendant.once("spawn", () => console.log("ready"));
      setInterval(() => {}, 1000);
    `
      );
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
      expect(failure).toBeInstanceOf(Error);
      const cause = (failure as Error).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect(
        (cause as AggregateError).errors.map((error: Error) => error.message)
      ).toEqual([
        "injected output failure",
        `the child: the output of the stopped child did not close within ${runToEndStopMs} ms`,
      ]);
      expectKilled(child);
    }),
  testMs
);
