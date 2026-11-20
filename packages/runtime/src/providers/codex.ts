import { mkdtemp } from "node:fs/promises";
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
  continueAfterFailure,
  failureCode,
  isUsageAnomaly,
  orIfProbeFailed,
  orIfUnreadable,
  settled,
  subtractUsage,
  usageAmount,
} from "@babojubot/contracts";
import { providerUsage } from "./usage.ts";
import {
  openCodexConnection,
  ProtocolRejection,
  ProtocolTimeout,
} from "./codex-connection.ts";
import { readRegularFile } from "./regular-file.ts";
import { type Clock, realClock } from "./process.ts";
import {
  startProcess,
  probeTimeoutMs,
  saysLoginProblem,
  commandFor,
  providerEnvironment,
  probeEnding,
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
  type RelayGrant,
  type RelayProfile,
} from "./credential-relay.ts";
import { providerDestinations } from "./destinations.ts";
import { type AttemptLoginFile, fileLogin } from "./file-login.ts";
import { record } from "./record.ts";
import { removeAttemptFolder } from "./attempt-folder.ts";

export type CodexOptions = {
  dataDir: string;
  mode?: "app-server" | "exec";
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
  /** 인증 중계 설정. 시험·합성 검증이 상류를 바꾸고 검증 여부를 정한다. 제품은 기본값(공식 상류, 검증됨: 2026-11-12 실제 구독으로 확인)을 쓴다. */
  relay?: { upstream?: string; verified?: boolean };
  /** 시험이 줄이는 시한(ms). 제품은 기본값(일반 요청 120초, 끼워 넣기 10초, 모델 목록·로그인 갱신 전체 60초)을 쓴다. */
  timeouts?: Partial<Record<keyof typeof defaultTimeouts, number>>;
  /** 위 시한이 쓰는 시계. 제품은 실제 시계를 쓰고, 시험은 시간을 직접 넘기는 시계를 넣는다(#215). */
  clock?: Clock;
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
      const payload = tokens.id_token.split(".")[1];
      const claims = orIfUnreadable(
        () =>
          record(
            JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))
          ),
        undefined
      );
      const auth = record(claims?.["https://api.openai.com/auth"]);
      if (
        typeof auth.chatgpt_account_id === "string" &&
        auth.chatgpt_account_id
      )
        account = auth.chatgpt_account_id;
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
  const text = await readRegularFile(file);
  if (text === undefined) return false;
  const login = orIfUnreadable(() => record(JSON.parse(text)), undefined);
  if (!login) return false;
  const tokens = record(login.tokens);
  return (
    tokens.id_token === relayIdToken &&
    (tokens.refresh_token === undefined || tokens.refresh_token === "") &&
    tokens.account_id === undefined &&
    (login.OPENAI_API_KEY === undefined || login.OPENAI_API_KEY === null)
  );
}
/** Codex 자신은 접근 토큰 만료 5분 전, 또는 마지막 갱신 8일 뒤에 갱신한다. 서버는 그보다 조금 일찍 갱신한다. */
const refreshWindowMs = 10 * 60 * 1000;
const refreshIntervalMs = 8 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
/** JWT 모양 값의 만료 시각(ms). 읽지 못하면 undefined. */
function jwtExpiry(token: string): number | undefined {
  const claims = orIfUnreadable(
    () =>
      record(
        JSON.parse(
          Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
        )
      ),
    undefined
  );
  return typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
}
/** 원본 로그인을 갱신해야 하는가. Codex와 같은 규칙이다: 접근 토큰에 만료 시각이 있으면 그것으로, 없으면 마지막 갱신 시각으로 본다. */
function needsRefresh(text: string): boolean {
  const login = orIfUnreadable(() => record(JSON.parse(text)), undefined);
  if (!login) return false;
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
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** `thread/read`(턴 포함) 결과에 이 `clientId`를 단 사용자 메시지가 있는가(#206). 여럿이어도 있다. */
const holdsClientMessage = (read: Record<string, unknown>, clientId: string) =>
  list(record(read.thread).turns).some((turn) =>
    list(record(turn).items).some((raw) => {
      const item = record(raw);
      return item.type === "userMessage" && item.clientId === clientId;
    })
  );
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
/** 지금부터 `limitMs` 뒤에 끝나는 시한 하나. 부를 때마다 남은 시간을 요청 제한으로 준다. */
const remainingOf = (clock: Clock, limitMs: number) => {
  const deadline = clock.now() + limitMs;
  return () => ({ timeoutMs: deadline - clock.now() });
};
const defaultTimeouts = {
  /** 세션 시작·재개 같은 요청의 응답 제한. 큰 세션을 불러오면 오래 걸린다. 넘기면 실행 시도를 끝낸다. */
  request: 2 * 60 * 1000,
  /** 끼워 넣기 응답 제한. 넘기면 전달 여부를 모르는 오류이며 실행 시도는 끝내지 않는다. */
  steer: 10_000,
  /** 끼워 넣기 응답이 없을 때 대화 기록을 한 번 읽는 제한(#206). 끼워 넣기 제한과 합쳐 기다림은 20초를 넘지 않는다. */
  steerRecord: 10_000,
  /** 모델 목록 전체(초기화부터 마지막 페이지까지)의 한도. 페이지마다 다시 시작하지 않는다. */
  modelList: 60_000,
  /** 로그인 갱신 전체(초기화와 account/read)의 한도. 단계마다 다시 시작하지 않는다. */
  refresh: 60_000,
};

export function createCodexProvider(options: CodexOptions): ProviderConnection {
  const id = options.id ?? "codex";
  // 연결의 로그인 하나를 모든 조직이 같이 쓰고, 격리 실행에는 권한만 든 실행 시도 전용 로그인을 넣는다(#146·#148).
  const login = fileLogin(options.dataDir, id, {
    label: "Codex",
    loginFile: "auth.json",
    contents: (token) => JSON.stringify(relayLogin(token)),
    isStandIn: isRelayLogin,
  });
  const { home } = login;
  const command = options.command ?? commandFor(id, "codex");
  const timeouts = { ...defaultTimeouts, ...options.timeouts };
  const clock = options.clock ?? realClock;
  /** 모델 목록·로그인 갱신용 app-server. 이 컴퓨터의 연결 폴더에서 돈다. */
  const openAppServer = () =>
    openCodexConnection({
      stateDir: home,
      command,
      args: ["app-server"],
      cwd: home,
      env: environment(),
      clock,
    });
  const environment = (codexHome = home, isolated = false) =>
    providerEnvironment(id, codexHome, { CODEX_HOME: codexHome }, { isolated });
  let refreshing: Promise<void> | undefined;
  /**
   * 연결의 로그인을 이 컴퓨터의 Codex로 갱신한다(#148). 갱신은 컨테이너가 아니라 서버가 맡는다. 연결 폴더의 로그인 링크를 따라
   * Codex가 원본 자리에 새 로그인을 쓰고, 링크를 만들 수 없는 컴퓨터면 연결 폴더 자리의 보통 파일에 쓴다(#209). 연결마다 한 번에 하나만 하고, 그동안 온 요청은 같은 갱신을 기다린다.
   */
  const refreshLogin = () =>
    (refreshing ??= (async () => {
      await login.prepareConnection();
      const connection = openAppServer();
      // 한도는 프로그램을 띄운 때부터 하나다. 초기화와 account/read가 이어 쓴다.
      const left = remainingOf(clock, timeouts.refresh);
      try {
        await connection.initialize(left());
        await connection.request(
          "account/read",
          { refreshToken: true },
          left()
        );
      } catch (error) {
        // 갱신했는지는 응답이 아니라 원본을 다시 읽어 판단한다(currentLogin).
        console.warn(
          `[provider] the Codex login refresh failed; the next read decides (${failureCode(error)})`
        );
      } finally {
        connection.close();
        await connection.done;
      }
    })().finally(() => {
      refreshing = undefined;
    }));
  /**
   * 중계가 쓸 연결의 로그인. 이 컴퓨터의 실행이 읽는 자리를 읽는다(#209). 곧 끝나면 먼저 갱신하고, 갱신한 뒤에도 끝나 가면
   * 갱신 실패로 던진다(중계 실패, Q6).
   */
  const currentLogin = async () => {
    const current = await login.read();
    if (!needsRefresh(current)) return current;
    await refreshLogin();
    const refreshed = await login.read();
    if (needsRefresh(refreshed)) throw new Error("login refresh failed");
    return refreshed;
  };
  const relay = createCredentialRelay({
    profile: {
      ...codexRelayProfile,
      upstream: options.relay?.upstream ?? codexRelayProfile.upstream,
    },
    verified: options.relay?.verified ?? true,
    credential: () => currentLogin(),
  });
  const readiness = async (
    signal: AbortSignal
  ): Promise<ProviderReadinessCheck> => {
    await login.prepareConnection();
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "not_ready", reason: "program_missing" };
      console.warn(
        `[provider] the ${id} readiness check failed (${probeEnding(error)})`
      );
      return { status: "not_ready", reason: "check_failed" };
    }
    try {
      await probe(["login", "status"]);
      return { status: "unknown", reason: "credentials_unverified" };
    } catch (error) {
      if ((error as { code?: number }).code === 1)
        return { status: "not_ready", reason: "product_login_missing" };
      console.warn(
        `[provider] the ${id} readiness check failed (${probeEnding(error)})`
      );
      return { status: "not_ready", reason: "check_failed" };
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
      if (signal.aborted) return [];
      const connection = openAppServer();
      const stop = () => connection.close();
      signal.addEventListener("abort", stop, { once: true });
      // 목록 전체의 한도 하나를 모든 페이지가 이어 쓴다.
      const left = remainingOf(clock, timeouts.modelList);
      // 모든 페이지를 받은 목록만 쓴다. 중간에 끝나면 받은 페이지를 버린다.
      let models: { id: string; label: string }[] = [];
      try {
        await connection.initialize(left());
        let cursor: string | undefined;
        do {
          const result = await connection.request(
            "model/list",
            {
              limit: 100,
              includeHidden: false,
              ...(cursor === undefined ? {} : { cursor }),
            },
            left()
          );
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
          cursor =
            typeof result.nextCursor === "string"
              ? result.nextCursor
              : undefined;
        } while (cursor !== undefined);
      } catch (error) {
        if (!signal.aborted)
          console.warn(
            `[provider] the Codex model list could not be read (${failureCode(error)})`
          );
        models = [];
      } finally {
        signal.removeEventListener("abort", stop);
        connection.close();
        await connection.done;
      }
      return signal.aborted ? [] : models;
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
        if (control.signal.aborted)
          return { ...failed(), stopReason: "cancelled", error: null };
        // 그 조직의 제품 폴더로 돈다. 로그인은 연결의 원본 하나를 같이 쓴다.
        const isolated = request.execution === "container";
        const prepared = await login.prepare(
          request.identity.organizationId,
          isolated
        );
        if (prepared.refusal !== undefined)
          return { ...failed(), error: prepared.refusal };
        const codexHome = prepared.home;
        const cwd = request.workspace?.cwd ?? codexHome;
        const placement = placeAttempt(options.container, codexHome, request);
        if (!placement) return failed();
        // 권한은 실행 시도를 정리하는 이 try 안에서 받는다. 어디서 끝나든 finally가 거두고 이 실행 시도 전용 폴더를 지운다.
        let grant: RelayGrant | undefined;
        let attempt: string | undefined;
        try {
          let loginFile: AttemptLoginFile | undefined;
          if (prepared.attemptLogin) {
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
            if (!grant) return { ...failed(), error: relayFailure };
            attempt = await mkdtemp(
              path.join(os.tmpdir(), "babojubot-attempt-")
            );
            loginFile = await prepared.attemptLogin(attempt, grant.token);
          }
          let container: ContainerLaunch | undefined;
          try {
            container = placement.container?.({
              cwd,
              program: "codex",
              destinations: providerDestinations.codex,
              ...(loginFile ? { files: [loginFile] } : {}),
            });
          } catch (error) {
            if (error instanceof ContainerRefusal)
              return { ...failed(), error: error.message };
            throw error;
          }
          let result = failed(),
            threadId = "",
            turnId = "";
          let totals: CodexTotals | undefined;
          let baseline = readTotals(
            request.previousSession?.tokens,
            appServerKeys
          );
          let activities = Promise.resolve();
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
          // 준비가 끝난 뒤 프로세스를 띄우기 직전에 취소를 다시 본다. 준비 중에 취소됐으면 띄우지 않는다.
          if (control.signal.aborted)
            return { ...failed(), stopReason: "cancelled", error: null };
          if (grant?.failed.aborted)
            return { ...failed(), error: relayFailure, nextSession: null };
          args.unshift("app-server");
          const connection = openCodexConnection({
            // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
            stateDir: home,
            command,
            args,
            cwd,
            env,
            container,
            clock,
            onNotification: (frame) => {
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
                connection.close();
              }
            },
          });
          /** 일반 요청. 응답이 없으면 실패이며 다시 보내지 않는다(아래 catch가 연결을 닫는다). */
          const rpc = (method: string, params: unknown) =>
            connection.request(method, params, { timeoutMs: timeouts.request });
          const cancel = () => {
            // 응답은 기다리지 않는다. 닫으면 대기는 곧바로 끝난다.
            if (threadId && turnId)
              void settled(rpc("turn/interrupt", { threadId, turnId }));
            connection.close();
          };
          runControl.signal.addEventListener("abort", cancel, { once: true });
          try {
            if (runControl.signal.aborted) cancel();
            else {
              await connection.initialize({ timeoutMs: timeouts.request });
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
                // 문구에 기대지 않는다. 프로그램이 재개를 명시적으로 거절했을 때만 새 세션으로 한 번 시작한다.
                // 응답 없음·연결 닫힘·취소는 거절이 아니다.
                if (
                  !request.previousSession ||
                  !(error instanceof ProtocolRejection) ||
                  runControl.signal.aborted ||
                  connection.closed
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
              const ended = () =>
                runControl.signal.aborted || connection.closed;
              active.set(request.identity.runId, async (message) => {
                if (ended()) return "rejected";
                const expectedTurnId = turnId;
                /**
                 * 대화 기록에 이 메시지 번호가 남았는가(#206). 기록을 한 번만 읽고 모델 턴은 시작하지 않는다.
                 * 읽지 못했거나 그사이 실행 시도가 끝났으면 받았다고 보지 않는다.
                 */
                const recorded = async () =>
                  orIfProbeFailed(
                    async () => {
                      const read = await connection.request(
                        "thread/read",
                        { threadId, includeTurns: true },
                        { timeoutMs: timeouts.steerRecord }
                      );
                      return (
                        !ended() && holdsClientMessage(read, message.messageId)
                      );
                    },
                    false,
                    (error) =>
                      console.warn(
                        `[provider] the Codex thread record could not be read; the steer delivery stays unknown (${failureCode(error)})`
                      )
                  );
                try {
                  // 응답이 없으면 기록을 한 번 확인하고, 거기에도 없으면 전달 여부를 모르는 오류로 알린다.
                  // 실행 시도는 이어 가고 다시 보내지 않는다. 명시적 거절·연결 닫힘은 확인하지 않는다.
                  const ack = await connection.request(
                    "turn/steer",
                    {
                      threadId,
                      expectedTurnId,
                      clientUserMessageId: message.messageId,
                      input: [{ type: "text", text: message.body }],
                    },
                    { timeoutMs: timeouts.steer }
                  );
                  return ack.turnId === expectedTurnId
                    ? "accepted"
                    : "rejected";
                } catch (error) {
                  if (error instanceof ProtocolRejection) return "rejected";
                  if (error instanceof ProtocolTimeout && (await recorded()))
                    return "accepted";
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
          } catch (error) {
            if (!runControl.signal.aborted)
              console.warn(
                `[provider] the Codex run failed; closing its connection (${failureCode(error)})`
              );
            connection.close();
          }
          // 대기는 이미 끝났다. 프로세스·자식·컨테이너·중계 정리가 끝난 뒤에 돌아간다.
          await connection.done;
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
            await removeAttemptFolder(attempt, {
              kind: "attempt folder",
              connection: id,
              runId: request.identity.runId,
            });
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
  // 준비(와 새 세션으로 다시 시도하기 전의 알림) 뒤 프로세스를 띄우기 직전에 취소를 다시 본다.
  if (control.signal.aborted)
    return { ...failed(), stopReason: "cancelled", error: null };
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
