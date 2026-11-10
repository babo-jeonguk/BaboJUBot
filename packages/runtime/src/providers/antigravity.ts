import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderConnection,
  RunResult,
  UsageAmount,
  UsageField,
} from "@babojubot/contracts";
import {
  addUsage,
  subtractUsage,
  unreportedUsage,
  usageAmount,
} from "@babojubot/contracts";
import { providerUsage } from "./usage.ts";
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
  configFailure,
  configRefused,
  ownerMark,
  publishConfig,
} from "./antigravity-config.ts";
import type { ContainerSettings } from "./container.ts";
import { placeAttempt, type ContainerLaunch } from "./container.ts";
import { connectionFolders } from "./folders.ts";
import { loginLink } from "./login-link.ts";
const workspaces = new Map<string, Promise<void>>();
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
  for (const org of await readdir(organizations, { withFileTypes: true }).catch(
    () => []
  )) {
    if (!org.isDirectory()) continue;
    const shared = path.join(organizations, org.name, "shared");
    // 정리는 조직마다 별도 프로세스를 띄운다. 설정 폴더가 없으면 지울 것이 없으므로 띄우지 않는다.
    if (await missing(path.join(shared, ".agents"))) continue;
    try {
      await clearOwnedConfig(shared);
    } catch {
      /* Preserve unowned files. */
    }
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
}): ProviderConnection {
  const connectionId = options.id ?? "antigravity";
  const folders = connectionFolders(options.dataDir, connectionId);
  const home = folders.connection,
    command = options.command ?? commandFor(connectionId, "agy");
  /** 연결의 로그인 원본. 컨테이너에는 이 폴더만 함께 쓰기로 넣는다. */
  const loginFolder = path.join(home, "login");
  const original = path.join(loginFolder, "antigravity-oauth-token");
  // 키링이 없는 컴퓨터·컨테이너에서 agy는 HOME의 이 파일로 로그인하고, 갱신하면 링크를 따라 원본 자리에 덮어쓴다(1.5.3 실측, #126).
  const tokenAt = (productHome: string) =>
    path.join(
      productHome,
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token"
    );
  const shareLogin = loginLink({
    original,
    fallback: tokenAt(home),
    label: "Antigravity",
  });
  /** 연결 폴더도 조직 폴더와 같은 링크로 로그인을 읽는다. 로그인 명령·준비 확인·모델 목록이 조직 실행과 같은 로그인을 본다. */
  const prepare = async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await shareLogin(tokenAt(home));
  };
  const env = (productHome = home) =>
    providerEnvironment(connectionId, productHome, {
      XDG_CONFIG_HOME: path.join(productHome, "config"),
      XDG_DATA_HOME: path.join(productHome, "data"),
      XDG_CACHE_HOME: path.join(productHome, "cache"),
    });
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
      try {
        await prepare();
        // 실행이 읽는 로그인(링크면 원본, 링크를 만들 수 없는 컴퓨터면 연결 폴더의 파일)을 다시 쓰지 못하면 조직 실행이 낡은 로그인을 읽는다. 없으면(키링에 둔 로그인 등) 프로그램의 응답으로 판단한다.
        // Windows의 access는 링크를 따라가지 않으므로 실제 파일을 찾아 본다.
        const login = await realpath(tokenAt(home)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          }
        );
        if (login) await access(login, constants.R_OK | constants.W_OK);
      } catch {
        return { status: "not_ready", reason: "check_failed" };
      }
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
      let release: (() => void) | undefined,
        cwd: string | undefined,
        attempt: string | undefined,
        owned = false;
      try {
        if (control.signal.aborted)
          return { ...failure(), stopReason: "cancelled", error: null };
        // 그 조직의 제품 폴더로 돈다. 로그인은 연결의 원본 하나를 링크로 쓴다.
        const organization = folders.organization(
          request.identity.organizationId
        );
        await prepare();
        const linked = await shareLogin(tokenAt(organization));
        // 링크 없이 연결 폴더를 컨테이너에 넣지 않는다.
        if (!linked && request.execution === "container") return failure();
        const productHome = linked ? organization : home;
        const placement = placeAttempt(options.container, productHome, request);
        if (!placement) return failure();
        // 준비 확인을 거치지 않아도 실행 환경은 있어야 한다.
        await mkdir(productHome, { recursive: true, mode: 0o700 });
        cwd = await realpath(request.workspace?.cwd ?? productHome);
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
        // 프로세스가 도중에 끝나면 게시됐는지 알 수 없다. 거부가 확실할 때만 정리 책임을 내려놓는다.
        owned = true;
        const settings = JSON.stringify({
          babojubotOwner: ownerMark,
          mcpServers: {
            organization: {
              serverUrl: new URL("/api/tools/mcp", request.access.toolsBaseUrl)
                .href,
              headers: { Authorization: `Bearer ${request.access.token}` },
            },
          },
        });
        // 컨테이너에서는 조직 폴더가 그 조직의 모든 컨테이너에 쓰기로 들어간다. 토큰이 든 설정은 이 실행 시도 전용 폴더에 두고
        // 이 컨테이너에만 작업 폴더의 설정 파일 위에 읽기로 넣는다. 조직 폴더에는 토큰 없는 제품 소유 파일이 자리만 잡는다.
        let container: ContainerLaunch | undefined;
        if (placement.container) {
          attempt = await mkdtemp(path.join(os.tmpdir(), "babojubot-attempt-"));
          const file = path.join(attempt, "mcp_config.json");
          await writeFile(file, settings, { mode: 0o600, flag: "wx" });
          container = placement.container({
            cwd,
            program: "agy",
            files: [
              {
                source: file,
                target: path.join(cwd, ".agents", "mcp_config.json"),
              },
            ],
            shared: linked ? [loginFolder] : [],
          });
        }
        const published = await publishConfig(
          cwd,
          container
            ? JSON.stringify({ babojubotOwner: ownerMark, mcpServers: {} })
            : settings
        );
        if (published) {
          owned = !configRefused(published);
          return failure(configFailure(published));
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
        const previous =
          typeof request.previousSession?.id === "string"
            ? request.previousSession.id
            : null;
        if (previous) args.push("--conversation", previous);
        let id: string | undefined,
          result = failure(),
          finished = false;
        /** 완료된 step마다 보고된 사용량의 합. 잘못된 step이 섞인 합은 되살아나지 않는다. */
        const usage: Record<UsageField, UsageAmount> = { ...unreportedUsage };
        const steps = new Set<number>();
        const child = startProcess({
          // 프로세스 기록은 에이전트가 고칠 수 있는 조직 폴더가 아니라 연결 폴더에 둔다.
          stateDir: home,
          command,
          args,
          cwd,
          env: env(productHome),
          container,
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
              // 프로그램은 없는 대화를 받으면 새 대화로 시작한다. 파일 위치를 가정하지 않고 시작한 대화로 판단한다.
              if (previous && id !== previous)
                await control.emit({
                  type: "progress",
                  text: "이전 세션을 이어 갈 수 없어 새 세션으로 시작합니다.",
                });
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
              const input = usageAmount("tokens", step.usage.input_tokens),
                cached = usageAmount("tokens", step.usage.cache_read_tokens);
              // 입력은 캐시 읽기를 포함하므로 뺀다. 캐시 읽기를 보고하지 않은 step은 그대로 둔다.
              usage.inputTokens = addUsage(
                "tokens",
                usage.inputTokens,
                subtractUsage("tokens", input, cached ?? 0)
              );
              usage.cacheReadTokens = addUsage(
                "tokens",
                usage.cacheReadTokens,
                cached
              );
              usage.outputTokens = addUsage(
                "tokens",
                usage.outputTokens,
                usageAmount("tokens", step.usage.output_tokens)
              );
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
                // 사용량은 실행 시도가 끝날 때 한 번 정한다.
                usage: null,
                nextSession: success ? { id: id! } : null,
              };
              if (saysLoginProblem(frame.result?.error))
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
          const exited = await child.done;
          // 끝난 방식과 상관없이 완료된 step의 합으로 사용량을 한 번 정한다. 결과도 완료된 step도 없으면 보고 안 됨이다.
          const collected =
            finished || steps.size > 0
              ? providerUsage(connectionId, usage)
              : null;
          if (control.signal.aborted)
            return {
              ...failure(),
              stopReason: "cancelled",
              error: null,
              usage: collected,
            };
          // 로그인이 없으면 프로그램이 결과 없이 오류 문구만 남기고 끝난다(1.5.3).
          if (!finished && saysLoginProblem(exited.stderr))
            return { ...result, errorCode: "login_required", usage: collected };
          return { ...result, usage: collected };
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
          // 정리에 실패해도 실행 결과는 그대로 돌려준다. 토큰은 실행 시도가 끝나면 무효다.
          if (owned && cwd) await clearOwnedConfig(cwd);
        } catch {
          console.warn(
            "[provider] could not remove the Antigravity configuration"
          );
        } finally {
          if (attempt)
            await rm(attempt, { recursive: true, force: true }).catch(() => {});
          if (release && cwd) {
            workspaces.delete(cwd);
            release();
          }
        }
      }
    },
  };
  return {
    id: connectionId,
    label: options.label ?? "Antigravity",
    isolatable: true,
    login: { command, args: [], env: env() },
    adapter,
    models: [],
    async listModels(signal) {
      await prepare();
      return (await probe(["models"], signal)).split("\n").flatMap((line) => {
        const [id, label] = line.split("\t");
        return id && label ? [{ id, label }] : [];
      });
    },
  };
}
