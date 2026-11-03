import { recordProcess, stopProcessGroup } from "./recovery.ts";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** 프로그램이 있는지 보는 짧은 확인의 제한. 바쁜 컴퓨터에서도 넘지 않을 만큼 넉넉하게 둔다. */
export const probeTimeoutMs = 15_000;
/** 프로그램이 첫 응답을 낼 때까지의 제한. 큰 세션을 불러오면 오래 걸린다. 사용자는 그 전에도 취소할 수 있다. */
export const startupLimitMs = 5 * 60 * 1000;
/** 이보다 긴 출력 한 줄은 메모리를 지키려고 그 줄만 버린다. */
const defaultMaxLineLength = 64 * 1024 * 1024;

/** One process group per attempt. Raw stderr is drained, never propagated to public logs. */
export function startProcess(options: {
  command: readonly [string, ...string[]];
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  maxLineLength?: number;
  onFrame: (frame: unknown) => Promise<void>;
}) {
  const maxLineLength = options.maxLineLength ?? defaultMaxLineLength;
  if (process.platform !== "linux")
    throw new Error("CLI process supervision requires Linux /proc");
  const lease = crypto.randomUUID();
  const child = spawn(
    options.command[0],
    [...options.command.slice(1), ...options.args],
    {
      cwd: options.cwd,
      env: { ...options.env, BABOJUBOT_PROCESS_LEASE: lease },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }
  );
  let forget = () => {};
  if (options.stateDir && child.pid)
    try {
      forget = recordProcess(options.stateDir, child.pid, lease);
    } catch {
      child.kill("SIGKILL");
    }
  let closed = false,
    broken = false,
    skipping = false,
    buffer = "",
    queue = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  // 모르는 출력(안내문 등)은 건너뛴다. 프레임 처리 실패도 실행 시도를 끝내지 않는다.
  const deliver = (line: string) => {
    if (!line.trim()) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    queue = queue
      .then(() => options.onFrame(frame))
      .catch(() => {
        console.warn("[provider] a protocol frame could not be handled");
      });
  };
  let term: ReturnType<typeof setTimeout> | undefined,
    kill: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(
        process.platform === "win32" ? child.pid : -child.pid,
        signal
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") broken = true;
    }
  };
  const end = () => {
    if (closed || term) return;
    child.stdin.end();
    term = setTimeout(() => {
      signalGroup("SIGTERM");
      kill = setTimeout(() => signalGroup("SIGKILL"), 2000);
    }, 2000);
  };
  const write = (frame: unknown) => {
    if (closed || child.stdin.destroyed || child.stdin.writableEnded)
      return false;
    child.stdin.write(JSON.stringify(frame) + "\n");
    return true;
  };
  child.stdin.on("error", () => {
    broken = true;
    end();
  });
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (skipping) skipping = false;
      else if (line.length <= maxLineLength) deliver(line);
    }
    if (buffer.length > maxLineLength) {
      buffer = "";
      skipping = true;
    }
  });
  const done = new Promise<{ code: number | null; broken: boolean }>(
    (resolve) => {
      child.on("error", () => {
        broken = true;
      });
      child.on("close", (code) => {
        closed = true;
        clearTimeout(term);
        clearTimeout(kill);
        const rest = buffer + decoder.end();
        buffer = "";
        if (!skipping && rest.length <= maxLineLength) deliver(rest);
        void (async () => {
          // The leader may exit before its shell/MCP children. Do not release the attempt while they live.
          if (child.pid)
            try {
              await stopProcessGroup(child.pid);
            } catch {
              broken = true;
              console.error(
                "[provider] a process group could not be stopped; releasing the run anyway"
              );
            }
          await queue;
          try {
            forget();
          } catch {
            broken = true;
            console.error(
              "[provider] process exited but its recovery record could not be removed"
            );
          }
          resolve({ code, broken });
        })();
      });
    }
  );
  return {
    write,
    end,
    done,
    interrupt: () => signalGroup("SIGINT"),
    endInput: () => child.stdin.end(),
    get closed() {
      return closed;
    },
  };
}
