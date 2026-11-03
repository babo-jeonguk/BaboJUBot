import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, lstat } from "node:fs/promises";
import path from "node:path";
import type {
  ProviderConnection,
  RunResult,
  Usage,
  SteerMessage,
  SteerOutcome,
} from "@babojubot/contracts";
import { startProcess } from "./process.ts";
export const opencodeVersion = "2.2.5";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const failure = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더 실행이 실패했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Provider request failed");
    this.status = status;
  }
}
export function createOpenCodeProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
}): ProviderConnection {
  const home = path.resolve(options.dataDir, "providers/opencode"),
    command = options.command ?? ["opencode"];
  const env = () => ({
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
  });
  const version = async (signal: AbortSignal) => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    // 2.2.5 CLI has no system-config override. Refuse rather than load machine policy/plugins.
    if (process.platform !== "linux")
      throw new Error("Unsupported configuration isolation");
    try {
      await lstat("/etc/opencode");
      throw new Error("System config present");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return (
      await promisify(execFile)(
        command[0],
        [...command.slice(1), "--version"],
        { cwd: home, env: env(), signal, timeout: 3000, maxBuffer: 65536 }
      )
    ).stdout.trim();
  };
  async function server(
    signal: AbortSignal,
    config: Record<string, unknown> = {}
  ) {
    const directory = await mkdtemp(path.join(home, "attempt-")),
      password = crypto.randomUUID();
    const lifetime = new AbortController();
    let interrupt: (() => void) | undefined;
    const abort = () => {
      if (interrupt) interrupt();
      else lifetime.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let resolveUrl!: (url: string) => void;
    const ready = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const child = startProcess({
      stateDir: home,
      command,
      args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: home,
      env: {
        ...env(),
        OPENCODE_CONFIG_DIR: directory,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_SERVER_PASSWORD: password,
      },
      onFrame: async (raw) => {
        const url = object(raw).url;
        if (typeof url === "string") {
          const parsed = new URL(url);
          if (parsed.hostname === "127.0.0.1" && parsed.protocol === "http:")
            resolveUrl(parsed.origin);
        }
      },
    });
    const stop = () => child.end();
    lifetime.signal.addEventListener("abort", stop, { once: true });
    if (lifetime.signal.aborted) stop();
    const timer = setTimeout(() => lifetime.abort(), 10000);
    const close = async () => {
      clearTimeout(timer);
      lifetime.abort();
      child.end();
      await child.done;
      signal.removeEventListener("abort", abort);
      await rm(directory, { recursive: true, force: true });
    };
    try {
      const base = await Promise.race([
        ready,
        child.done.then(() => {
          throw new Error("Provider closed");
        }),
        new Promise<never>((_, reject) =>
          lifetime.signal.addEventListener(
            "abort",
            () => reject(new Error("Provider stopped")),
            { once: true }
          )
        ),
      ]);
      clearTimeout(timer);
      const headers = {
        authorization:
          "Basic " + Buffer.from("opencode:" + password).toString("base64"),
        "content-type": "application/json",
      };
      const request = async (
        route: string,
        method = "GET",
        body?: unknown,
        timeout = 10000
      ) => {
        const response = await fetch(base + route, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal:
            timeout === 0
              ? lifetime.signal
              : AbortSignal.any([
                  lifetime.signal,
                  AbortSignal.timeout(timeout),
                ]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpFailure(response.status);
        }
        return response;
      };
      return {
        request,
        close,
        setInterrupt: (callback: () => void) => {
          interrupt = callback;
        },
        closed: child.done,
        lifetime,
        async json(route: string, method = "GET", body?: unknown) {
          const response = await request(route, method, body);
          return object(await response.json());
        },
      };
    } catch (e) {
      await close();
      throw e;
    }
  }
  const active = new Map<
    string,
    (message: SteerMessage) => Promise<SteerOutcome>
  >();
  const catalog = async (signal: AbortSignal) => {
    if ((await version(signal)) !== opencodeVersion)
      throw new Error("Unsupported version");
    const service = await server(signal);
    try {
      return await service.json("/api/model");
    } finally {
      await service.close();
    }
  };
  const models = (value: Record<string, unknown>) =>
    Array.isArray(value.data) ? value.data.map(object) : [];
  const adapter: ProviderConnection["adapter"] = {
    capabilities: {
      steer: true,
      resume: true,
      reinjectInstructionsOnResume: true,
      usageTokens: true,
      usageCost: true,
      precompact: false,
    },
    loginCommand: `HOME='${home.replaceAll("'", "'\\''")}' XDG_DATA_HOME='${path.join(home, "data").replaceAll("'", "'\\''")}' opencode auth login`,
    async checkReadiness(signal) {
      try {
        if ((await version(signal)) !== opencodeVersion)
          return { status: "not_ready", reason: "version_unsupported" };
        const listed = models(await catalog(signal));
        return listed.some(isFree)
          ? { status: "ready", reason: null }
          : { status: "unknown", reason: "credentials_unverified" };
      } catch (e) {
        return {
          status: "not_ready",
          reason:
            (e as NodeJS.ErrnoException).code === "ENOENT"
              ? "program_missing"
              : "check_failed",
        };
      }
    },
    async steer(message) {
      return active.get(message.runId)?.(message) ?? "rejected";
    },
    async execute(input, control) {
      let service: Awaited<ReturnType<typeof server>> | undefined,
        events: Promise<void> | undefined;
      try {
        if ((await version(control.signal)) !== opencodeVersion)
          return failure();
        // Instructions are attached separately; never set agent.system, which replaces the native prompt.
        const config = {
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          mcp: {
            servers: {
              organization: {
                type: "remote",
                url: new URL("/api/tools/mcp", input.access.toolsBaseUrl).href,
                headers: { Authorization: `Bearer ${input.access.token}` },
                oauth: false,
                codemode: false,
              },
            },
          },
        };
        service = await server(control.signal, config);
        const api = service;
        const available = models(await api.json("/api/model"));
        const selected = input.model
          ? available.find((m) => `${m.providerID}/${m.id}` === input.model)
          : available.find(isFree);
        if (!selected) return failure();
        let session: Record<string, unknown> | undefined;
        if (typeof input.previousSession?.id === "string") {
          try {
            session = object(
              (
                await api.json(
                  `/api/session/${encodeURIComponent(input.previousSession.id)}`
                )
              ).data
            );
          } catch (e) {
            if (!(e instanceof HttpFailure) || e.status !== 404) throw e;
            await control.emit({
              type: "progress",
              text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
            });
          }
        }
        const model = { providerID: selected.providerID, id: selected.id };
        if (!session)
          session = object(
            (
              await api.json("/api/session", "POST", {
                location: { directory: input.workspace?.cwd ?? home },
                agent: "build",
                model,
                permissions: [{ action: "*", resource: "*", effect: "allow" }],
              })
            ).data
          );
        else
          await api.request(
            `/api/session/${encodeURIComponent(String(session.id))}/model`,
            "POST",
            { model }
          );
        if (typeof session.id !== "string") return failure();
        const id = session.id,
          route = `/api/session/${encodeURIComponent(id)}`;
        await api.request(
          `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/babojubot`,
          "PUT",
          { value: input.instructions.map((file) => file.content).join("\n\n") }
        );
        const before = session;
        let began = false,
          finished = false,
          success = false;
        let end!: () => void;
        const ended = new Promise<void>((resolve) => {
          end = resolve;
        });
        const stream = await api.request("/api/event", "GET", undefined, 0);
        if (!stream.body) throw new Error("No event stream");
        events = (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of stream.body!) {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > 4 * 1024 * 1024) throw new Error("Event limit");
            let split: number;
            while ((split = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              const data = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              const event = object(JSON.parse(data)),
                payload = object(event.data);
              if (payload.sessionID !== id) continue;
              if (event.type === "session.execution.started") {
                began = true;
                await control.emit({
                  type: "progress",
                  text: "프로바이더가 작업을 시작했습니다.",
                });
              }
              if (
                began &&
                [
                  "session.execution.succeeded",
                  "session.execution.failed",
                  "session.execution.interrupted",
                ].includes(String(event.type))
              ) {
                finished = true;
                success = event.type === "session.execution.succeeded";
                end();
                return;
              }
            }
          }
          throw new Error("Event stream ended");
        })();
        // Attach a handler immediately: a disconnected stream is a failed attempt, never a false success.
        void events.catch(() => end());
        active.set(input.identity.runId, async (message) => {
          if (!began || finished || control.signal.aborted) return "rejected";
          try {
            await api.request(route + "/prompt", "POST", {
              text: message.body,
              delivery: "steer",
            });
            return "accepted";
          } catch (e) {
            if (e instanceof HttpFailure && e.status >= 400 && e.status < 500)
              return "rejected";
            throw e;
          }
        });
        const cancel = () => {
          void api
            .request(route + "/interrupt", "POST", undefined, 1500)
            .catch(() => {})
            .finally(() => api.lifetime.abort());
        };
        // Server lifetime uses a separate signal below so interrupt can be sent before escalation.
        api.setInterrupt(cancel);
        if (control.signal.aborted) cancel();
        try {
          await api.request(route + "/prompt", "POST", {
            text: JSON.stringify({
              identity: input.identity,
              context: input.context,
              wakeReasons: input.wakeReasons,
            }),
          });
          await Promise.race([ended, api.closed, events]);
          if (control.signal.aborted)
            return { ...failure(), stopReason: "cancelled", error: null };
          if (!finished || !success) return failure();
          const after = object((await api.json(route)).data);
          return {
            stopReason: "completed",
            error: null,
            summary: null,
            usage: sessionUsage(before, after),
            nextSession: { id },
          };
        } finally {
          api.setInterrupt(() => api.lifetime.abort());
        }
      } catch {
        return control.signal.aborted
          ? { ...failure(), stopReason: "cancelled", error: null }
          : failure();
      } finally {
        active.delete(input.identity.runId);
        await service?.close();
        await events?.catch(() => {});
      }
    },
  };
  return {
    id: "opencode",
    label: "OpenCode",
    adapter,
    models: [],
    async listModels(signal) {
      return models(await catalog(signal)).flatMap((m) =>
        typeof m.id === "string" && typeof m.providerID === "string"
          ? [
              {
                id: `${m.providerID}/${m.id}`,
                label: typeof m.name === "string" ? m.name : m.id,
              },
            ]
          : []
      );
    },
  };
}
function isFree(model: Record<string, unknown>) {
  return (
    Array.isArray(model.cost) &&
    model.cost.length > 0 &&
    model.cost.every(
      (item) => object(item).input === 0 && object(item).output === 0
    )
  );
}
function sessionUsage(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Usage {
  const b = object(before.tokens),
    a = object(after.tokens),
    bc = object(b.cache),
    ac = object(a.cache);
  const delta = (a: unknown, b: unknown) =>
    count(a) === null ? null : Math.max(0, (a as number) - (count(b) ?? 0));
  return {
    inputTokens: delta(a.input, b.input),
    outputTokens: delta(a.output, b.output),
    cacheReadTokens: delta(ac.read, bc.read),
    cacheWriteTokens: delta(ac.write, bc.write),
    costUsd: delta(after.cost, before.cost),
  };
}
