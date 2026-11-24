import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderConnection, RunResult } from "@babojubot/contracts";
import {
  continueAfterFailure,
  failureCode,
  hasErrorCode,
  orIfMissing,
  orIfUnreadable,
  usageAmount,
} from "@babojubot/contracts";
import { providerUsage } from "./usage.ts";
import { TreeLaunchRefused } from "@babojubot/process";
import {
  startProcess,
  probeTimeoutMs,
  startupLimitMs,
  commandFor,
  providerEnvironment,
  runProbe,
  saysLoginProblem,
} from "./process.ts";
import {
  clearOwnedConfig,
  ConfigNotCleared,
  describeCleanup,
} from "./antigravity-config.ts";
import { readRegularFile } from "./regular-file.ts";
import type { ContainerSettings } from "./container.ts";
import {
  ContainerRefusal,
  placeAttempt,
  type ContainerLaunch,
} from "./container.ts";
import {
  createCredentialRelay,
  type RelayGrant,
  type RelayProfile,
} from "./credential-relay.ts";
import { providerDestinations } from "./destinations.ts";
import { fileLogin } from "./file-login.ts";
import { record } from "./record.ts";
import { removeAttemptFolder } from "./attempt-folder.ts";
/** 프로그램이 JSON-RPC 오류로 거절한 요청. */
class AcpRejection extends Error {}
/** 취소를 알린 뒤 프로그램이 스스로 멈추기를 기다리는 한도. */
const cancelGraceMs = 3_000;
const relayFailure =
  "인증 중계가 연결의 로그인을 쓰지 못해 실행을 끝냈습니다. 로그인을 확인한 뒤 다시 실행하세요.";
/**
 * Antigravity의 인증 중계(#148). `agy acp`의 Code Assist 호출(`CLOUD_CODE_URL`)을 중계로 보내고, 중계가 실행 시도의 권한을
 * 연결의 접근 토큰으로 바꿔 넣는다. 상류는 주소를 바꾸지 않은 agy가 부르는 곳이다(1.5.4 합성 확인, 실제 호스트 미확인).
 * 로그인 확인(www.googleapis.com)·사용 기록은 중계로 보낼 수 없고, ACP에서는 실패해도 실행이 이어진다.
 */
export const antigravityRelayProfile: RelayProfile = {
  upstream: "https://daily-cloudcode-pa.googleapis.com",
  routes: [
    "loadCodeAssist",
    "onboardUser",
    "fetchAvailableModels",
    "retrieveUserQuotaSummary",
    "fetchUserInfo",
    "fetchAdminControls",
    "listExperiments",
    "writeTrajectoryAcls",
    "streamGenerateContent",
  ].map((method) => ({ method: "POST", path: `/v1internal:${method}` })),
  authorize: (accessToken) => ({
    headers: { authorization: `Bearer ${accessToken}` },
    secrets: [accessToken],
  }),
};
/** 컨테이너에 넣는 로그인의 만료 시각. 실제 로그인에는 없는 값이라 이 어댑터가 둔 파일을 알아본다. 이 시각이 멀어 agy가 갱신하지 않는다. */
const relayExpiry = "2099-01-01T00:00:00Z";
/** 컨테이너에 넣는 가짜 로그인. 갱신 값이 없다. 권한이 빈 것은 조직 폴더의 자리 표시다. */
const relayToken = (accessToken: string) => ({
  token: {
    access_token: accessToken,
    token_type: "Bearer",
    expiry: relayExpiry,
  },
  auth_method: "consumer",
});
/** 이 어댑터가 둔 가짜 로그인(자리 표시)인가. */
async function isRelayToken(file: string): Promise<boolean> {
  const text = await readRegularFile(file);
  if (text === undefined) return false;
  const login = orIfUnreadable(() => record(JSON.parse(text)), undefined);
  if (!login) return false;
  const token = record(login.token);
  return (
    token.expiry === relayExpiry &&
    (token.refresh_token === undefined || token.refresh_token === "")
  );
}
/** 갱신을 서두르는 여유. 만료가 이보다 가까우면 쓰기 전에 갱신한다. */
const refreshWindowMs = 10 * 60 * 1000;
/** 원본 로그인의 접근 토큰. 곧 끝나면 `undefined`가 아니라 `expiring`이 참이다. */
function accessOf(text: string): { token?: string; expiring: boolean } {
  const token = orIfUnreadable(
    () => record(record(JSON.parse(text)).token),
    undefined
  );
  if (!token) return { expiring: false };
  const access =
    typeof token.access_token === "string" && token.access_token
      ? token.access_token
      : undefined;
  const expiry =
    typeof token.expiry === "string" ? Date.parse(token.expiry) : Number.NaN;
  return {
    token: access,
    expiring: Number.isFinite(expiry) && expiry - Date.now() <= refreshWindowMs,
  };
}
/** ACP `session/prompt` 결과의 사용량. 입력은 이미 캐시 읽기를 뺀 값이다(1.5.4). */
function promptUsage(connectionId: string, raw: unknown) {
  const usage = record(raw);
  return providerUsage(connectionId, {
    inputTokens: usageAmount("tokens", usage.inputTokens),
    outputTokens: usageAmount("tokens", usage.outputTokens),
    cacheReadTokens: usageAmount("tokens", usage.cachedReadTokens),
    cacheWriteTokens: usageAmount("tokens", usage.cachedWriteTokens),
  });
}

