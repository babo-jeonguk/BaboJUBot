import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { killUnlessGone, processAlive } from "./test-cleanup.ts";
import { attemptAll } from "@babojubot/contracts";
import { psField } from "./ps.ts";
import { statFields, statRuns } from "./proc-stat.ts";
import { within } from "./test-support.ts";

/**
 * 시험이 띄운 프로그램의 준비 줄. 완전한 줄이 `line`과 같을 때 끝나고, 그 전에 오류·시한이면 실패한다.
 * 프로그램이 끝난(`exit`) 뒤에도 출력이 끝나기(`end`) 전까지는 줄이 닿을 수 있어 계속 읽는다(#286). 출력이 줄 없이 끝나면 준비 전에
 * 끝난 것이다. 출력을 물려받은 자손이 출력을 쥐고 있으면 끝이 오지 않으므로, exit 뒤 출력의 끝은 `outputEndMs` 안에서 확인하고
 * 넘기면 끝을 확인하지 못했다고 실패한다(끝났다고 보지 않는다). 전체 시한(`timeoutMs`)은 따로 둔다.
 */
export function readyLine(
  child: ChildProcess,
  line = "ready",
  timeoutMs = 10_000,
  outputEndMs = 10_000
) {
  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    let outputEnd: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(outputEnd);
      child.stdout!.off("data", read);
      child.stdout!.off("end", ended);
      child.off("error", fail);
      child.off("exit", exited);
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
    const ended = () => done(new Error(`exited before printing ${line}`));
    const exited = () => {
      outputEnd = setTimeout(
        () =>
          done(
            new Error(
              `exited without printing ${line}, and its output did not end within ${outputEndMs} ms (a descendant may hold it)`
            )
          ),
        outputEndMs
      );
    };
    const timer = setTimeout(
      () => done(new Error(`no ${line} line within ${timeoutMs} ms`)),
      timeoutMs
    );
    child.stdout!.on("data", read);
    child.stdout!.once("end", ended);
    child.once("error", fail);
    child.once("exit", exited);
  });
}

/**
 * 프로세스가 끝났는가. 거두어지기 전의 좀비도 끝난 것으로 본다(Linux는 마지막 스레드까지 끝난 좀비만). "없음"만 끝난 것으로 보고(신호 0의 ESRCH, 사라진 `/proc` 항목,
 * 대상이 없다는 `ps`의 답) 그 밖의 조회 실패는 pid·원인과 함께 던진다. Windows에는 좀비가 없어 신호 0의 답만 본다.
 */
export function exited(pid: number) {
  if (!processAlive(pid)) return true;
  if (process.platform === "win32") return false;
  if (process.platform === "linux") {
    const fields = procFields(pid);
    return fields === undefined || !statRuns(fields);
  }
  const state = psState(pid);
  return state === undefined || state === "Z" || state === "X";
}

/** `/proc/<pid>/stat`의 칸(`statFields`). 묻는 사이에 끝나 항목이 없으면(ENOENT, 읽는 중 사라지면 ESRCH) undefined. */
function procFields(pid: number) {
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
  return statFields(stat);
}

/** `ps`가 알리는 상태 글자. 대상 없음과 실패의 판정은 제품의 `psField`(ps.ts)가 맡는다. */
function psState(pid: number) {
  return psField(pid, "stat", 10_000)?.[0];
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

/**
 * 시험이 띄운 자식을 끝내고 그 끝(`exit`)을 상한 안에서 확인한다(#288 parent 점검: 번호 신원). Node가 그 자식의 끝을 아직 보지
 * 않았을 때만 SIGKILL을 보낸다: Node는 끝을 본 자식에는 신호하지 않으므로, 번호가 다른 프로그램에 다시 주어져도 그 프로그램에 가지
 * 않는다. 번호로 끄는 `killAndWait`는 그 번호가 아직 그 프로세스임을 같은 순간에 본 곳에서만 쓴다.
 */
export async function endChild(child: ChildProcess, ms = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGKILL");
  await within(ended, ms, `process ${child.pid} did not end after SIGKILL`);
}

/** 시험 정리: 모두에게 SIGKILL을 보내고 끝날 때까지 기다린다. 한 대상에 보내지 못해도 나머지에 보내고 기다린 뒤 함께 알린다. */
export async function killAndWait(pids: number[]) {
  await attemptAll([
    ...pids.map((pid) => () => killUnlessGone(pid)),
    () => untilExited(pids),
  ]);
}
