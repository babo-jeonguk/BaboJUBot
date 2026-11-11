import { mkdir, mkdtemp, rm, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProviderConnection,
  RunResult,
  Usage,
  SteerMessage,
  SteerOutcome,
} from "@babojubot/contracts";
import {
  callKeyRequiredHeader,
  subtractUsage,
  usageAmount,
} from "@babojubot/contracts";
import { organizationKeysPluginSource } from "./opencode-keys-plugin.ts";
import type { UsageUnit } from "@babojubot/contracts";
import { providerUsage } from "./usage.ts";
import {
  startProcess,
  probeTimeoutMs,
  startupLimitMs,
  commandFor,
  providerEnvironment,
  runProbe,
} from "./process.ts";
import type { ContainerSettings } from "./container.ts";
import {
  ContainerRefusal,
  placeAttempt,
  type ContainerLaunch,
} from "./container.ts";
import { providerDestinations } from "./destinations.ts";
import { connectionFolders } from "./folders.ts";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const failure = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더 실행이 실패했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
/**
 * 2.2.6 `session.execution.failed`의 `data.error`(type·선택 status)를 공개할 수 있는 종료 결과로 바꾼다.
 * 원문 `message`·`response.body`는 모델 서비스의 응답·연구 내용·비밀값을 담을 수 있어 옮기지 않고, 제품이 쓴 문구만 쓴다.
 * 요청 거부와 명시적 인증 실패만 구분하며, 그 밖의 종류와 모양이 맞지 않는 값은 일반 실패다.
 */
