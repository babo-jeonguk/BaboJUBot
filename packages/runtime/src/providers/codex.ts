import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderConnection,
  ProviderReadinessCheck,
  RunResult,
  RuntimeAdapter,
  RunRequest,
  SteerMessage,
  SteerOutcome,
  UsageAmount,
  UsageField,
} from "@babojubot/contracts";
import {
  isUsageAnomaly,
  subtractUsage,
  usageAmount,
} from "@babojubot/contracts";
import { providerUsage } from "./usage.ts";
import {
  startProcess,
  probeTimeoutMs,
  saysLoginProblem,
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
import {
  createCredentialRelay,
  credentialResidue,
  type RelayGrant,
  type RelayProfile,
  residueRefusal,
} from "./credential-relay.ts";
import { providerDestinations } from "./destinations.ts";
import { connectionFolders } from "./folders.ts";
import { loginLink } from "./login-link.ts";

export type CodexOptions = {
  dataDir: string;
  mode?: "app-server" | "exec";
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
  /** 인증 중계 설정. 시험·합성 검증이 상류를 바꾸고 검증 여부를 정한다. 제품은 기본값(공식 상류, 미검증)을 쓴다. */
  relay?: { upstream?: string; verified?: boolean };
};
/**
 * Codex의 인증 중계(#148). Codex의 ChatGPT 로그인은 custom provider(`requires_openai_auth`)를 거쳐 중계로 간다.
 * 중계는 실행 시도의 권한을 연결의 access token과 계정으로 바꿔 넣는다. 갱신은 컨테이너 밖이 맡고,
 * 컨테이너의 로그인 파일에는 갱신 값도 계정도 없다.
 */
export const codexRelayProfile: RelayProfile = {
  upstream: "https://chatgpt.com/backend-api/codex",
  routes: [
    { method: "POST", path: "/responses" },
    { method: "GET", path: "/models" },
  ],
  authorize(credential) {
    const login = record(JSON.parse(credential));
    const tokens = record(login.tokens);
    const access = tokens.access_token;
    if (typeof access !== "string" || !access)
      throw new Error("no access token");
    let account =
      typeof tokens.account_id === "string" && tokens.account_id
        ? tokens.account_id
        : undefined;
    if (!account && typeof tokens.id_token === "string") {
      try {
        const payload = tokens.id_token.split(".")[1];
        const claims = record(
          JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))
        );
        const auth = record(claims["https://api.openai.com/auth"]);
        if (
          typeof auth.chatgpt_account_id === "string" &&
          auth.chatgpt_account_id
        )
          account = auth.chatgpt_account_id;
      } catch {
        /* 계정을 읽지 못했다. */
      }
    }
    if (!account) throw new Error("no account id");
    return {
      headers: {
        authorization: `Bearer ${access}`,
        "chatgpt-account-id": account,
      },
      secrets: [access],
    };
  },
  droppedHeaders: ["chatgpt-account-id", "x-openai-account-routing-override"],
};
const relayFailure =
  "인증 중계가 연결의 로그인을 쓰지 못해 실행을 끝냈습니다. 로그인을 확인한 뒤 다시 실행하세요.";
/**
 * 컨테이너 로그인 파일의 id_token. JWT 모양이지만 payload가 비어 있다. Codex는 id_token이 JWT 모양일 때만
 * Authorization header를 보낸다.
 */
const relayIdToken = "eyJhbGciOiJub25lIn0.e30.babojubot-relay";
/**
 * 컨테이너에 넣는 가짜 로그인. 계정 ID도, OPENAI_API_KEY도, 갱신 값도 없다. 빈 갱신 값과 계정 ID가 없으므로
 * Codex는 갱신도 계정 확인도 하지 않는다. last_refresh를 지금으로 두어 8일 규칙도 걸리지 않는다.
 */
