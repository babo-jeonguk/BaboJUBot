import { recordProcess, stopProcessGroup } from "./recovery.ts";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** One process group per attempt. Raw stderr is drained, never propagated to public logs. */
export function startProcess(options: {
  command: readonly [string, ...string[]];
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateDir?: string;
  onFrame: (frame: unknown) => Promise<void>;
}) {
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
    buffer = "",
    queue = Promise.resolve();
  const decoder = new StringDecoder("utf8");
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
    if (buffer.length > 4 * 1024 * 1024) {
      buffer = "";
      broken = true;
      end();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const frame: unknown = JSON.parse(line);
        queue = queue
          .then(() => options.onFrame(frame))
          .catch(() => {
            broken = true;
            end();
          });
      } catch {
        broken = true;
        end();
      }
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
        if (buffer.trim() || decoder.end()) broken = true;
        void (async () => {
          // The leader may exit before its shell/MCP children. Do not release the attempt while they live.
          if (child.pid) {
            let warned = false;
            for (;;)
              try {
                await stopProcessGroup(child.pid);
                break;
              } catch {
                broken = true;
                if (!warned) {
                  console.error(
                    "[provider] cleanup could not be confirmed; retaining the execution slot"
                  );
                  warned = true;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
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
