import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  link,
  rm,
  realpath,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import type {
  ProviderConnection,
  RunResult,
  Usage,
} from "@babojubot/contracts";
import { startProcess, probeTimeoutMs, startupLimitMs } from "./process.ts";
const owner = "babojubot-antigravity-v1";
const workspaces = new Map<string, Promise<void>>();
const failure = (error = "프로바이더를 실행하지 못했습니다."): RunResult => ({
  stopReason: "failed",
  error,
  summary: null,
  usage: null,
  nextSession: null,
});
/** Never follow a link or remove somebody else's workspace configuration. */
async function removeOwned(cwd: string) {
  const directory = path.join(cwd, ".agents"),
    file = path.join(directory, "mcp_config.json");
  try {
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("unsafe workspace");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  try {
    if (!(await lstat(file)).isFile()) throw new Error("unsafe configuration");
    const value = JSON.parse(await readFile(file, "utf8")) as {
      babojubotOwner?: string;
    };
    if (value.babojubotOwner !== owner)
      throw new Error("unowned configuration");
    await rm(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
/** Called before admission on server startup. Unowned files are left for execute to report. */
export async function cleanupAntigravityWorkspaces(dataDir: string) {
  const organizations = path.join(dataDir, "organizations");
  for (const org of await readdir(organizations, { withFileTypes: true }).catch(
    () => []
  )) {
    if (!org.isDirectory()) continue;
    try {
      await removeOwned(path.join(organizations, org.name, "shared"));
    } catch {
      /* Preserve unowned files. */
    }
  }
}
export function createAntigravityProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
}): ProviderConnection {
  const home = path.resolve(options.dataDir, "providers/antigravity"),
    command = options.command ?? ["agy"];
  const env = () => ({
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
  });
  const probe = async (args: string[], signal: AbortSignal) => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    return (
      await promisify(execFile)(command[0], [...command.slice(1), ...args], {
        cwd: home,
        env: env(),
        signal,
        timeout: probeTimeoutMs,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  };
  const adapter: ProviderConnection["adapter"] = {
    capabilities: {
      steer: false,
      resume: true,
      reinjectInstructionsOnResume: true,
      usageTokens: true,
      usageCost: false,
      precompact: false,
    },
    loginCommand: `HOME='${home.replaceAll("'", "'\\''")}' agy`,
    async checkReadiness(signal) {
      // 파일 위치를 가정하지 않고 프로그램의 응답으로 판단한다. 목록 조회는 모델을 부르지 않는다.
      try {
        await probe(["models"], signal);
        return { status: "ready", reason: null };
      } catch (e) {
        const error = e as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
        };
        if (error.code === "ENOENT")
          return { status: "not_ready", reason: "program_missing" };
        return {
          status: "not_ready",
          reason: /sign.?in|log.?in|auth/i.test(
            `${error.stdout ?? ""}${error.stderr ?? ""}`
          )
            ? "product_login_missing"
            : "check_failed",
        };
      }
    },
    async execute(request, control) {
      let release: (() => void) | undefined,
        cwd: string | undefined,
        owned = false;
      try {
        if (control.signal.aborted)
          return { ...failure(), stopReason: "cancelled", error: null };
        // 준비 확인을 거치지 않아도 실행 환경은 있어야 한다.
        await mkdir(home, { recursive: true, mode: 0o700 });
        cwd = await realpath(request.workspace?.cwd ?? home);
        while (workspaces.has(cwd)) {
          control.signal.throwIfAborted();
          await Promise.race([
            workspaces.get(cwd),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 100);
              timer.unref();
            }),
          ]);
        }
        if (control.signal.aborted)
          return { ...failure(), stopReason: "cancelled", error: null };
        workspaces.set(
          cwd,
          new Promise<void>((resolve) => {
            release = resolve;
          })
        );
        try {
          await removeOwned(cwd);
        } catch {
          return failure(
            "작업 폴더의 MCP 설정이 제품 소유 파일이 아니거나 심볼릭 링크입니다."
          );
        }
        const directory = path.join(cwd, ".agents"),
          file = path.join(directory, "mcp_config.json");
        await mkdir(directory, { recursive: true });
        const temp = path.join(
          directory,
          `.babojubot-${crypto.randomUUID()}.tmp`
        );
        try {
          await writeFile(
            temp,
            JSON.stringify({
              babojubotOwner: owner,
              mcpServers: {
                organization: {
                  serverUrl: new URL(
                    "/api/tools/mcp",
                    request.access.toolsBaseUrl
                  ).href,
                  headers: { Authorization: `Bearer ${request.access.token}` },
                },
              },
            }),
            { flag: "wx", mode: 0o600 }
          );
          await link(temp, file);
          owned = true;
        } finally {
          await rm(temp, { force: true });
        }
        const args = [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--add-dir",
          cwd,
          "--disable-slash-commands",
          "--dangerously-skip-permissions",
        ];
        if (request.model) args.push("--model", request.model);
        if (typeof request.previousSession?.id === "string") {
          const id = request.previousSession.id;
          let exists = false;
          if (/^[a-zA-Z0-9-]+$/.test(id))
            try {
              exists = (
                await lstat(
                  path.join(
                    home,
                    ".gemini/antigravity-cli/conversations",
                    id + ".db"
                  )
                )
              ).isFile();
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
          if (exists) args.push("--conversation", id);
          else
            await control.emit({
              type: "progress",
              text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
            });
        }
        let id: string | undefined,
          result = failure(),
          finished = false;
        const usage: Usage = {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: null,
        };
        const steps = new Set<number>();
        const child = startProcess({
          stateDir: home,
          command,
          args,
          cwd,
          env: env(),
          onFrame: async (raw) => {
            if (!raw || typeof raw !== "object" || finished) return;
            const frame = raw as {
              event?: string;
              conversation_id?: string;
              step_update?: {
                conversation_id?: string;
                step_index: number;
                state?: string;
                usage?: Record<string, unknown>;
              };
              result?: {
                status?: string;
                conversation_id?: string;
                error?: string;
              };
            };
            if (
              frame.event === "init" &&
              typeof frame.conversation_id === "string"
            ) {
              clearTimeout(startup);
              id = frame.conversation_id;
              await control.emit({
                type: "progress",
                text: "프로바이더가 작업을 시작했습니다.",
              });
            }
            const step = frame.step_update;
            if (
              frame.event === "step_update" &&
              id &&
              step?.conversation_id === id &&
              step.state === "DONE" &&
              step.usage &&
              !steps.has(step.step_index)
            ) {
              steps.add(step.step_index);
              const n = (v: unknown) =>
                typeof v === "number" && Number.isInteger(v) && v >= 0
                  ? v
                  : null;
              const input = n(step.usage.input_tokens),
                cached = n(step.usage.cache_read_tokens),
                output = n(step.usage.output_tokens);
              if (input !== null)
                usage.inputTokens =
                  (usage.inputTokens ?? 0) + Math.max(0, input - (cached ?? 0));
              if (cached !== null)
                usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cached;
              if (output !== null)
                usage.outputTokens = (usage.outputTokens ?? 0) + output;
            }
            if (frame.event === "result") {
              finished = true;
              const success =
                !!id &&
                frame.result?.conversation_id === id &&
                frame.result.status === "SUCCESS";
              result = {
                ...failure(),
                stopReason: success ? "completed" : "failed",
                error: success ? null : "프로바이더 실행이 실패했습니다.",
                usage,
                nextSession: success ? { id: id! } : null,
              };
              if (/auth|sign.in|log.in/i.test(frame.result?.error ?? ""))
                result.errorCode = "login_required";
              child.end();
            }
          },
        });
        const startup = setTimeout(() => child.end(), startupLimitMs);
        const cancel = () => {
          child.interrupt();
          child.end();
        };
        control.signal.addEventListener("abort", cancel, { once: true });
        try {
          if (control.signal.aborted) cancel();
          else
            child.write({
              event: "user",
              message: {
                content:
                  request.instructions.map((f) => f.content).join("\n\n") +
                  "\n\n" +
                  JSON.stringify({
                    identity: request.identity,
                    context: request.context,
                    wakeReasons: request.wakeReasons,
                  }),
              },
            });
          await child.done;
          if (control.signal.aborted)
            return { ...failure(), stopReason: "cancelled", error: null };
          return result;
        } finally {
          clearTimeout(startup);
          control.signal.removeEventListener("abort", cancel);
        }
      } catch {
        return control.signal.aborted
          ? { ...failure(), stopReason: "cancelled", error: null }
          : failure();
      } finally {
        try {
          if (owned && cwd) await removeOwned(cwd);
        } finally {
          if (release && cwd) {
            workspaces.delete(cwd);
            release();
          }
        }
      }
    },
  };
  return {
    id: "antigravity",
    label: "Antigravity",
    adapter,
    models: [],
    async listModels(signal) {
      return (await probe(["models"], signal)).split("\n").flatMap((line) => {
        const [id, label] = line.split("\t");
        return id && label ? [{ id, label }] : [];
      });
    },
  };
}