function failedExecution(error: unknown): RunResult {
  const { type, status } = object(error);
  const http =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? `(HTTP ${status})`
      : "";
  if (type === "provider.invalid-request")
    return {
      ...failure(),
      error: `모델 서비스가 요청을 거부했습니다${http}. 도구 정의나 입력이 이 모델과 맞지 않을 수 있습니다.`,
    };
  if (type === "provider.auth")
    return {
      ...failure(),
      error: `모델 서비스가 인증을 거부했습니다${http}. 프로바이더 로그인을 확인해 주세요.`,
      errorCode: "login_required",
    };
  return failure();
}
class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Provider request failed");
    this.status = status;
  }
}
/** 서버 요청의 응답 제한. 모델 목록은 실제로 몇 초씩 걸린다. */
const requestTimeoutMs = 60_000;
/** 끼워 넣기 응답 제한. */
const steerTimeoutMs = 10_000;
/** 이보다 큰 이벤트는 메모리를 지키려고 버린다. */
const maxEventLength = 64 * 1024 * 1024;
export function createOpenCodeProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
}): ProviderConnection {
  const connectionId = options.id ?? "opencode";
  const folders = connectionFolders(options.dataDir, connectionId);
  const home = folders.connection,
    command = options.command ?? commandFor(connectionId, "opencode");
  /** 그 제품 폴더로 띄우는 환경. 로그인과 세션은 그 폴더의 DB 하나에 함께 있다. */
  const env = (productHome = home) =>
    providerEnvironment(connectionId, productHome, {
      XDG_CONFIG_HOME: path.join(productHome, "config"),
      XDG_DATA_HOME: path.join(productHome, "data"),
      XDG_CACHE_HOME: path.join(productHome, "cache"),
      XDG_STATE_HOME: path.join(productHome, "state"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
    });
  let warnedSystemConfig = false;
  const prepare = async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (warnedSystemConfig) return;
    // 이 프로그램은 시스템 설정을 끌 방법이 없다. 막지 않고 알린다.
    try {
      await lstat("/etc/opencode");
      warnedSystemConfig = true;
      console.warn(
        "[provider] /etc/opencode exists; OpenCode will also read this machine's system configuration"
      );
    } catch {
      /* 시스템 설정이 없다. */
    }
  };
  const startups = new Map<string, Promise<void>>();
  /**
   * 같은 제품 폴더의 서버는 하나씩 띄운다. 새 폴더에 서버 둘이 함께 뜨면 그 폴더의 DB를 함께 만들다 하나가 끝난다
   * (2.2.6 실제 CLI 확인: `table … already exists`, #147). 띄우는 동안만 차례를 지키며, 띄운 서버의 실행은 함께 돈다.
   * 차례를 기다리다 취소되면 기다림을 그만두고 차례를 넘긴다.
   */
  const startupTurn = async (folder: string, signal: AbortSignal) => {
    const previous = startups.get(folder) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = previous.then(() => done);
    startups.set(folder, turn);
    void turn.then(() => {
      if (startups.get(folder) === turn) startups.delete(folder);
    });
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("Provider stopped"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (e) {
      release();
      throw e;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    return release;
  };
  async function server(
    signal: AbortSignal,
    config: Record<string, unknown> = {},
    container?: ContainerLaunch,
    productHome = home
  ) {
    const release = await startupTurn(productHome, signal);
    try {
      return await launch(signal, config, container, productHome);
    } finally {
      release();
    }
  }
  /** 서버 하나를 띄워 첫 응답(주소)까지 기다린다. */
  async function launch(
    signal: AbortSignal,
    config: Record<string, unknown>,
    container: ContainerLaunch | undefined,
    productHome: string
  ) {
    const directory = await mkdtemp(path.join(productHome, "attempt-")),
      password = crypto.randomUUID();
    // 조직 도구 호출마다 같은 호출 키를 넣는 plugin. 설정 폴더의 `plugins/`는 OpenCode가 스스로 읽는다.
    await mkdir(path.join(directory, "plugins"), { mode: 0o700 });
    await writeFile(
      path.join(directory, "plugins", "babojubot-organization-keys.js"),
      organizationKeysPluginSource,
      { mode: 0o600 }
    );
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
      // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
      stateDir: home,
      command,
      args: container
        ? ["serve", "--stdio", "--hostname", "0.0.0.0", "--port", "4096"]
        : ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: productHome,
      env: {
        ...env(productHome),
        OPENCODE_CONFIG_DIR: directory,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_SERVER_PASSWORD: password,
      },
      ...(container ? { container } : {}),
      onFrame: async (raw) => {
        const url = object(raw).url;
        if (typeof url === "string") {
          if (container) {
            // 컨테이너에는 네트워크가 없다. 컨테이너 안 서버는 중계가 이 컴퓨터 loopback에 연 주소로만 제어한다(비밀번호 인증 유지).
            let parsed: URL | undefined;
            try {
              parsed = new URL(url);
            } catch {
              parsed = undefined;
            }
            if (parsed?.protocol === "http:") {
              try {
                resolveUrl(await child.inboundOrigin());
              } catch {
                lifetime.abort();
              }
            }
          } else {
            const parsed = new URL(url);
            if (parsed.hostname === "127.0.0.1" && parsed.protocol === "http:")
              resolveUrl(parsed.origin);
          }
        }
      },
    });
    const stop = () => child.end();
    lifetime.signal.addEventListener("abort", stop, { once: true });
    if (lifetime.signal.aborted) stop();
    const timer = setTimeout(() => lifetime.abort(), startupLimitMs);
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
        timeout = requestTimeoutMs
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
    await prepare();
    const service = await server(signal);
    try {
      return await service.json("/api/model");
    } finally {
      await service.close();
    }
  };
  /** 서버 응답의 `data` 목록. */
  const entries = (value: Record<string, unknown>) =>
    Array.isArray(value.data) ? value.data.map(object) : [];
  const models = entries;
  /**
   * 조직 폴더에 로그인이 하나도 없으면 연결의 로그인을 옮겨 넣는다. `auth import`와 같은 규칙으로 같은 ID는 건너뛰고, 세션은 옮기지 않는다.
   * 실행 중인 서버는 넣은 로그인을 바로 쓴다(2.2.5 확인). 옮기지 못하면(로그인 목록을 주지 않는 판, 이 컴퓨터에 프로그램이 없음 등) 건너뛰고 그대로 돈다.
   */
  const copyLogin = async (
    target: Awaited<ReturnType<typeof server>>,
    signal: AbortSignal
  ) => {
    let source: Awaited<ReturnType<typeof server>> | undefined;
    try {
      if (entries(await target.json("/api/credential")).length) return;
      source = await server(signal);
      for (const credential of entries(await source.json("/api/credential")))
        await target
          .request("/api/credential", "POST", {
            id: credential.id,
            integrationID: credential.integrationID,
            label: credential.label,
            value: credential.value,
            activate: credential.active === true,
          })
          .catch((e: unknown) => {
            if (!(e instanceof HttpFailure && e.status === 409)) throw e;
          });
    } catch {
      // 옮기지 못해도 실행은 그대로 한다. 무료 모델은 로그인 없이 돌고, 로그인이 필요하면 실행 시도가 로그인 필요로 드러난다. 중단은 다음 단계가 처리한다.
    } finally {
      await source?.close();
    }
  };

  const adapter: ProviderConnection["adapter"] = {
    capabilities: {
      steer: true,
      resume: true,
      reinjectInstructionsOnResume: true,
      usageTokens: true,
      usageCost: true,
      precompact: false,
    },
    loginCommand: `pnpm provider:login ${connectionId}`,
    async checkReadiness(signal) {
      try {
        await prepare();
        // 프로그램이 있는지만 본다. 어떤 판이든 실제로 동작하면 쓴다.
        await runProbe(command, ["--version"], {
          cwd: home,
          env: env(),
          signal,
          timeout: probeTimeoutMs,
          maxBuffer: 65536,
        });
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
        // 그 조직의 제품 폴더로 돈다.
        const organization = folders.organization(
          input.identity.organizationId
        );
        const placement = placeAttempt(options.container, organization, input);
        if (!placement) return failure();
        await prepare();
        await mkdir(organization, { recursive: true, mode: 0o700 });
        let container: ContainerLaunch | undefined;
        try {
          container = placement.container?.({
            cwd: organization,
            program: "opencode",
            destinations: providerDestinations.opencode,
            // 이 컴퓨터가 컨테이너 안 OpenCode 서버를 중계의 역방향 연결로 부른다.
            inbound: 4096,
          });
        } catch (error) {
          if (error instanceof ContainerRefusal)
            return { ...failure(), error: error.message };
          throw error;
        }
        // Instructions are attached separately; never set agent.system, which replaces the native prompt.
        const config = {
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          mcp: {
            servers: {
              organization: {
                type: "remote",
                url: new URL("/api/tools/mcp", input.access.toolsBaseUrl).href,
                headers: {
                  Authorization: `Bearer ${input.access.token}`,
                  // 쓰기 도구는 plugin이 넣는 호출 키 없이는 거부된다(키 없는 쓰기로 우회하지 않음).
                  [callKeyRequiredHeader]: "required",
                },
                oauth: false,
                codemode: false,
              },
            },
          },
        };
        service = await server(control.signal, config, container, organization);
        const api = service;
        await copyLogin(api, control.signal);
        const available = models(await api.json("/api/model"));
        // 비용이 들지 않도록 무료 모델을 먼저 고른다. 무료 모델이 없으면 그 연결이 제공하는 첫 모델을 쓴다.
        const selected = input.model
          ? available.find((m) => `${m.providerID}/${m.id}` === input.model)
          : (available.find(isFree) ?? available[0]);
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
            // 없는 세션도, 받아들이지 않는 세션도 새 세션으로 시작한다. 로그인 오류와 서버 오류는 세션 문제가 아니다.
            if (
              !(e instanceof HttpFailure) ||
              e.status < 400 ||
              e.status >= 500 ||
              e.status === 401 ||
              e.status === 403
            )
              throw e;
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
                location: { directory: input.workspace?.cwd ?? organization },
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
          success = false,
          failedError: unknown;
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
            if (buffer.length > maxEventLength) buffer = "";
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const block = buffer.slice(0, boundary.index);
              buffer = buffer.slice(boundary.index + boundary[0].length);
              const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              let event: Record<string, unknown>;
              try {
                event = object(JSON.parse(data));
              } catch {
                continue;
              }
              const payload = object(event.data);
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
                if (event.type === "session.execution.failed")
                  failedError = payload.error;
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
            await api.request(
              route + "/prompt",
              "POST",
              {
                text: message.body,
                delivery: "steer",
              },
              steerTimeoutMs
            );
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
          if (!finished) return failure();
          // 실패를 같은 요청으로 다시 보내지 않는다. 요청 거부는 다시 보내도 거부된다.
          if (!success) return failedExecution(failedError);
          const after = object((await api.json(route)).data);
          return {
            stopReason: "completed",
            error: null,
            summary: null,
            usage: sessionUsage(connectionId, before, after),
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
    id: connectionId,
    label: options.label ?? "OpenCode",
    isolatable: true,
    login: { command, args: ["auth", "login"], env: env() },
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
/**
 * 실행 전·후 세션 누계의 차이. 실행 후 값이 없으면 보고 안 됨이고, 실행 전 값이 보고 안 됐으면 0으로 본다(새 세션).
 * 잘못된 값과 줄어든 누계는 그 항목만 비운다.
 */
function sessionUsage(
  provider: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Usage {
  const b = object(before.tokens),
    a = object(after.tokens),
    bc = object(b.cache),
    ac = object(a.cache);
  const delta = (unit: UsageUnit, a: unknown, b: unknown) =>
    subtractUsage(unit, usageAmount(unit, a), usageAmount(unit, b) ?? 0);
  return providerUsage(provider, {
    inputTokens: delta("tokens", a.input, b.input),
    outputTokens: delta("tokens", a.output, b.output),
    cacheReadTokens: delta("tokens", ac.read, bc.read),
    cacheWriteTokens: delta("tokens", ac.write, bc.write),
    costUsd: delta("usd", after.cost, before.cost),
  });
}
