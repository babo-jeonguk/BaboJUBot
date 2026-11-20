import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { killUnlessGone, processAlive } from "./test-cleanup.ts";
import { attemptAll } from "@babojubot/contracts";

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

/**
 * 프로세스가 끝났는가. 거두어지기 전의 좀비도 끝난 것으로 본다. "없음"만 끝난 것으로 보고(신호 0의 ESRCH, 사라진 `/proc` 항목,
 * 대상이 없다는 `ps`의 답) 그 밖의 조회 실패는 pid·원인과 함께 던진다. Windows에는 좀비가 없어 신호 0의 답만 본다.
 */
export function exited(pid: number) {
  if (!processAlive(pid)) return true;
  if (process.platform === "win32") return false;
  const state = process.platform === "linux" ? procState(pid) : psState(pid);
  return state === undefined || state === "Z" || state === "X";
}

/** `/proc/<pid>/stat`의 상태 글자. 묻는 사이에 끝나 항목이 없으면(ENOENT, 읽는 중 사라지면 ESRCH) undefined. */
function procState(pid: number) {
  const file = `/proc/${pid}/stat`;
  let stat: string;
  try {
    stat = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw new Error(`프로세스 ${pid}의 상태(${file})를 읽지 못했다`, {
      cause: error,
    });
  }
  return stat.slice(stat.lastIndexOf(") ") + 2)[0];
}

/**
 * `ps`가 알리는 상태 글자. 대상이 없으면 `ps`는 아무것도 쓰지 않고 1로 끝나므로(macOS·procps) 그때만 undefined다.
 * 실행하지 못했거나 다른 코드·오류 출력으로 끝나면 pid·원인과 함께 던진다.
 */
function psState(pid: number) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = result.stdout?.trim() ?? "";
  if (result.status === 0 && out) return out[0];
  if (result.status === 1 && !out && !result.stderr?.trim()) return undefined;
  const reported = result.stderr?.trim();
  throw new Error(
    `프로세스 ${pid}의 상태를 ps로 읽지 못했다(code ${result.status}, signal ${result.signal})${reported ? `: ${reported}` : ""}`,
    { cause: result.error }
  );
}

/**
 * 모두 끝날 때까지 시한 안에서 기다린다. 대상마다 따로 보므로 한 대상의 조회가 실패해도 나머지가 끝나기를 계속 기다린다.
 * 시한을 넘긴 대상은 그 번호를, 조회가 실패한 대상은 그 원인(pid 포함)을 모두 모아 실패한다(`attemptAll`).
 * 시한은 모든 대상이 함께 쓴다. 앞 대상을 기다리는 동안 뒤 대상의 시간도 간다.
 */
export async function untilExited(pids: number[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  await attemptAll(
    pids.map((pid) => async () => {
      // 조회가 실패하면 waitUntil이 그 오류로 바로 끝난다. 시한은 함께 쓰는 마감으로 보고, waitUntil의 시한은 그 뒤의 안전판이다.
      await vi.waitUntil(() => exited(pid) || Date.now() >= deadline, {
        timeout: timeoutMs + 1_000,
        interval: 25,
      });
      if (!exited(pid))
        throw new Error(`process ${pid} still running after ${timeoutMs} ms`);
    }),
    "processes did not all end"
  );
}

/** 시험 정리: 모두에게 SIGKILL을 보내고 끝날 때까지 기다린다. 한 대상에 보내지 못해도 나머지에 보내고 기다린 뒤 함께 알린다. */
export async function killAndWait(pids: number[]) {
  await attemptAll([
    ...pids.map((pid) => () => killUnlessGone(pid)),
    () => untilExited(pids),
  ]);
}