const relayLogin = (token: string) => ({
  tokens: {
    id_token: relayIdToken,
    access_token: token,
    refresh_token: "",
  },
  last_refresh: new Date().toISOString(),
});
/** 이 어댑터가 남긴 가짜 로그인 파일인가. 서버가 실행 중에 멈춰 남은 파일이면 다음 실행을 시작한다. */
async function isRelayLogin(file: string): Promise<boolean> {
  try {
    const found = await lstat(file);
    if (!found.isFile()) return false;
    const login = record(JSON.parse(await readFile(file, "utf8")));
    const tokens = record(login.tokens);
    return (
      tokens.id_token === relayIdToken &&
      (tokens.refresh_token === undefined || tokens.refresh_token === "") &&
      tokens.account_id === undefined &&
      (login.OPENAI_API_KEY === undefined || login.OPENAI_API_KEY === null)
    );
  } catch {
    return false;
  }
}
/**
 * 조직 폴더의 로그인 자리에 권한 없는 자리 표시를 둔다. 실행 시도마다 그 위에 자기 로그인 파일을 넣는 자리다(Docker는 넣을 자리가 있어야 한다).
 * 원본을 가리키는 링크는 따라가 쓰지 않도록 먼저 지운다. 같은 조직의 다른 실행 시도가 함께 두어도 같은 내용이다.
 */
