import { existsSync } from "node:fs";
import { removeFolder } from "@babojubot/process/remove-folder";
import { within } from "@babojubot/process/test-support";
import { expect, it, onTestFinished } from "vitest";
import { testFolders } from "./test-folders.ts";
import type { RunResult, RuntimeAdapter } from "@babojubot/contracts";
import { fakeDeclarations } from "../testing.ts";
import { request } from "./test-support.ts";

// 정리는 폴더를 쓰던 것이 모두 끝난 뒤에 폴더를 지운다. hook을 바꿔 끼워 정리를 시험이 직접 부른다.
// 폴더·프로그램 정리 자체의 시험은 @babojubot/process의 test-folders.test.ts에 있고, 여기는 프로바이더 연결 맡기기만 본다.
function folders(options?: { stopTimeoutMs?: number }) {
  let cleanup!: () => Promise<void>;
  const made = testFolders((run) => {
    cleanup = run;
  }, options);
  return { ...made, cleanup: () => cleanup() };
}

/**
 * 멈춤 신호를 받아야 끝나는 실행 시도. `stuck`을 주면 신호를 받아도 끝나지 않고, 시험이 `stuck`을 풀어야 끝난다.
 * 끝날 때 그 폴더가 아직 있었는지 `order`에 남긴다.
 */
function heldProvider(order: string[], root: string, stuck?: Promise<void>) {
  const end = (): RunResult => {
    order.push(existsSync(root) ? "run ended with folder" : "folder gone");
    return {
      stopReason: "cancelled",
      error: null,
      summary: null,
      usage: null,
      nextSession: null,
    };
  };
  const execute: RuntimeAdapter["execute"] = (_request, { signal }) =>
    stuck
      ? stuck.then(end)
      : new Promise<RunResult>((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => resolve(end()), 20)
          );
        });
  return {
    adapter: { ...fakeDeclarations(), execute } satisfies RuntimeAdapter,
  };
}

/** 시험이 풀 때까지 끝나지 않게 붙잡는 문. */
function stuckRun() {
  let letGo!: () => void;
  const stuck = new Promise<void>((resolve) => (letGo = resolve));
  return { stuck, letGo };
}

/**
 * 시험이 붙잡은 실행을 남긴 폴더의 정리. 시험이 풀기 전에 실패해도 실행을 풀고, 그 실행이 돌아온 것을 상한 안에서 확인한 뒤에만
 * 폴더를 지운다(한 정리 안의 차례). 돌아오지 않으면 폴더를 남기고 실패한다.
 */
async function endHeldRun(
  letGo: () => void,
  { run }: { run?: Promise<RunResult> },
  root: string
) {
  letGo();
  if (run)
    await within(
      run,
      5_000,
      "the held provider run did not end after it was let go"
    );
  await removeFolder(root);
}

const runOptions = () => ({
  signal: new AbortController().signal,
  emit: async () => {},
});

it("stops a provider run a failed test left in progress and removes the folder only after the run ends", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const order: string[] = [];
  const provider = test.ownProvider(heldProvider(order, root));
  // 시험이 실행을 시작한 뒤 결과를 기다리기 전에 단언·시한으로 실패했다.
  const run = provider.adapter.execute(request(), runOptions());
  await test.cleanup();
  expect(order).toEqual(["run ended with folder"]);
  expect(existsSync(root)).toBe(false);
  await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
});

it("keeps the folder and fails by name when a provider run does not end after the stop", async () => {
  const test = folders({ stopTimeoutMs: 50 });
  const root = await test.make("test-folders-");
  const { stuck, letGo } = stuckRun();
  const held: { run?: Promise<RunResult> } = {};
  onTestFinished(() => endHeldRun(letGo, held, root));
  const order: string[] = [];
  const provider = test.ownProvider(heldProvider(order, root, stuck));
  const run = (held.run = provider.adapter.execute(request(), runOptions()));
  await expect(test.cleanup()).rejects.toThrow(
    "provider run did not stop within 50 ms"
  );
  expect(existsSync(root)).toBe(true);
  // 남긴 폴더 안에서 실행이 늦게 끝난다.
  letGo();
  await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
  expect(order).toEqual(["run ended with folder"]);
});

it("owns the runs of providers made by a factory passed around as a value", async () => {
  const test = folders();
  const root = await test.make("test-folders-");
  const order: string[] = [];
  // 시험 표(describe.each·it.each)나 연결 설정에 담아 넘긴 factory도 만든 연결의 실행을 정리에 맡긴다.
  const table = [{ create: test.owning(() => heldProvider(order, root)) }];
  const runs = table.map(({ create }) =>
    create().adapter.execute(request(), runOptions())
  );
  // 실행이 끝나기 전에 시험이 다른 단언(poll)에서 실패했다.
  await test.cleanup();
  expect(order).toEqual(["run ended with folder"]);
  expect(existsSync(root)).toBe(false);
  for (const result of await Promise.all(runs))
    expect(result).toMatchObject({ stopReason: "cancelled" });
});

it("owns a provider once even when it is handed to cleanup twice", async () => {
  const test = folders({ stopTimeoutMs: 50 });
  const root = await test.make("test-folders-");
  const { stuck, letGo } = stuckRun();
  const held: { run?: Promise<RunResult> } = {};
  onTestFinished(() => endHeldRun(letGo, held, root));
  // owning으로 묶은 factory가 만든 연결을 다시 ownProvider로 감싸도 실행은 정리에 한 번만 맡겨진다.
  const create = test.owning(() => heldProvider([], root, stuck));
  const provider = test.ownProvider(create());
  const run = (held.run = provider.adapter.execute(request(), runOptions()));
  const failure = await test.cleanup().catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    message: "provider run did not stop within 50 ms",
  });
  letGo();
  await expect(run).resolves.toMatchObject({ stopReason: "cancelled" });
});

// 실행 시도의 끝(`done`)은 그 프로그램이 끝났다는 증거가 아니다. 제품은 트리의 끝을 확인하지 못해도 `broken: true`로 끝낸다.
// 그런 실행 시도를 맡은 정리는 실패를 드러내고 폴더를 남긴다. 끝난 실행 시도(`broken: false`)를 맡은 정리는 폴더를 지운다.
it.each([
  { broken: false, cleanup: "removes", left: false },
  { broken: true, cleanup: "keeps", left: true },
])(
  "ends a run attempt it owns and $cleanup the folder when the attempt reports broken: $broken",
  async ({ broken, left }) => {
    const test = folders();
    const root = await test.make("test-folders-");
    onTestFinished(() => removeFolder(root));
    const ended: string[] = [];
    test.ownRun({
      end: () => ended.push("end"),
      done: Promise.resolve({ broken }),
    });
    const cleaned = test.cleanup();
    if (broken)
      await expect(cleaned).rejects.toThrow(
        "run attempt ended without confirming that its programs and their cleanup ended (broken)"
      );
    else await cleaned;
    expect(ended).toEqual(["end"]);
    expect(existsSync(root)).toBe(left);
  }
);
