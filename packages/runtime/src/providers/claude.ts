import { claudeSessionCost, claudeSessionFacts } from "./claude-transcript.ts";
import type { ClaudeSessionCost } from "./claude-transcript.ts";
import { claudeModelsFor } from "./claude-models.ts";
import { mkdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderConnection,
  RunResult,
  RunRequest,
  RuntimeAdapter,
  SteerMessage,
  SteerOutcome,
  UsageAmount,
  UsageField,
} from "@babojubot/contracts";
import {
  addUsage,
  subtractUsage,
  unreportedUsage,
  usageAmount,
} from "@babojubot/contracts";

import { z } from "zod";
import { providerUsage } from "./usage.ts";
import {
  startProcess,
  probeTimeoutMs,
  startupLimitMs,
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
import { providerDestinations } from "./destinations.ts";
import { connectionFolders } from "./folders.ts";
import {
  createCredentialRelay,
  credentialResidue,
  type CredentialRelay,
  type RelayGrant,
  type RelayProfile,
  residueRefusal,
} from "./credential-relay.ts";

export type ClaudeOptions = {
  dataDir: string;
  command?: readonly [string, ...string[]];
  id?: string;
  label?: string;
  container?: ContainerSettings;
  /** 인증 중계 설정. 시험·합성 검증이 상류를 바꾸고 검증 여부를 정한다. 제품은 기본값(공식 상류, 미검증)을 쓴다. */
  relay?: { upstream?: string; verified?: boolean };
};
/**
 * Claude의 인증 중계(#148). 공식 LLM gateway 경로(`ANTHROPIC_BASE_URL` + claude.ai 로그인)를 쓴다. 프로그램에는 실행 시도의 권한을
 * `CLAUDE_CODE_OAUTH_TOKEN`으로 주고, 중계가 그것을 연결의 setup-token(access token)으로 바꿔 Messages API에만 보낸다.
 * setup-token에는 refresh token이 없으므로 중계가 갱신하지 않는다. 기존 구독으로 검증하기 전에는 `verified`가 거짓이다.
 */
export const claudeRelayProfile: RelayProfile = {
  upstream: "https://api.anthropic.com",
  routes: [
    { method: "POST", path: "/v1/messages" },
    { method: "POST", path: "/v1/messages/count_tokens" },
  ],
  authorize: (credential) => ({
    headers: { authorization: `Bearer ${credential}` },
    secrets: [credential],
  }),
};
/** 조직 제품 폴더에 남으면 격리 실행을 시작하지 않는 로그인 흔적(프로그램 안에서 로그인한 기록). */
const credentialFiles = ["config/.credentials.json"];
const launchSchema = z.object({
  instructions: z.string(),
  cwd: z.string(),
  model: z.string().nullable(),
});
type ClaudeAttempt = z.infer<typeof launchSchema> & {
  access: RunRequest["access"];
  previousSession: RunRequest["previousSession"];
  prompt: string;
  runId?: string;
  execution?: RunRequest["execution"];
  workspace?: RunRequest["workspace"];
  identity?: RunRequest["identity"];
  /** 이 실행 시도의 조직. 그 조직의 제품 폴더에서 돈다. */
  organizationId: string;
  /** 세션 압축처럼 세션을 다듬는 실행 시도. 이전 세션을 잇지 못하면 새 세션으로 다시 시도하지 않고 실패한다. */
  maintenance?: boolean;
};
/** 실행 시도마다 같은 연결의 값. */
type ClaudeConnection = {
  id: string;
  folders: ReturnType<typeof connectionFolders>;
  command: readonly [string, ...string[]];
  /** 그 제품 폴더로 띄우는 프로그램 환경. */
  environment: (home: string, isolated?: boolean) => NodeJS.ProcessEnv;
  active: Map<string, (message: SteerMessage) => SteerOutcome>;
  container?: ContainerSettings;
  relay: CredentialRelay;
};
const failed = (): RunResult => ({
  stopReason: "failed",
  error: "프로바이더를 실행하지 못했습니다.",
  summary: null,
  usage: null,
  nextSession: null,
});
/**
 * Claude's saved totals after the run minus the baseline for this run, field by field. A field either side did not save stays unreported;
 * a total that went down is not taken as zero.
 */
const runUsage = (
  after: ClaudeSessionCost,
  baseline: ClaudeSessionCost
): Record<UsageField, UsageAmount> => ({
  inputTokens: subtractUsage("tokens", after.inputTokens, baseline.inputTokens),
  outputTokens: subtractUsage(
    "tokens",
    after.outputTokens,
    baseline.outputTokens
  ),
  cacheReadTokens: subtractUsage(
    "tokens",
    after.cacheReadTokens,
    baseline.cacheReadTokens
  ),
  cacheWriteTokens: subtractUsage(
    "tokens",
    after.cacheWriteTokens,
    baseline.cacheWriteTokens
  ),
  costUsd: subtractUsage("usd", after.costUsd, baseline.costUsd),
});
/** 연결 폴더의 제품 로그인 토큰이 있으면 환경에 넣는다. 모든 조직이 이 로그인 하나를 쓴다. 없어도 프로그램에 다른 로그인이 있을 수 있으므로 막지 않는다. */
async function withLogin(connection: string, env: NodeJS.ProcessEnv) {
  try {
    const token = (
      await readFile(path.join(connection, "setup-token"), "utf8")
    ).trim();
    if (token) return { ...env, CLAUDE_CODE_OAUTH_TOKEN: token };
  } catch {
    /* 토큰 파일이 없다. */
  }
  return env;
}
const relayFailure =
  "인증 중계가 연결의 로그인을 쓰지 못해 실행을 끝냈습니다. 로그인을 확인한 뒤 다시 실행하세요.";
/** 격리 실행 환경에는 원본 인증 변수가 처음부터 없다(providerEnvironment). 중계 주소와 이 실행 시도의 권한만 넣는다. */
function relayEnvironment(
  env: NodeJS.ProcessEnv,
  toolsBaseUrl: string,
  connectionId: string,
  grant: RelayGrant
): NodeJS.ProcessEnv {
  return {
    ...env,
    ANTHROPIC_BASE_URL: new URL(
      `/api/relay/${encodeURIComponent(connectionId)}`,
      toolsBaseUrl
    ).href,
    CLAUDE_CODE_OAUTH_TOKEN: grant.token,
  };
}
export function createClaudeProvider(
  options: ClaudeOptions
): ProviderConnection {
  const id = options.id ?? "claude";
  const folders = connectionFolders(options.dataDir, id);
  const connectionHome = folders.connection;
  const command = options.command ?? commandFor(id, "claude");
  const active = new Map<string, (message: SteerMessage) => SteerOutcome>();
  const environment = (home: string, isolated = false) =>
    providerEnvironment(
      id,
      home,
      {
        CLAUDE_CONFIG_DIR: path.join(home, "config"),
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        DISABLE_AUTOUPDATER: "1",
        // root로 돌면 Claude가 권한 건너뛰기를 거부한다. 컨테이너 같은 환경에서도 돌게 한다.
        ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
      },
      { isolated }
    );
  const connection: ClaudeConnection = {
    id,
    folders,
    command,
    environment,
    active,
    container: options.container,
    relay: createCredentialRelay({
      profile: {
        ...claudeRelayProfile,
        upstream: options.relay?.upstream ?? claudeRelayProfile.upstream,
      },
      verified: options.relay?.verified ?? false,
      credential: () =>
        readFile(path.join(connectionHome, "setup-token"), "utf8"),
    }),
  };
  return {
    id,
    label: options.label ?? "Claude Code",
    openModels: true,
    isolatable: true,
    credentialRelay: connection.relay,
    login: {
      command,
      args: ["setup-token"],
      env: environment(connectionHome),
      tokenFile: path.join(connectionHome, "setup-token"),
    },
    models: claudeModelsFor(id),
    adapter: {
      capabilities: {
        steer: true,
        resume: true,
        reinjectInstructionsOnResume: false,
        usageTokens: true,
        usageCost: true,
        precompact: true,
      },
      loginCommand: `pnpm provider:login ${id}`,
      async checkReadiness(signal) {
        await mkdir(connectionHome, { recursive: true, mode: 0o700 });
        // 파일 위치를 가정하지 않고 프로그램에 묻는다.
        try {
          await runProbe(command, ["auth", "status"], {
            env: await withLogin(connectionHome, environment(connectionHome)),
            cwd: connectionHome,
            signal,
            timeout: probeTimeoutMs,
            maxBuffer: 64 * 1024,
          });
          return { status: "unknown", reason: "credentials_unverified" };
        } catch (error) {
          const failure = error as { code?: unknown };
          if (failure.code === "ENOENT")
            return { status: "not_ready", reason: "program_missing" };
          return {
            status: "not_ready",
            reason:
              failure.code === 1 ? "product_login_missing" : "check_failed",
          };
        }
      },
      async precompact({ session, access, execution, organizationId }, signal) {
        const launch = launchSchema.safeParse(session.launch);
        if (!launch.success || typeof session.id !== "string")
          return { ok: false, nextSession: null };
        const result = await executeClaude(
          {
            ...launch.data,
            access,
            previousSession: session,
            prompt: "/compact",
            execution,
            organizationId,
            maintenance: true,
          },
          { signal, emit: async () => {} },
          connection
        );
        return {
          ok: result.stopReason === "completed",
          nextSession:
            result.stopReason === "completed" ? result.nextSession : null,
        };
      },
      async steer(message) {
        return active.get(message.runId)?.(message) ?? "rejected";
      },
      async execute(request, control) {
        if (active.has(request.identity.runId)) return failed();
        try {
          return await executeClaude(
            {
              instructions: request.instructions
                .map((f) => f.content)
                .join("\n\n"),
              cwd:
                request.workspace?.cwd ??
                folders.organization(request.identity.organizationId),
              model: request.model,
              access: request.access,
              previousSession: request.previousSession,
              prompt: JSON.stringify({
                identity: request.identity,
                context: request.context,
                wakeReasons: request.wakeReasons,
              }),
              runId: request.identity.runId,
              execution: request.execution,
              workspace: request.workspace,
              identity: request.identity,
              organizationId: request.identity.organizationId,
            },
            control,
            connection
          );
        } finally {
          active.delete(request.identity.runId);
        }
      },
    },
  };
}

async function executeClaude(
  request: ClaudeAttempt,
  control: Parameters<RuntimeAdapter["execute"]>[1],
  connection: ClaudeConnection
): Promise<RunResult> {
  const { folders, command, active } = connection;
  const home = folders.organization(request.organizationId);
  const maintenance = request.maintenance ?? false;
  if (control.signal.aborted)
    return { ...failed(), stopReason: "cancelled", error: null };
  const placement = placeAttempt(connection.container, home, request);
  if (!placement) return failed();
  const env = connection.environment(home, Boolean(placement.container));
  await mkdir(home, { recursive: true, mode: 0o700 });
  // 격리 실행에는 연결의 로그인을 넣지 않는다. 조직 폴더에 로그인이 남아 있으면 컨테이너가 읽을 수 있으므로 시작하지 않는다.
  if (placement.container && (await credentialResidue(home, credentialFiles)))
    return {
      ...failed(),
      error: residueRefusal,
    };
  // 컨테이너에서는 조직의 제품 폴더가 그 조직의 같은 연결 에이전트 컨테이너에 모두 들어가므로, 토큰이 든 이 실행 시도의 파일은 그 밖에 두고 이 컨테이너에만 읽기로 넣는다.
  const temp = placement.container
    ? await mkdtemp(path.join(os.tmpdir(), "babojubot-attempt-"))
    : await mkdtemp(path.join(home, "attempt-"));
  let launch: ContainerLaunch | undefined;
  try {
    launch = placement.container?.({
      cwd: request.cwd,
      program: "claude",
      attempt: temp,
      destinations: providerDestinations.claude,
    });
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (error instanceof ContainerRefusal)
      return { ...failed(), error: error.message };
    throw error;
  }
  let result = failed();
  // 권한은 실행 시도를 정리하는 이 try 안에서 받는다. 어디서 끝나든 finally가 거둔다.
  let grant: RelayGrant | undefined;
  try {
    if (placement.container)
      try {
        grant = connection.relay.grant({
          signal: control.signal,
          organizationId: request.organizationId,
          // 세션 정비(압축)에는 실행이 없다. #149 중계도 그때는 실행 신원을 넣지 않는다.
          ...(request.runId ? { runId: request.runId } : {}),
        });
      } catch {
        return { ...failed(), error: relayFailure };
      }
    const config = path.join(temp, "mcp.json");
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          organization: {
            type: "http",
            url: new URL("/api/tools/mcp", request.access.toolsBaseUrl).href,
            headers: { Authorization: `Bearer ${request.access.token}` },
          },
        },
      }),
      { mode: 0o600 }
    );
    const instructions = path.join(temp, "instructions.md");
    await writeFile(instructions, request.instructions, { mode: 0o600 });
    const args = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      config,
      "--dangerously-skip-permissions",
      "--settings",
      JSON.stringify({
        disableAllHooks: true,
        autoMemoryEnabled: false,
        claudeMdExcludes: ["**"],
      }),
      "--append-system-prompt-file",
      instructions,
    ];
    if (request.model) args.push("--model", request.model);
    if (typeof request.previousSession?.id === "string")
      args.push("--resume", request.previousSession.id);
    const before =
      typeof request.previousSession?.id === "string"
        ? await claudeSessionCost(home, request.previousSession.id)
        : undefined;
    let hasResult = false,
      ready = false,
      compacting = false,
      compactBoundary = false,
      sessionId: string | undefined;
    // Claude가 마지막으로 알린 살아 있는 백그라운드 일의 수(ambient 제외). 시작·끝 신호를 짝짓지 않고 이 목록을 그대로 쓴다.
    let background = 0;
    /** 턴마다 보고된 사용량의 합과, 세션 누계 비용에서 뺀 이 실행 시도의 비용. 잘못된 턴이 섞인 합은 되살아나지 않는다. */
    // 비용은 합이 아니라 세션 누계 차이이므로 마지막 result의 누계가 앞의 값을 대신한다.
    const reported: Record<UsageField, UsageAmount> = { ...unreportedUsage };
    /** Claude's saved cost to subtract for this run; undefined means unknown. */
    const baseline = (): ClaudeSessionCost | undefined => {
      if (
        typeof sessionId === "string" &&
        sessionId === request.previousSession?.id
      )
        return before;
      return {
        line: -1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    };
    const process = startProcess({
      // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
      stateDir: folders.connection,
      command,
      args,
      cwd: request.cwd,
      env: grant
        ? relayEnvironment(
            env,
            request.access.toolsBaseUrl,
            connection.id,
            grant
          )
        : await withLogin(folders.connection, env),
      container: launch,
      onFrame: async (raw) => {
        if (!raw || typeof raw !== "object") return;
        const frame = raw as Record<string, unknown>;
        if (
          frame.type === "system" &&
          frame.subtype === "compact_boundary" &&
          frame.session_id === request.previousSession?.id
        )
          compactBoundary = true;
        if (frame.type === "system" && frame.subtype === "status")
          compacting = frame.status === "compacting";
        if (frame.type === "system" && frame.subtype === "init") {
          clearTimeout(startup);
          // 백그라운드 일을 마친 뒤의 턴도 init을 다시 낸다. 실행 시도의 시작은 한 번만 알린다.
          const started = !ready;
          ready = true;
          if (typeof frame.session_id === "string")
            sessionId = frame.session_id;
          if (started)
            await control.emit({
              type: "progress",
              text: "프로바이더가 작업을 시작했습니다.",
            });
        }
        if (
          frame.type === "system" &&
          frame.subtype === "background_tasks_changed" &&
          Array.isArray(frame.tasks)
        )
          background = frame.tasks.filter(
            (task) =>
              !task ||
              typeof task !== "object" ||
              (task as Record<string, unknown>).ambient !== true
          ).length;
        if (frame.type !== "result") return;
        // result 프레임의 세션 ID가 init보다 우선한다.
        if (typeof frame.session_id === "string") sessionId = frame.session_id;
        const usage = frame.usage as Record<string, unknown> | undefined;
        // 스트리밍 입력 모드에서 usage는 턴마다이고 total_cost_usd는 이어 간 세션까지 포함한 누계다.
        const sessionBaseline = baseline();
        const add = (field: UsageField, raw: unknown) => {
          reported[field] = addUsage(
            "tokens",
            reported[field],
            usageAmount("tokens", raw)
          );
        };
        add("inputTokens", usage?.input_tokens);
        add("outputTokens", usage?.output_tokens);
        add("cacheReadTokens", usage?.cache_read_input_tokens);
        add("cacheWriteTokens", usage?.cache_creation_input_tokens);
        reported.costUsd = subtractUsage(
          "usd",
          usageAmount("usd", frame.total_cost_usd),
          sessionBaseline === undefined ? null : sessionBaseline.costUsd
        );
        // 실제 프로그램은 오류에도 subtype을 success로 낸다.
        const success = frame.subtype === "success" && frame.is_error !== true;
        result = {
          stopReason: success ? "completed" : "failed",
          error: success ? null : "프로바이더 실행이 실패했습니다.",
          summary: null,
          // 사용량은 실행 시도가 끝날 때 한 번 정한다.
          usage: null,
          nextSession:
            success && typeof frame.session_id === "string"
              ? {
                  id: frame.session_id,
                  launch: {
                    instructions: request.instructions,
                    cwd: request.cwd,
                    model: request.model,
                  },
                }
              : null,
        };
        if (
          !success &&
          (frame.api_error_status === 401 ||
            frame.api_error_status === 403 ||
            saysLoginProblem(frame.result))
        )
          result.errorCode = "login_required";
        if (!hasResult) {
          hasResult = true;
          // 입력을 닫으면 더 보낼 턴이 없다고 알린다. Claude는 기다리던 백그라운드 작업을 마치고 그 결과로 한 턴 더 한 뒤 스스로 끝나며, 프로세스 종료가 실행 시도를 끝낸다.
          process.endInput();
        }
        if (background > 0)
          await control.emit({
            type: "progress",
            text: "백그라운드 작업이 끝나기를 기다립니다.",
          });
      },
    });
    const startup = setTimeout(() => process.end(), startupLimitMs);
    if (request.runId)
      active.set(request.runId, (message) => {
        if (
          !ready ||
          hasResult ||
          compacting ||
          control.signal.aborted ||
          process.closed ||
          // 슬래시 명령만 막는다. "/home/..."처럼 경로로 시작하는 말은 받는다.
          /^\/[^\s/]+(\s|$)/.test(message.body)
        )
          return "rejected";
        return process.write({
          type: "user",
          session_id: "",
          uuid: message.messageId,
          message: { role: "user", content: message.body },
          parent_tool_use_id: null,
        })
          ? "accepted"
          : "rejected";
      });
    const cancel = () => {
      process.write({
        type: "control_request",
        request_id: crypto.randomUUID(),
        request: { subtype: "interrupt" },
      });
      process.end();
    };
    control.signal.addEventListener("abort", cancel, { once: true });
    // 중계가 실패해 권한을 거뒀으면 프로그램을 멈춘다. 프로그램이 다시 시도해도 거둔 권한으로는 상류에 닿지 못한다.
    grant?.failed.addEventListener("abort", cancel, { once: true });
    /** 취소됐거나 result 프레임 없이 끝났으면 Claude가 종료 때 저장한 비용을 읽는다. 새로 저장한 기록이 없으면 null이다. */
    const savedUsage = async () => {
      if (typeof sessionId !== "string") return null;
      const sessionBaseline = baseline();
      if (sessionBaseline === undefined) return null;
      const after = await claudeSessionCost(home, sessionId);
      if (!after) return null;
      // 이어 간 세션에서 Claude가 새 행을 저장하지 않았으면 이 실행의 비용은 모른다.
      if (
        sessionId === request.previousSession?.id &&
        after.line === before?.line
      )
        return null;
      return providerUsage(connection.id, runUsage(after, sessionBaseline));
    };
    try {
      if (control.signal.aborted) cancel();
      else
        process.write({
          type: "user",
          session_id: "",
          message: { role: "user", content: request.prompt },
          parent_tool_use_id: null,
        });
      await process.done;
      // 사용량은 끝난 방식과 상관없이 한 번 정한다. 취소됐거나 결과 프레임이 없었으면 Claude가 종료 때 저장한 비용(진행 중이던 턴 포함)을 먼저 쓰고, 새 기록이 없으면 이미 받은 결과의 사용량을 쓴다.
      const usage =
        (control.signal.aborted || !hasResult ? await savedUsage() : null) ??
        (hasResult ? providerUsage(connection.id, reported) : null);
      if (control.signal.aborted)
        return {
          ...failed(),
          stopReason: "cancelled",
          error: null,
          usage,
        };
      if (grant?.failed.aborted)
        return { ...failed(), error: relayFailure, usage, nextSession: null };
      // Claude가 마지막으로 알린 살아 있는 백그라운드 일이 남은 채 프로그램이 끝났다. 앞 턴의 결과는 중간 결과이므로 성공으로 남기지 않고 세션도 저장하지 않지만, 사용량(보고된 결과 또는 결과 프레임이 없을 때 Claude가 저장한 비용)과 로그인 판정은 남긴다.
      if (background > 0)
        return {
          ...result,
          stopReason: "failed",
          error: "백그라운드 작업이 끝나기 전에 프로바이더가 종료했습니다.",
          nextSession: null,
          usage,
        };
      // 문구에 기대지 않는다. 이전 세션으로 시작조차 못 했으면 새 세션으로 한 번 다시 시도한다.
      if (
        !ready &&
        result.stopReason === "failed" &&
        request.previousSession &&
        !maintenance &&
        result.errorCode !== "login_required"
      ) {
        await control.emit({
          type: "progress",
          text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
        });
        return executeClaude(
          { ...request, previousSession: null },
          control,
          connection
        );
      }
      if (!hasResult) return { ...failed(), usage };
      if (
        maintenance &&
        (!compactBoundary ||
          result.nextSession?.id !== request.previousSession?.id)
      )
        return failed();
      if (
        result.stopReason === "completed" &&
        typeof result.nextSession?.id === "string"
      ) {
        const facts = await claudeSessionFacts(home, result.nextSession.id);
        if (facts) result.sessionMaintenance = facts;
      }
      return { ...result, usage };
    } finally {
      clearTimeout(startup);
      control.signal.removeEventListener("abort", cancel);
      grant?.failed.removeEventListener("abort", cancel);
    }
  } finally {
    grant?.revoke();
    await rm(temp, { recursive: true, force: true });
  }
}