async function placeLoginPlaceholder(at: string): Promise<void> {
  if (await isRelayLogin(at)) return;
  await rm(at, { force: true });
  try {
    await writeFile(at, JSON.stringify(relayLogin("")), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await isRelayLogin(at))
    )
      throw error;
  }
}
/** 갱신을 기다리는 한도. */
const refreshTimeoutMs = 60_000;
/** Codex 자신은 접근 토큰 만료 5분 전, 또는 마지막 갱신 8일 뒤에 갱신한다. 서버는 그보다 조금 일찍 갱신한다. */
const refreshWindowMs = 10 * 60 * 1000;
const refreshIntervalMs = 8 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
/** JWT 모양 값의 만료 시각(ms). 읽지 못하면 undefined. */
function jwtExpiry(token: string): number | undefined {
  try {
    const claims = record(
      JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
      )
    );
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
/** 원본 로그인을 갱신해야 하는가. Codex와 같은 규칙이다: 접근 토큰에 만료 시각이 있으면 그것으로, 없으면 마지막 갱신 시각으로 본다. */
function needsRefresh(text: string): boolean {
  let login: Record<string, unknown>;
  try {
    login = record(JSON.parse(text));
  } catch {
    return false;
  }
  const access = record(login.tokens).access_token;
  if (typeof access !== "string" || !access) return false;
  const expiry = jwtExpiry(access);
  if (expiry !== undefined) return expiry - Date.now() <= refreshWindowMs;
  const last =
    typeof login.last_refresh === "string"
      ? Date.parse(login.last_refresh)
      : Number.NaN;
  return Number.isFinite(last) && Date.now() - last >= refreshIntervalMs;
}
const failed = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더 실행이 실패했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
/** Codex가 알려 준 세션 누계 하나. */
type CodexTotals = Record<
  "input" | "cachedInput" | "cacheWrite" | "output",
  UsageAmount
>;
/** 세션 상태에 남긴 누계를 읽는다. 키 이름은 경로(app-server·exec)마다 다르다. */
const readTotals = (
  value: unknown,
  keys: Record<keyof CodexTotals, string>
): CodexTotals => {
  const saved = record(value);
  return {
    input: usageAmount("tokens", saved[keys.input]),
    cachedInput: usageAmount("tokens", saved[keys.cachedInput]),
    cacheWrite: usageAmount("tokens", saved[keys.cacheWrite]),
    output: usageAmount("tokens", saved[keys.output]),
  };
};
/** 세션 상태에 남기는 잘못된 누계 표시. 숫자가 아니므로 다음 실행 시도가 읽으면 보고 안 됨(0)이 아니라 이상값이 된다. */
const invalidSavedTotal = "invalid";
/** 다음 실행 시도의 baseline으로 남길 누계. */
const savedTotals = (
  totals: CodexTotals,
  keys: Record<keyof CodexTotals, string>
) =>
  Object.fromEntries(
    (Object.keys(keys) as (keyof CodexTotals)[]).map((key) => {
      const amount = totals[key];
      return [keys[key], isUsageAnomaly(amount) ? invalidSavedTotal : amount];
    })
  );
/**
 * 재개한 세션의 누계에서 이 실행 시도의 몫만 남긴다. 보고 안 된 baseline은 0으로 본다(새 세션·그 값을 받지 못한 세션).
 * Codex의 입력은 캐시 읽기를 포함하므로 캐시 읽기를 뺀 값을 입력으로 보고한다.
 */
const codexUsage = (
  totals: CodexTotals,
  baseline: CodexTotals
): Record<UsageField, UsageAmount> => {
  const delta = (key: keyof CodexTotals) =>
    subtractUsage("tokens", totals[key], baseline[key] ?? 0);
  const cache = delta("cachedInput");
  return {
    inputTokens: subtractUsage("tokens", delta("input"), cache ?? 0),
    outputTokens: delta("output"),
    cacheReadTokens: cache,
    cacheWriteTokens: delta("cacheWrite"),
    costUsd: null,
  };
};
const appServerKeys = {
  input: "inputTokens",
  cachedInput: "cachedInputTokens",
  cacheWrite: "cacheWriteInputTokens",
  output: "outputTokens",
};
const execKeys = {
  input: "input_tokens",
  cachedInput: "cached_input_tokens",
  cacheWrite: "cache_write_input_tokens",
  output: "output_tokens",
};
class ProtocolRejection extends Error {
  constructor() {
    super("Protocol request rejected");
  }
}
/** 세션 시작·재개 같은 요청의 응답 제한. 큰 세션을 불러오면 오래 걸린다. */
const requestTimeoutMs = 2 * 60 * 1000;
/** 끼워 넣기 응답 제한. 넘겨도 실행 시도는 끝내지 않는다. */
const steerTimeoutMs = 10_000;

export function createCodexProvider(options: CodexOptions): ProviderConnection {
  const id = options.id ?? "codex";
  const folders = connectionFolders(options.dataDir, id);
  const home = folders.connection;
  /** 연결의 로그인 원본. 컨테이너에는 넣지 않는다(#148). */
  const loginFolder = path.join(home, "login");
  const original = path.join(loginFolder, "auth.json");
  const shareLogin = loginLink({
    original,
    fallback: path.join(home, "auth.json"),
    label: "Codex",
  });
  const command = options.command ?? commandFor(id, "codex");
  const environment = (codexHome = home, isolated = false) =>
    providerEnvironment(id, codexHome, { CODEX_HOME: codexHome }, { isolated });
  let refreshing: Promise<void> | undefined;
  /**
   * 원본 로그인을 이 컴퓨터의 Codex로 갱신한다(#148). 갱신은 컨테이너가 아니라 서버가 맡는다. 연결 폴더의 로그인 링크를 따라
   * Codex가 원본 자리에 새 로그인을 쓴다. 연결마다 한 번에 하나만 하고, 그동안 온 요청은 같은 갱신을 기다린다.
   */
  const refreshLogin = () =>
    (refreshing ??= (async () => {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await shareLogin(path.join(home, "auth.json"));
      const child = startProcess({
        stateDir: home,
        command,
        args: ["app-server"],
        cwd: home,
        env: environment(),
        onFrame: async (raw) => {
          const frame = record(raw);
          if (frame.method) return;
          if (frame.id === 1 && !frame.error) {
            child.write({ method: "initialized" });
            child.write({
              id: 2,
              method: "account/read",
              params: { refreshToken: true },
            });
          } else child.end();
        },
      });
      const timer = setTimeout(() => child.end(), refreshTimeoutMs);
      try {
        child.write({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "babojubot", version: "0.0.0" } },
        });
        await child.done;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      refreshing = undefined;
    }));
  /** 중계가 쓸 원본 로그인. 곧 끝나면 먼저 갱신하고, 갱신한 뒤에도 끝나 가면 갱신 실패로 던진다(중계 실패, Q6). */
  const currentLogin = async () => {
    const login = await readFile(original, "utf8");
    if (!needsRefresh(login)) return login;
    await refreshLogin();
    const refreshed = await readFile(original, "utf8");
    if (needsRefresh(refreshed)) throw new Error("login refresh failed");
    return refreshed;
  };
  const relay = createCredentialRelay({
    profile: {
      ...codexRelayProfile,
      upstream: options.relay?.upstream ?? codexRelayProfile.upstream,
    },
    verified: options.relay?.verified ?? false,
    credential: () => currentLogin(),
  });
  const readiness = async (
    signal: AbortSignal
  ): Promise<ProviderReadinessCheck> => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await shareLogin(path.join(home, "auth.json"));
    const probe = (args: string[]) =>
      runProbe(command, args, {
        env: environment(),
        cwd: home,
        signal,
        timeout: probeTimeoutMs,
        maxBuffer: 65536,
      });
    try {
      // 프로그램이 있는지만 본다. 어떤 판이든 실제로 동작하면 쓴다.
      await probe(["--version"]);
    } catch (error) {
      return {
        status: "not_ready",
        reason:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "program_missing"
            : "check_failed",
      };
    }
    try {
      await probe(["login", "status"]);
      return { status: "unknown", reason: "credentials_unverified" };
    } catch (error) {
      return {
        status: "not_ready",
        reason:
          (error as { code?: number }).code === 1
            ? "product_login_missing"
            : "check_failed",
      };
    }
  };
  const active = new Map<
    string,
    (message: SteerMessage) => Promise<SteerOutcome>
  >();
  return {
    id,
    label: options.label ?? "Codex",
    isolatable: true,
    credentialRelay: relay,
    login: { command, args: ["login"], env: environment() },
    models: [],
    async listModels(signal) {
      if ((await readiness(signal)).status === "not_ready") return [];
      const models: { id: string; label: string }[] = [];
      let complete = false,
        id = 1;
      const child = startProcess({
        stateDir: home,
        command,
        args: ["app-server"],
        cwd: home,
        env: environment(),
        onFrame: async (raw) => {
          const frame = record(raw);
          if (frame.id !== id || frame.method) return;
          if (frame.error) {
            child.end();
            return;
          }
          if (id === 1) {
            child.write({ method: "initialized" });
            child.write({
              id: ++id,
              method: "model/list",
              params: { limit: 100, includeHidden: false },
            });
            return;
          }
          const result = record(frame.result);
          if (Array.isArray(result.data))
            for (const rawModel of result.data) {
              const model = record(rawModel);
              if (typeof model.model === "string")
                models.push({
                  id: model.model,
                  label:
                    typeof model.displayName === "string"
                      ? model.displayName
                      : model.model,
                });
            }
          if (typeof result.nextCursor === "string")
            child.write({
              id: ++id,
              method: "model/list",
              params: {
                limit: 100,
                includeHidden: false,
                cursor: result.nextCursor,
              },
            });
          else {
            complete = true;
            child.end();
          }
        },
      });
      const stop = () => child.end();
      signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, 60000);
      try {
        if (signal.aborted) stop();
        else
          child.write({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "babojubot", version: "0.0.0" } },
          });
        await child.done;
        return complete && !signal.aborted ? models : [];
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    },
    adapter: {
      capabilities: {
        steer: options.mode !== "exec",
        resume: true,
        reinjectInstructionsOnResume: true,
        usageTokens: true,
        usageCost: false,
        precompact: false,
      },
      loginCommand: `pnpm provider:login ${id}`,
      checkReadiness: readiness,
      ...(options.mode === "exec"
        ? {}
        : {
            async steer(message: SteerMessage) {
              return active.get(message.runId)?.(message) ?? "rejected";
            },
          }),
      async execute(request, control) {
        await mkdir(home, { recursive: true, mode: 0o700 });
        if (control.signal.aborted)
          return { ...failed(), stopReason: "cancelled", error: null };
        // 그 조직의 제품 폴더로 돈다. 로그인은 연결의 원본 하나를 링크로 쓴다.
        const organization = folders.organization(
          request.identity.organizationId
        );
        await shareLogin(path.join(home, "auth.json"));
        // 격리 실행에는 연결의 로그인을 넣지 않는다(#148). 원본을 가리키는 알려진 링크는 컨테이너 안에서 비어 있고, 조직 폴더에 남은 보통 파일이나 다른 곳을 가리키는 링크면 시작하지 않는다.
        // Codex의 인증 중계를 검증하기 전에는 서버가 격리 실행을 준비안됨으로 막는다.
        const isolated = request.execution === "container";
        const loginAt = path.join(organization, "auth.json");
        if (
          isolated &&
          (await credentialResidue(organization, ["auth.json"], original)) &&
          !(await isRelayLogin(loginAt))
        )
          return { ...failed(), error: residueRefusal };
        // 격리 실행이 조직 폴더에 남긴 자리 표시는 로그인이 아니다. 이 컴퓨터의 실행이 그것을 연결의 로그인으로 옮기지 않게 먼저 지운다.
        if (!isolated && (await isRelayLogin(loginAt)))
          await rm(loginAt, { force: true });
        const linked =
          !isolated && (await shareLogin(path.join(organization, "auth.json")));
        const codexHome = linked || isolated ? organization : home;
        // 격리 실행은 로그인 링크를 만들지 않으므로, 컨테이너에 넣을 제품 폴더를 여기서 만든다.
        if (isolated) await mkdir(codexHome, { recursive: true, mode: 0o700 });
        const cwd = request.workspace?.cwd ?? codexHome;
        const placement = placeAttempt(options.container, codexHome, request);
        if (!placement) return failed();
        // 권한은 실행 시도를 정리하는 이 try 안에서 받는다. 어디서 끝나든 finally가 거두고 이 실행 시도 전용 폴더를 지운다.
        let grant: RelayGrant | undefined;
        let attempt: string | undefined;
        try {
          if (isolated) {
            try {
              grant = relay.grant({
                signal: control.signal,
                organizationId: request.identity.organizationId,
                runId: request.identity.runId,
              });
            } catch {
              return { ...failed(), error: relayFailure };
            }
            // 조직 폴더는 그 조직의 모든 컨테이너에 쓰기로 들어간다. 권한이 든 로그인 파일은 이 실행 시도 전용 폴더에 두고,
            // 이 컨테이너에만 조직 폴더의 로그인 자리 위에 읽기로 넣는다. 조직 폴더에는 권한 없는 자리 표시만 둔다.
            attempt = await mkdtemp(
              path.join(os.tmpdir(), "babojubot-attempt-")
            );
            await writeFile(
              path.join(attempt, "auth.json"),
              JSON.stringify(relayLogin(grant.token)),
              { mode: 0o600, flag: "wx" }
            );
            await placeLoginPlaceholder(loginAt);
          }
          let container: ContainerLaunch | undefined;
          try {
            container = placement.container?.({
              cwd,
              program: "codex",
              destinations: providerDestinations.codex,
              ...(attempt
                ? {
                    files: [
                      {
                        source: path.join(attempt, "auth.json"),
                        target: loginAt,
                      },
                    ],
                  }
                : {}),
            });
          } catch (error) {
            if (error instanceof ContainerRefusal)
              return { ...failed(), error: error.message };
            throw error;
          }
          let result = failed(),
            threadId = "",
            turnId = "",
            sequence = 0;
          let totals: CodexTotals | undefined;
          let baseline = readTotals(
            request.previousSession?.tokens,
            appServerKeys
          );
          let activities = Promise.resolve();
          const pending = new Map<
            number,
            {
              resolve: (value: Record<string, unknown>) => void;
              reject: (error: Error) => void;
              timer: ReturnType<typeof setTimeout>;
            }
          >();
          const relayBase = new URL(
            `/api/relay/${encodeURIComponent(id)}`,
            request.access.toolsBaseUrl
          ).href;
          const runControl = grant
            ? {
                ...control,
                signal: AbortSignal.any([control.signal, grant.failed]),
              }
            : control;
          const env = {
            ...environment(codexHome, isolated),
            BABOJUBOT_MCP_TOKEN: request.access.token,
            ...(isolated
              ? { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${relayBase}/oauth/token` }
              : {}),
          };
          const args = [
            "-c",
            'approval_policy="never"',
            "-c",
            'sandbox_mode="danger-full-access"',
            "-c",
            "project_doc_max_bytes=0",
            "-c",
            `mcp_servers.organization.url=${JSON.stringify(new URL("/api/tools/mcp", request.access.toolsBaseUrl).href)}`,
            "-c",
            'mcp_servers.organization.bearer_token_env_var="BABOJUBOT_MCP_TOKEN"',
          ];
          // -c는 에이전트가 고칠 수 있는 조직 폴더의 config.toml보다 우선한다.
          if (isolated)
            args.push(
              "-c",
              `model_provider=${JSON.stringify("babojubot_relay")}`,
              "-c",
              `model_providers.babojubot_relay={name="BaboJUBot relay",base_url=${JSON.stringify(relayBase)},wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
              "-c",
              `chatgpt_base_url=${JSON.stringify(relayBase + "/backend-api/")}`,
              "-c",
              `cli_auth_credentials_store=${JSON.stringify("file")}`,
              "-c",
              `forced_login_method=${JSON.stringify("chatgpt")}`,
              "-c",
              "check_for_update_on_startup=false",
              "-c",
              "analytics.enabled=false",
              "-c",
              "features.apps=false",
              "-c",
              "features.plugins=false",
              "-c",
              "features.remote_plugin=false",
              "-c",
              "features.plugin_discovery_prefetch=false"
            );
          if (options.mode === "exec") {
            const outcome = await executeExec(request, runControl, {
              provider: id,
              command,
              config: args,
              stateDir: home,
              cwd,
              env,
              container,
            });
            // 중계가 실패해 멈췄으면 취소가 아니라 중계 실패다. 사용자의 중단은 그대로 취소다.
            if (grant?.failed.aborted && !control.signal.aborted)
              return {
                ...failed(),
                error: relayFailure,
                usage: outcome.usage,
                nextSession: null,
              };
            return outcome;
          }
          args.unshift("app-server");
          const child = startProcess({
            // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
            stateDir: home,
            command,
            args,
            cwd,
            env,
            container,
            onFrame: async (raw) => {
              const frame = record(raw);
              if (typeof frame.id === "number" && !frame.method) {
                const waiter = pending.get(frame.id);
                if (!waiter) return;
                pending.delete(frame.id);
                clearTimeout(waiter.timer);
                if (frame.error) waiter.reject(new ProtocolRejection());
                else waiter.resolve(record(frame.result));
                return;
              }
              const params = record(frame.params);
              if (params.threadId !== threadId) return;
              if (frame.method === "thread/tokenUsage/updated") {
                // 합이 아니라 세션 누계이므로 새 누계가 앞의 누계(잘못된 것이었어도)를 대신한다.
                totals = readTotals(
                  record(params.tokenUsage).total,
                  appServerKeys
                );
              }
              if (frame.method === "turn/completed") {
                const turn = record(params.turn);
                if (turn.id !== turnId) return;
                active.delete(request.identity.runId);
                result = {
                  ...failed(),
                  stopReason:
                    turn.status === "completed"
                      ? "completed"
                      : turn.status === "interrupted"
                        ? "cancelled"
                        : "failed",
                  error:
                    turn.status === "failed"
                      ? "프로바이더 실행이 실패했습니다."
                      : null,
                  // 사용량은 실행 시도가 끝날 때 한 번 정한다.
                  usage: null,
                  nextSession: {
                    id: threadId,
                    tokens: totals ? savedTotals(totals, appServerKeys) : {},
                  },
                };
                if (
                  turn.status === "failed" &&
                  saysLoginProblem(record(turn.error).message)
                )
                  result.errorCode = "login_required";
                child.end();
              }
            },
          });
          const rpc = (
            method: string,
            params: unknown,
            timeoutMs = requestTimeoutMs,
            endOnTimeout = true
          ) =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
              const id = ++sequence;
              const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error("Protocol response timed out"));
                if (endOnTimeout) child.end();
              }, timeoutMs);
              pending.set(id, { resolve, reject, timer });
              if (!child.write({ id, method, params })) {
                clearTimeout(timer);
                pending.delete(id);
                reject(new Error("Protocol closed"));
              }
            });
          void child.done.then(() => {
            for (const item of pending.values()) {
              clearTimeout(item.timer);
              item.reject(new Error("Protocol closed"));
            }
            pending.clear();
          });
          const cancel = () => {
            if (threadId && turnId)
              child.write({
                id: ++sequence,
                method: "turn/interrupt",
                params: { threadId, turnId },
              });
            child.end();
          };
          runControl.signal.addEventListener("abort", cancel, { once: true });
          try {
            if (runControl.signal.aborted) cancel();
            else {
              await rpc("initialize", {
                clientInfo: { name: "babojubot", version: "0.0.0" },
              });
              child.write({ method: "initialized" });
              const config = {
                cwd,
                model: request.model,
                approvalPolicy: "never",
                sandbox: "danger-full-access",
                developerInstructions: request.instructions
                  .map((f) => f.content)
                  .join("\n\n"),
              };
              let started: Record<string, unknown>;
              try {
                started = await rpc(
                  request.previousSession?.id
                    ? "thread/resume"
                    : "thread/start",
                  {
                    ...config,
                    ...(request.previousSession?.id
                      ? { threadId: request.previousSession.id }
                      : {}),
                  }
                );
              } catch (error) {
                // 문구에 기대지 않는다. 프로그램이 재개를 거절하면 새 세션으로 시작한다.
                if (
                  !request.previousSession ||
                  !(error instanceof ProtocolRejection)
                )
                  throw error;
                baseline = readTotals({}, appServerKeys);
                await runControl.emit({
                  type: "progress",
                  text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
                });
                started = await rpc("thread/start", config);
              }
              threadId = String(record(started.thread).id);
              const turn = await rpc("turn/start", {
                threadId,
                input: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      identity: request.identity,
                      context: request.context,
                      wakeReasons: request.wakeReasons,
                    }),
                  },
                ],
              });
              turnId = String(record(turn.turn).id);
              active.set(request.identity.runId, async (message) => {
                if (runControl.signal.aborted || child.closed)
                  return "rejected";
                const expectedTurnId = turnId;
                try {
                  const ack = await rpc(
                    "turn/steer",
                    {
                      threadId,
                      expectedTurnId,
                      clientUserMessageId: message.messageId,
                      input: [{ type: "text", text: message.body }],
                    },
                    steerTimeoutMs,
                    false
                  );
                  return ack.turnId === expectedTurnId
                    ? "accepted"
                    : "rejected";
                } catch (error) {
                  if (error instanceof ProtocolRejection) return "rejected";
                  throw error;
                }
              });
              activities = activities.then(() =>
                runControl.emit({
                  type: "progress",
                  text: "프로바이더가 작업을 시작했습니다.",
                })
              );
            }
          } catch {
            child.end();
          }
          await child.done;
          runControl.signal.removeEventListener("abort", cancel);
          active.delete(request.identity.runId);
          await activities;
          // 끝난 방식과 상관없이 마지막으로 받은 누계로 사용량을 한 번 정한다. 누계를 받지 못했으면 보고 안 됨이다.
          const usage = totals
            ? providerUsage(id, codexUsage(totals, baseline))
            : null;
          if (control.signal.aborted)
            return { ...failed(), stopReason: "cancelled", error: null, usage };
          if (grant?.failed.aborted)
            return {
              ...failed(),
              error: relayFailure,
              usage,
              nextSession: null,
            };
          return { ...result, usage };
        } finally {
          grant?.revoke();
          if (attempt)
            await rm(attempt, { recursive: true, force: true }).catch(() => {});
        }
      },
    },
  };
}

