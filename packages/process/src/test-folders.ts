import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { removeFolder } from "./remove-folder.ts";
import { within } from "./test-support.ts";
import { attemptAll, attemptEach, combinedFailure } from "@babojubot/contracts";

type Hook = (cleanup: () => Promise<void>) => void;

/**
 * 폴더 하나를 상한 안에서 지운다(`removeFolder`, 다시 시도 포함). 넘기면 어느 폴더를 지우다 멈췄는지 알리고 실패한다. 기본 시한
 * 10초는 기본 다시 시도(3회, 대기 합 0.6초)를 담는다. 다시 시도를 늘리면 그 대기의 합보다 긴 `removeTimeoutMs`를 함께 준다.
 * 한계: 시한이 지나도 진행 중인 지우기(`rm`)는 멈추지 않는다.
 */
export function removeFolderWithin(
  folder: string,
  {
    retries,
    retryDelayMs,
    removeTimeoutMs = 10_000,
  }: { retries?: number; retryDelayMs?: number; removeTimeoutMs?: number } = {}
) {
  return within(
    removeFolder(folder, {
      ...(retries === undefined ? {} : { retries }),
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    }),
    removeTimeoutMs,
    `removing ${folder} did not finish`
  );
}

/**
 * 시험 폴더를 만들고 정리까지 맡는다. 정리는 hook(기본: 시험마다)에서 기다리며, 시험이 성공했든 중간에 실패했든 같은 순서다.
 * 1. `own`·`ownChild`로 맡긴 것(폴더 안에서 도는 프로그램, 진행 중인 쓰기)을 늦게 맡긴 것부터 멈추고, 끝나기를 시한 안에서 기다린다.
 * 2. 모두 끝났을 때만 폴더를 지운다(`removeFolder`: Windows의 일시적인 잠김만 정해진 횟수 다시 시도. 지운 항목이 잠시 남는 볼륨(SMB 등)은
 *    `retries`·`retryDelayMs`로 늘린다).
 * 끝나지 않은 것이 있으면 폴더는 지우지 않는다. 지우기가 그 탓에 실패해 원인을 가리지 않도록, 그 실패만 알린다.
 */
export function testFolders(
  hook: Hook = afterEach,
  // 정리에서 기다리는 시한. 넘으면 그것이 끝나지 않은 채로 시험이 실패한다. `retries`·`retryDelayMs`는 폴더 지우기의 다시 시도다.
  // `removeTimeoutMs`는 폴더 하나를 지우기를 기다리는 시한이다(`removeFolderWithin`, 기본은 정리 단계의 시한).
  {
    stopTimeoutMs = 10_000,
    retries,
    retryDelayMs,
    removeTimeoutMs = stopTimeoutMs,
  }: {
    stopTimeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
    removeTimeoutMs?: number;
  } = {}
) {
  const folders: string[] = [];
  const stops: { stop: () => Promise<unknown>; what: string }[] = [];
  hook(async () => {
    const failures = await attemptEach(
      stops
        .splice(0)
        .reverse()
        .map(
          ({ stop, what }) =>
            () =>
              within(stop(), stopTimeoutMs, `${what} did not stop`)
        )
    );
    // 끝나지 않은 것이 있으면 폴더는 지우지 않고 남긴다.
    if (failures.length) {
      folders.splice(0);
      throw combinedFailure(failures, "test cleanup failed");
    }
    // 한 폴더를 지우지 못해도 나머지를 지우고, 지우지 못한 폴더를 모두 알린다.
    await attemptAll(
      folders.splice(0).map(
        (folder) => () =>
          removeFolderWithin(folder, {
            retries,
            retryDelayMs,
            removeTimeoutMs,
          })
      )
    );
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
