import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { vi } from "vitest";

/**
 * 시험이 띄운 프로그램의 준비 줄. 완전한 줄이 `line`과 같을 때 끝나고, 그 전에 오류·종료·시한이면 실패한다.
 * 종료는 `exit`로 본다. 출력을 물려받은 자손이 출력을 쥐고 있으면 `close`는 늦게 오기 때문이다.
 * 종료 직전에 쓴 줄은 `exit` 뒤에 도착할 수 있어 잠깐(`drainMs`) 더 읽은 뒤 실패로 본다.
 */
export function readyLine(
  child: ChildProcess,
  line = "ready",
  timeoutMs = 10_000,
  drainMs = 1000
) {
  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    let drain: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(drain);
      child.stdout!.off("data", read);
      child.off("error", fail);
      child.off("exit", exited);
      child.off("close", closed);
      if (error) reject(error);
      else resolve();
    };
    const read = (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
        if (buffer.slice(0, newline).trim() === line) return done();
        buffer = buffer.slice(newline + 1);
      }
    };
    const fail = (error: Error) => done(error);
    const early = () => new Error(`exited before printing ${line}`);
    const exited = () => {
      drain ??= setTimeout(() => done(early()), drainMs);
    };
    const closed = () => done(early());
    const timer = setTimeout(
      () => done(new Error(`no ${line} line within ${timeoutMs} ms`)),
      timeoutMs
    );
    child.stdout!.on("data", read);
    child.once("error", fail);
    child.once("exit", exited);
    child.once("close", closed);
  });
}

/** 프로세스가 끝났는가. 거두어지기 전의 좀비도 끝난 것으로 본다. */
export function exited(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  try {
    const state =
      process.platform === "linux"
        ? readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)![0]
        : execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim()[0];
    return state === "Z" || state === "X" || state === undefined;
  } catch {
    // 묻는 사이에 끝났다.
    return true;
  }
}

/** 모두 끝날 때까지 시한 안에서 기다린다. 넘으면 남은 번호와 함께 실패한다. */
export async function untilExited(pids: number[], timeoutMs = 5000) {
  await vi
    .waitUntil(() => pids.every(exited), { timeout: timeoutMs, interval: 25 })
    .catch(() => {
      throw new Error(
        `still running after ${timeoutMs} ms: ${pids.filter((pid) => !exited(pid)).join(", ")}`
      );
    });
}

/** 시험 정리: SIGKILL을 보내고 끝날 때까지 기다린다. */
export async function killAndWait(pids: number[]) {
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 이미 끝났다.
    }
  await untilExited(pids);
}
