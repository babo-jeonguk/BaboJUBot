import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { removeFolder } from "../remove-folder.ts";

type Hook = (cleanup: () => Promise<void>) => void;

/** 정리에서 기다리는 시한. 넘으면 그것이 끝나지 않은 채로 시험이 실패한다. */
const stopTimeoutMs = 10_000;

/**
 * 시험 폴더를 만들고 정리까지 맡는다. 정리는 hook(기본: 시험마다)에서 기다리며, 시험이 성공했든 중간에 실패했든 같은 순서다.
 * 1. `own`·`ownChild`로 맡긴 것(폴더 안에서 도는 프로그램, 진행 중인 실행·쓰기)을 늦게 맡긴 것부터 멈추고, 끝나기를 시한 안에서 기다린다.
 * 2. 모두 끝났을 때만 폴더를 지운다(`removeFolder`: Windows의 일시적인 잠김만 정해진 횟수 다시 시도).
 * 끝나지 않은 것이 있으면 폴더는 지우지 않는다. 지우기가 그 탓에 실패해 원인을 가리지 않도록, 그 실패만 알린다.
 */
export function testFolders(hook: Hook = afterEach) {
  const folders: string[] = [];
  const stops: { stop: () => Promise<unknown>; what: string }[] = [];
  hook(async () => {
    const failures: unknown[] = [];
    for (const { stop, what } of stops.splice(0).reverse())
      try {
        await within(stop(), what);
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) {
      folders.splice(0);
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "test cleanup failed");
    }
    await Promise.all(folders.splice(0).map((folder) => removeFolder(folder)));
  });
  return {
    /** 새 임시 폴더. 정리 때 지운다. */
    async make(prefix: string) {
      const folder = await mkdtemp(path.join(tmpdir(), prefix));
      folders.push(folder);
      return folder;
    },
    /** 다른 곳(다른 기준 폴더·realpath)에서 만든 폴더의 정리를 맡는다. */
    adopt(folder: string) {
      folders.push(folder);
      return folder;
    },
    /** 폴더를 지우기 전에 끝나야 하는 것. `stop`은 그것을 멈추고 끝날 때까지 기다린다. */
    own(stop: () => Promise<unknown>, what = "a test resource") {
      stops.push({ stop, what });
    },
    /**
     * 시험이 띄운 프로그램. 정리 때 아직 돌면 SIGKILL을 보내고, 종료와 stdio 닫힘(`close`)을 기다린다.
     * 출력을 물려받은 자손이 남으면 `close`가 오지 않으므로, 그런 자손은 시험이 따로 끝낸다.
     */
    ownChild<T extends ChildProcess>(child: T) {
      // 띄운 직후부터 듣는다. 정리 전에 이미 닫혔어도 놓치지 않는다. spawn이 실패하면 close 없이 error만 온다.
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.once("error", () => {
          if (child.pid === undefined) resolve();
        });
      });
      stops.push({
        what: `test program ${child.pid}`,
        stop: async () => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          await closed;
        },
      });
      return child;
    },
  };
}

async function within(stopping: Promise<unknown>, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopping,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${what} did not stop within ${stopTimeoutMs}ms`)),
          stopTimeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