const failure = (error = "프로바이더를 실행하지 못했습니다."): RunResult => ({
  stopReason: "failed",
  error,
  summary: null,
  usage: null,
  nextSession: null,
});
/** Called before admission on server startup. Unowned files are left for execute to report. */
export async function cleanupAntigravityWorkspaces(dataDir: string) {
  const organizations = path.join(dataDir, "organizations");
  const entries =
    (await continueAfterFailure(
      () =>
        orIfMissing(
          () => readdir(organizations, { withFileTypes: true }),
          hasErrorCode("ENOENT"),
          []
        ),
      (error) =>
        console.warn(
          `[provider] the organization folders could not be listed; Antigravity configuration is not cleared at this start (${failureCode(error)})`
        )
    )) ?? [];
  for (const org of entries) {
    if (!org.isDirectory()) continue;
    const shared = path.join(organizations, org.name, "shared");
    // 정리는 조직마다 별도 프로세스를 띄운다. 설정 폴더가 없으면 지울 것이 없으므로 띄우지 않는다.
    if (await missing(path.join(shared, ".agents"))) continue;
    await continueAfterFailure(
      () => clearOwnedConfig(shared),
      (error) =>
        console.warn(
          `[provider] the Antigravity configuration of organization ${org.name} could not be cleared; unowned files are kept (${error instanceof ConfigNotCleared ? describeCleanup(error.reasons) : failureCode(error)})`
        )
    );
  }
}
const missing = (file: string) =>
  lstat(file).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
