import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * 공용 실행(`launch.ts`) 위에 놓을 수 없는 짧은 명령의 끝을 보장한다(#262). 공용 실행의 끄기가 쓰는 조회(`ps`), 묶음 실행기를 만드는
 * 단계(C# 컴파일·시험 실행), 스스로 데몬을 띄우는 명령(`pg_ctl`)이 여기에 든다. 그 밖의 명령은 공용 실행(`runTree`)을 쓴다.
 *
 * Node.js의 `timeout`은 신호(기본 SIGTERM)만 보내고 끝을 기다린다. 신호를 무시하거나 출력을 물려받은 자손이 출력을 쥐면 그 기다림이
 * 끝나지 않는다. 여기서는 시한에 SIGKILL로 끝내고, 그 뒤 유예(`graceMs`) 안에 끝나지 않으면 원인과 함께 던진다. 끄는 것은 띄운
 * 프로세스 하나다(트리 아님): 트리를 끄면 안 되거나(데몬) 트리 끄기가 이 조회를 쓰는 자리이기 때문이다.
 */

/** 시한에 SIGKILL을 보낸 뒤 끝나기를 기다리는 시간. 넘기면 던진다. */
const killGraceMs = 5_000;
/** 끝난 뒤 남은 출력을 읽을 시간. 출력을 물려받은 자손이 쥐고 있으면 이만큼만 기다리고 닫는다. */
const drainMs = 1_000;

export type BoundedExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 시한·취소로 SIGKILL을 보냈다. */
  killed: boolean;
};

/**
 * 띄운 `child`가 끝나기를 기다리되 끝을 보장한다. 시한(`limitMs`)이나 취소(`signal`)에 SIGKILL을 보내고, 그 뒤 유예 안에 끝나지
 * 않으면 pid와 함께 던진다. 띄우지 못했으면(`error`, pid 없음) 그 오류를 던진다. 출력의 닫힘은 기다리지 않는다(`runCommand`가 본다).
 */
/** `boundChild`가 쓰는 자식 프로세스의 부분. */
export type WatchedChild = {
  readonly pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
};

export function boundChild(
  child: WatchedChild,
  {
    limitMs,
    signal,
    graceMs = killGraceMs,
  }: { limitMs: number; signal?: AbortSignal; graceMs?: number }
): Promise<BoundedExit> {
  return new Promise((resolve, reject) => {
    let killed = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(grace);
      signal?.removeEventListener("abort", kill);
      done();
    };
    const kill = () => {
      if (killed || settled) return;
      killed = true;
      // 이미 끝나 신호를 보내지 못해도 끝은 아래 exit가 알린다.
      child.kill("SIGKILL");
      grace = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                `process ${child.pid} did not end within ${graceMs} ms after SIGKILL`
              )
            )
          ),
        graceMs
      );
    };
    const limit = setTimeout(kill, limitMs);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    child.on("error", (error) => {
      // 띄운 뒤의 오류(신호를 보내지 못함)는 끝이 아니다. 끝은 exit와 유예가 정한다.
      if (child.pid === undefined) finish(() => reject(error));
    });
    child.once("exit", (code, exitSignal) =>
      finish(() => resolve({ code, signal: exitSignal, killed }))
    );
  });
}

export type BoundedRun = BoundedExit & { stdout: string; stderr: string };

/**
 * 짧은 명령을 끝까지 돌린다. 출력은 각각 `maxOutputBytes`까지 모은다(넘는 부분은 버림, 0이면 출력을 받지 않는다). 시한·취소에
 * SIGKILL로 끝내고 끝을 보장한다(`boundChild`). 끝난 뒤 출력이 닫히기를 잠깐(`drainMs`)만 기다리고 닫는다. 띄우지 못했으면
 * (ENOENT 등) 그 오류를 던진다.
 */
export async function runCommand(
  file: string,
  args: readonly string[],
  options: {
    limitMs: number;
    maxOutputBytes: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }
): Promise<BoundedRun> {
  const output = options.maxOutputBytes > 0 ? "pipe" : "ignore";
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", output, output],
    windowsHide: true,
  });
  const collect = (stream: Readable | null) => {
    let text = "";
    if (!stream) return { closed: Promise.resolve(), text: () => text };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (text.length < options.maxOutputBytes)
        text = (text + chunk).slice(0, options.maxOutputBytes);
    });
    const closed = new Promise<void>((resolve) =>
      stream.once("close", () => resolve())
    );
    return { closed, text: () => text };
  };
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  try {
    const exit = await boundChild(child, options);
    let drain: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([stdout.closed, stderr.closed]),
      new Promise<void>((resolve) => {
        drain = setTimeout(resolve, drainMs);
      }),
    ]);
    clearTimeout(drain);
    return { ...exit, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    // 끝을 확인하지 못해 던질 때도 이쪽 출력 끝은 닫는다.
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