async function executeExec(
  request: RunRequest,
  control: Parameters<RuntimeAdapter["execute"]>[1],
  launch: {
    /** 운영 기록에 남길 연결 ID. */
    provider: string;
    command: readonly [string, ...string[]];
    config: string[];
    /** 프로세스 기록 폴더(연결 폴더). */
    stateDir: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    container?: ContainerLaunch;
  }
): Promise<RunResult> {
  const { command, config, stateDir, cwd, env, container } = launch;
  let id: string | null = null,
    result = failed(),
    loginProblem = false;
  const before = readTotals(request.previousSession?.tokens, execKeys);
  const args = [
    "exec",
    ...config,
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    `developer_instructions=${JSON.stringify(request.instructions.map((f) => f.content).join("\n\n"))}`,
  ];
  if (request.model) args.push("--model", request.model);
  if (typeof request.previousSession?.id === "string")
    args.push("resume", request.previousSession.id);
  args.push("-");
  const child = startProcess({
    stateDir,
    command,
    args,
    cwd,
    env,
    container,
    onFrame: async (raw) => {
      const frame = record(raw);
      if (
        (frame.type === "error" && saysLoginProblem(frame.message)) ||
        (frame.type === "turn.failed" &&
          saysLoginProblem(record(frame.error).message))
      )
        loginProblem = true;
      if (
        frame.type === "thread.started" &&
        typeof frame.thread_id === "string"
      ) {
        id = frame.thread_id;
        await control.emit({
          type: "progress",
          text: "프로바이더가 작업을 시작했습니다.",
        });
      }
      if (frame.type === "turn.completed") {
        const totals = readTotals(frame.usage, execKeys);
        result = {
          stopReason: "completed",
          error: null,
          summary: null,
          nextSession: id
            ? { id, tokens: savedTotals(totals, execKeys) }
            : null,
          usage: providerUsage(launch.provider, codexUsage(totals, before)),
        };
        child.end();
      }
    },
  });
  const cancel = () => {
    child.interrupt();
    child.end();
  };
  control.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (control.signal.aborted) cancel();
    else {
      child.write({
        identity: request.identity,
        context: request.context,
        wakeReasons: request.wakeReasons,
      });
      child.endInput();
    }
    await child.done;
    // 취소 전에 받은 결과의 사용량은 남긴다.
    if (control.signal.aborted)
      return {
        ...failed(),
        stopReason: "cancelled",
        error: null,
        usage: result.usage,
      };
    // 문구에 기대지 않는다. 이전 세션으로 시작조차 못 했으면 새 세션으로 한 번 다시 시도한다.
    if (!id && request.previousSession && !loginProblem) {
      await control.emit({
        type: "progress",
        text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
      });
      return executeExec(
        { ...request, previousSession: null },
        control,
        launch
      );
    }
    return result.stopReason === "failed" && loginProblem
      ? { ...result, errorCode: "login_required" as const }
      : result;
  } finally {
    control.signal.removeEventListener("abort", cancel);
  }
}