export function createAntigravityProvider(options: {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
  /** 인증 중계 설정. 시험·합성 검증이 상류를 바꾸고 검증 여부를 정한다. 제품은 기본값(공식 상류, 검증됨: 2026-11-12 실제 구독으로 확인)을 쓴다. */
  relay?: { upstream?: string; verified?: boolean };
}): ProviderConnection {
  const connectionId = options.id ?? "antigravity";
  const command = options.command ?? commandFor(connectionId, "agy");
  // 연결의 로그인 하나를 모든 조직이 같이 쓰고, 격리 실행에는 권한만 든 실행 시도 전용 로그인을 넣는다(#146·#148).
  // 키링이 없는 컴퓨터·컨테이너에서 agy는 HOME의 이 파일로 로그인하고, 갱신하면 링크를 따라 원본 자리에 덮어쓴다(1.5.3 실측, #126).
  const login = fileLogin(options.dataDir, connectionId, {
    label: "Antigravity",
    loginFile: path.join(
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token"
    ),
    contents: (token) => JSON.stringify(relayToken(token)),
    isStandIn: isRelayToken,
  });
  const { home } = login;
  const env = (productHome = home, isolated = false) =>
    providerEnvironment(
      connectionId,
      productHome,
      {
        XDG_CONFIG_HOME: path.join(productHome, "config"),
        XDG_DATA_HOME: path.join(productHome, "data"),
        XDG_CACHE_HOME: path.join(productHome, "cache"),
      },
      { isolated }
    );
  const probe = async (args: string[], signal: AbortSignal) => {
    return (
      await runProbe(command, args, {
        cwd: home,
        env: env(),
        signal,
        timeout: probeTimeoutMs,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  };
  let refreshing: Promise<void> | undefined;
  /**
   * 연결의 로그인을 이 컴퓨터의 agy로 갱신한다(#148). `agy models`는 만료된 로그인을 갱신해 연결 폴더의 링크를 따라 원본 자리에 쓴다
   * (1.5.4 합성 확인). 링크를 만들 수 없는 컴퓨터면 연결 폴더 자리의 보통 파일에 덮어쓴다(1.5.9 실행 확인, #209). 연결마다 한 번에 하나만 하고, 그동안 온 요청은 같은 갱신을 기다린다.
   */
  const refreshLogin = () =>
    (refreshing ??= (async () => {
      await login.prepareConnection();
      await continueAfterFailure(
        () => probe(["models"], AbortSignal.timeout(probeTimeoutMs)),
        (error) =>
          console.warn(
            `[provider] the Antigravity login refresh failed; the next read decides (${failureCode(error)})`
          )
      );
    })().finally(() => {
      refreshing = undefined;
    }));
  /**
   * 중계가 쓸 연결의 접근 토큰. 이 컴퓨터의 실행이 읽는 자리를 읽는다(#209). 곧 끝나면 먼저 갱신하고, 갱신한 뒤에도 끝나 가면
   * 갱신 실패로 던진다(중계 실패, Q6).
   */
  const currentAccess = async () => {
    let current = accessOf(await login.read());
    if (current.expiring) {
      await refreshLogin();
      current = accessOf(await login.read());
      if (current.expiring) throw new Error("login refresh failed");
    }
    return current.token;
  };
  const relay = createCredentialRelay({
    profile: {
      ...antigravityRelayProfile,
      upstream: options.relay?.upstream ?? antigravityRelayProfile.upstream,
    },
    verified: options.relay?.verified ?? true,
    credential: () => currentAccess(),
  });
  const adapter: ProviderConnection["adapter"] = {
    capabilities: {
      steer: false,
      resume: true,
      reinjectInstructionsOnResume: true,
      usageTokens: true,
      usageCost: false,
      precompact: false,
    },
    loginCommand: `pnpm provider:login ${connectionId}`,
    async checkReadiness(signal) {
      const checked = await continueAfterFailure(
        async () => {
          await login.prepareConnection();
          // 실행이 읽는 로그인(링크면 원본, 링크를 만들 수 없는 컴퓨터면 연결 폴더의 파일)을 다시 쓰지 못하면 조직 실행이 낡은 로그인을 읽는다. 없으면(키링에 둔 로그인 등) 프로그램의 응답으로 판단한다.
          // Windows의 access는 링크를 따라가지 않으므로 실제 파일을 찾아 본다.
          const file = await realpath(login.loginFileIn(home)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            }
          );
          if (file) await access(file, constants.R_OK | constants.W_OK);
          return true;
        },
        (error) =>
          console.warn(
            `[provider] the Antigravity login check failed (${failureCode(error)})`
          )
      );
      if (!checked) return { status: "not_ready", reason: "check_failed" };
      // 로그인이 맞는지는 프로그램의 응답으로 판단한다. 목록 조회는 모델을 부르지 않는다.
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
          reason: saysLoginProblem(`${error.stdout ?? ""}${error.stderr ?? ""}`)
            ? "product_login_missing"
            : "check_failed",
        };
      }
    },
    async execute(request, control) {
      let grant: RelayGrant | undefined,
        attempt: string | undefined,
        logs: string | undefined;
      try {
        if (control.signal.aborted)
          return { ...failure(), stopReason: "cancelled", error: null };
        // 그 조직의 제품 폴더로 돈다. 로그인은 연결의 원본 하나를 같이 쓴다.
        const isolated = request.execution === "container";
        const prepared = await login.prepare(
          request.identity.organizationId,
          isolated
        );
        if (prepared.refusal !== undefined) return failure(prepared.refusal);
        const productHome = prepared.home;
        const placement = placeAttempt(options.container, productHome, request);
        if (!placement) return failure();
        const cwd = await realpath(request.workspace?.cwd ?? productHome);
        let container: ContainerLaunch | undefined;
        if (placement.container && prepared.attemptLogin) {
          grant = continueAfterFailure(
            () =>
              relay.grant({
                signal: control.signal,
                organizationId: request.identity.organizationId,
                runId: request.identity.runId,
              }),
            (error) =>
              console.warn(
                `[provider] the isolated run relay refused a grant (${failureCode(error)})`
              )
          );
          if (!grant) return failure(relayFailure);
          attempt = await mkdtemp(path.join(os.tmpdir(), "babojubot-attempt-"));
          const file = await prepared.attemptLogin(attempt, grant.token);
          try {
            container = placement.container({
              cwd,
              program: "agy",
              destinations: providerDestinations.antigravity,
              files: [file],
            });
          } catch (error) {
            if (error instanceof ContainerRefusal)
              return failure(error.message);
            throw error;
          }
        } else
          logs = await mkdtemp(path.join(os.tmpdir(), "babojubot-agy-log-"));
        const runControl = grant
          ? {
              ...control,
              signal: AbortSignal.any([control.signal, grant.failed]),
            }
          : control;
        const relayBase = new URL(
          `/api/relay/${encodeURIComponent(connectionId)}`,
          request.access.toolsBaseUrl
        ).href;
        const logFile = logs ? path.join(logs, "agy.log") : undefined;
        const args = [
          "acp",
          "--disable-telemetry",
          "--dangerously-skip-permissions",
          ...(logFile ? ["--log-file", logFile] : []),
        ];
        // 조직 도구는 세션을 열 때 이 실행 시도에만 준다. 작업 폴더에 토큰이 든 설정 파일을 두지 않는다.
        const mcpServers = [
          {
            type: "http",
            name: "organization",
            url: new URL("/api/tools/mcp", request.access.toolsBaseUrl).href,
            headers: [
              {
                name: "Authorization",
                value: `Bearer ${request.access.token}`,
              },
            ],
          },
        ];
        const previous =
          typeof request.previousSession?.id === "string"
            ? request.previousSession.id
            : null;
        let sequence = 0,
          sessionId: string | undefined,
          prompting = false,
          errored = false;
        const pending = new Map<
          number,
          {
            resolve: (value: Record<string, unknown>) => void;
            reject: (error: Error) => void;
          }
        >();
        // 준비가 끝난 뒤 프로세스를 띄우기 직전에 취소를 다시 본다. 준비 중에 취소됐으면 띄우지 않는다.
        if (control.signal.aborted)
          return { ...failure(), stopReason: "cancelled", error: null };
        if (grant?.failed.aborted) return failure(relayFailure);
        const child = startProcess({
          // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
          stateDir: home,
          command,
          args,
          cwd,
          env: {
            ...env(productHome, isolated),
            ...(grant
              ? {
                  // 모델 통신(Code Assist)을 인증 중계로 보낸다. 컨테이너에는 바깥으로 직접 나가는 길이 없다.
                  CLOUD_CODE_URL: relayBase,
                  AGY_CLI_DISABLE_AUTO_UPDATE: "1",
                }
              : {}),
          },
          container,
          onFrame: async (raw) => {
            const frame = record(raw);
            if (typeof frame.id === "number" && !frame.method) {
              const waiter = pending.get(frame.id);
              if (!waiter) return;
              pending.delete(frame.id);
              if (frame.error)
                waiter.reject(
                  new AcpRejection(String(record(frame.error).message ?? ""))
                );
              else waiter.resolve(record(frame.result));
              return;
            }
            // 명령 허락을 묻지 않게 띄우지만, 물으면 이 실행 시도의 결정대로 허락한다.
            if (frame.method === "session/request_permission") {
              const options = Array.isArray(record(frame.params).options)
                ? (record(frame.params).options as unknown[]).map(record)
                : [];
              const allow = options.find((option) =>
                String(option.kind).startsWith("allow")
              );
              child.write({
                jsonrpc: "2.0",
                id: frame.id,
                result: {
                  outcome: allow
                    ? { outcome: "selected", optionId: allow.optionId }
                    : { outcome: "cancelled" },
                },
              });
              return;
            }
            const params = record(frame.params);
            // 불러온 세션의 지난 대화는 본 요청 전에 다시 온다. 본 요청 뒤의 갱신만 본다.
            if (
              frame.method !== "session/update" ||
              !prompting ||
              params.sessionId !== sessionId
            )
              return;
            const update = record(params.update);
            // 실제 프로그램(1.5.4)은 실행 오류를 실패 종료로 알리지 않고 이 문구와 end_turn만 보낸다.
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              String(record(update.content).text ?? "").includes(
                "Agent execution terminated due to error"
              )
            )
              errored = true;
          },
        });
        void child.done.then(() => {
          for (const waiter of pending.values())
            waiter.reject(new Error("Protocol closed"));
          pending.clear();
        });
        const rpc = (method: string, params: unknown) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            if (!child.write({ jsonrpc: "2.0", id, method, params })) {
              pending.delete(id);
              reject(new Error("Protocol closed"));
            }
          });
        const startup = setTimeout(() => child.end(), startupLimitMs);
        let ending: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => {
          // 진행 중인 요청을 프로그램에 멈추게 하고, 멈추지 않으면 끝낸다.
          if (sessionId && prompting) {
            child.write({
              jsonrpc: "2.0",
              method: "session/cancel",
              params: { sessionId },
            });
            ending ??= setTimeout(() => child.end(), cancelGraceMs);
          } else child.end();
        };
        runControl.signal.addEventListener("abort", cancel, { once: true });
        let outcome: Record<string, unknown> | undefined,
          sessionError: string | undefined;
        try {
          if (runControl.signal.aborted) cancel();
          else {
            await rpc("initialize", {
              protocolVersion: 1,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
              clientInfo: { name: "babojubot", version: "0.0.0" },
            });
            if (previous)
              try {
                await rpc("session/load", {
                  sessionId: previous,
                  cwd,
                  mcpServers,
                });
                sessionId = previous;
              } catch (error) {
                if (!(error instanceof AcpRejection)) throw error;
                if (saysLoginProblem(error.message)) {
                  sessionError = error.message;
                  throw error;
                }
                // 문구에 기대지 않는다. 프로그램이 그 세션을 열지 못하면 새 세션으로 시작한다.
                await runControl.emit({
                  type: "progress",
                  text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
                });
              }
            if (!sessionId)
              try {
                const opened = await rpc("session/new", { cwd, mcpServers });
                sessionId = String(opened.sessionId);
              } catch (error) {
                if (error instanceof AcpRejection) sessionError = error.message;
                throw error;
              }
            clearTimeout(startup);
            // 고른 모델을 쓰지 못하면 프로그램은 기본 모델로 그냥 돈다(1.5.4). 다른 모델로 돌지 않게 실패로 끝낸다.
            if (request.model)
              try {
                await rpc("session/set_model", {
                  sessionId,
                  modelId: request.model,
                });
              } catch (error) {
                if (error instanceof AcpRejection) {
                  child.end();
                  await child.done;
                  return failure("고른 모델을 쓸 수 없어 실행하지 않았습니다.");
                }
                throw error;
              }
            await runControl.emit({
              type: "progress",
              text: "프로바이더가 작업을 시작했습니다.",
            });
            prompting = true;
            if (runControl.signal.aborted) cancel();
            outcome = await rpc("session/prompt", {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text:
                    request.instructions.map((f) => f.content).join("\n\n") +
                    "\n\n" +
                    JSON.stringify({
                      identity: request.identity,
                      context: request.context,
                      wakeReasons: request.wakeReasons,
                    }),
                },
              ],
            });
          }
        } catch (error) {
          if (!runControl.signal.aborted)
            console.warn(
              `[provider] the Antigravity session ended without a result (${failureCode(error)})`
            );
          /* 결과 없이 끝났다. 아래에서 끝난 방식으로 정한다. */
        } finally {
          clearTimeout(startup);
          child.end();
          await child.done;
          clearTimeout(ending);
          runControl.signal.removeEventListener("abort", cancel);
        }
        const usage = outcome?.usage
          ? promptUsage(connectionId, outcome.usage)
          : null;
        if (control.signal.aborted)
          return { ...failure(), stopReason: "cancelled", error: null, usage };
        if (grant?.failed.aborted) return { ...failure(relayFailure), usage };
        if (sessionError !== undefined && saysLoginProblem(sessionError))
          return { ...failure(), errorCode: "login_required" };
        if (outcome?.stopReason === "end_turn" && !errored && sessionId)
          return {
            stopReason: "completed",
            error: null,
            summary: null,
            usage,
            nextSession: { id: sessionId },
          };
        const result: RunResult = {
          ...failure(),
          error: "프로바이더 실행이 실패했습니다.",
          usage,
        };
        // 실행 오류의 자세한 이유는 프로그램의 기록 파일에만 있다(1.5.4).
        if (errored && logFile) {
          const log = await orIfMissing(
            () => readFile(logFile, "utf8"),
            hasErrorCode("ENOENT"),
            ""
          );
          if (saysLoginProblem(log.slice(-4096)))
            result.errorCode = "login_required";
        }
        return result;
      } catch (error) {
        // 감독 실행기를 쓸 수 없어 띄우지 않은 거절은 그 이유가 실행 시도의 실패 원인으로 보이도록 넘긴다.
        if (error instanceof TreeLaunchRefused) throw error;
        if (!control.signal.aborted)
          console.warn(
            `[provider] the Antigravity run failed (${failureCode(error)})`
          );
        return control.signal.aborted
          ? { ...failure(), stopReason: "cancelled", error: null }
          : failure();
      } finally {
        grant?.revoke();
        await Promise.all([
          attempt &&
            removeAttemptFolder(attempt, {
              kind: "attempt folder",
              connection: connectionId,
              runId: request.identity.runId,
            }),
          logs &&
            removeAttemptFolder(logs, {
              kind: "log folder",
              connection: connectionId,
              runId: request.identity.runId,
            }),
        ]);
      }
    },
  };
  return {
    id: connectionId,
    label: options.label ?? "Antigravity",
    isolatable: true,
    credentialRelay: relay,
    login: { command, args: [], env: env() },
    adapter,
    models: [],
    async listModels(signal) {
      await login.prepareConnection();
      return (await probe(["models"], signal)).split("\n").flatMap((line) => {
        const [id, label] = line.split("\t");
        return id && label ? [{ id, label }] : [];
      });
    },
  };
}
