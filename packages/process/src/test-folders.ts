import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { removeFolderWithin } from "./test-cleanup.ts";
import { settledWithin, within } from "./test-support.ts";
import { attemptAll, attemptEach, combinedFailure } from "@babojubot/contracts";

type Hook = (cleanup: () => Promise<void>) => void;

/**
 * 시험 폴더를 만들고 정리까지 맡는다. 정리는 hook(기본: 시험마다)에서 기다리며, 시험이 성공했든 중간에 실패했든 같은 순서다.
 * 0. 첫 동기 단계에서 자기를 닫고(그 뒤의 `make`·`own`·`ownArming`·`adopt`는 던진다) `ownArming`으로 맡은 호출 무장을 끝낸다.
 * 1. 진행 중인 만들기와 무장 안의 획득이 끝나기를 시한 안에서 확인한다. 시한 뒤에 끝난 만들기의 폴더는 어느 정리도 가져가지 않고
 *    남긴다(그 실패는 이미 알렸다).
 * 2. `own`·`ownChild`로 맡긴 것(폴더 안에서 도는 프로그램, 진행 중인 쓰기)을 늦게 맡긴 것부터 멈추고, 끝나기를 시한 안에서 기다린다.
 * 3. 모두 끝났을 때만 폴더를 지운다(`removeFolderWithin`: Windows의 일시적인 잠김만 정해진 횟수 다시 시도. 지운 항목이 잠시 남는 볼륨(SMB 등)은
 *    `retries`·`retryDelayMs`로 늘린다).
 * 끝나지 않은 것이 있으면 폴더는 지우지 않는다. 지우기가 그 탓에 실패해 원인을 가리지 않도록, 그 실패만 알린다.
 * 시험마다 정리하면(hook이 `afterEach`) 닫힌 정리 뒤 다음 시험이 시작할 때 새로 연다. 다른 hook은 한 번 닫으면 닫힌 채다.
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
  /** 정리 한 회차가 맡은 것. `closed`는 그 정리가 시작됐다는 표시, `collected`는 만들기의 끝 확인을 마쳤다는 표시다. */
  type Round = {
    closed: boolean;
    collected: boolean;
    folders: string[];
    /** 만들고 있는 폴더(`make`가 시작 순간 등록). */
    making: Promise<unknown>[];
    armings: (() => Promise<readonly string[] | void>)[];
    stops: { stop: () => Promise<unknown>; what: string }[];
  };
  const opened = (): Round => ({
    closed: false,
    collected: false,
    folders: [],
    making: [],
    armings: [],
    stops: [],
  });
  let round = opened();
  const open = () => {
    if (round.closed)
      throw new Error("the test folders were already cleaned up");
    return round;
  };
  if (hook === afterEach)
    beforeEach(() => {
      if (round.closed) round = opened();
    });
  hook(async () => {
    const ending = round;
    ending.closed = true;
    // 맡은 호출 무장의 끝 표시는 그 끝의 동기 부분이 세운다. 무엇을 기다리기 전에 모두 부른다.
    const armingsEnded = ending.armings.splice(0).map((end) => {
      try {
        return end();
      } catch (error) {
        return Promise.reject(error);
      }
    });
    // 진행 중인 만들기의 끝을 상한 안에서 확인한다. 끝을 확인하지 못하면 만든 폴더가 목록에 없을 수 있으므로, 맡은 것은 멈추되
    // 폴더는 하나도 지우지 않고(목록에서 빼 다음 정리가 가져가지 않게) 실패한다.
    const [unconfirmedMaking, armings] = await Promise.all([
      settledWithin(
        ending.making.splice(0),
        stopTimeoutMs,
        "a test folder being made did not finish"
      )
        .then(
          () => undefined,
          (error: unknown) => error
        )
        .finally(() => {
          ending.collected = true;
        }),
      Promise.allSettled(armingsEnded),
    ]);
    // 끝을 확인한 무장이 그 안에서 만든 폴더는 이 정리가 지운다.
    for (const ended of armings)
      if (ended.status === "fulfilled" && ended.value)
        ending.folders.push(...ended.value);
    const failures = [
      ...(unconfirmedMaking === undefined ? [] : [unconfirmedMaking]),
      ...armings.flatMap((ended) =>
        ended.status === "rejected" ? [ended.reason] : []
      ),
      ...(await attemptEach(
        ending.stops
          .splice(0)
          .reverse()
          .map(
            ({ stop, what }) =>
              () =>
                within(stop(), stopTimeoutMs, `${what} did not stop`)
          )
      )),
    ];
    // 끝나지 않은 것이 있으면 폴더는 지우지 않고 남긴다.
    if (failures.length) {
      ending.folders.splice(0);
      throw combinedFailure(failures, "test cleanup failed");
    }
    // 한 폴더를 지우지 못해도 나머지를 지우고, 지우지 못한 폴더를 모두 알린다.
    await attemptAll(
      ending.folders.splice(0).map(
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
    /**
     * 새 임시 폴더(`base` 아래, 기본은 이 컴퓨터의 임시 폴더). 만들기를 시작 순간 정리에 등록하고(정리가 그 끝을 기다린다), 만든 폴더를
     * 정리 때 지운다.
     */
    make(prefix: string, base = tmpdir()) {
      const making = open();
      const made = mkdtemp(path.join(base, prefix)).then((folder) => {
        if (!making.collected) making.folders.push(folder);
        return folder;
      });
      making.making.push(made);
      return made;
    },
    /** 다른 곳(다른 기준 폴더·realpath)에서 만든 폴더의 정리를 맡는다. */
    adopt(folder: string) {
      open().folders.push(folder);
      return folder;
    },
    /** 폴더를 지우기 전에 끝나야 하는 것. `stop`은 그것을 멈추고 끝날 때까지 기다린다. */
    own(stop: () => Promise<unknown>, what = "a test resource") {
      open().stops.push({ stop, what });
    },
    /**
     * 호출 무장의 끝(`callArming().run`의 셋째 인수로 받은 끝을 부르는 함수). 정리의 첫 동기 단계에서 부르고(그 함수는 첫 await 전에
     * 무장의 끝을 부른다), 그 끝(무장 안의 획득 확인)을 폴더를 지우기 전에 기다린다. 끝이 돌려준 폴더(무장 안에서 만든 것)는 이 정리가
     * 지운다. 끝을 확인하지 못하면 아무 폴더도 지우지 않고 실패한다.
     */
    ownArming(end: () => Promise<readonly string[] | void>) {
      open().armings.push(end);
    },
    /**
     * 시험이 띄운 프로그램. 정리 때 아직 돌면 SIGKILL을 보내고, 종료와 stdio 닫힘(`close`)을 기다린다.
     * 출력을 물려받은 자손이 남으면 `close`가 오지 않으므로, 그런 자손은 시험이 따로 끝낸다.
     */
    ownChild<T extends ChildProcess>(child: T) {
      const owning = open();
      // 띄운 직후부터 듣는다. 정리 전에 이미 닫혔어도 놓치지 않는다. spawn이 실패하면 close 없이 error만 온다.
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.once("error", () => {
          if (child.pid === undefined) resolve();
        });
      });
      owning.stops.push({
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
