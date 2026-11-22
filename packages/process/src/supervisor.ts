import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvedCommand,
  superviseTree,
  windowsLaunch,
  type SupervisorCommand,
} from "./supervised.ts";

export { supervisorProtocol } from "./supervised.ts";

/**
 * 감독 실행기(#268). 세 OS 모두 실행 시도마다 이 Rust 프로그램(`packages/process/supervisor`) 하나가 프로그램을 띄우고 그 트리를
 * 쥔다: Linux·macOS는 프로그램의 프로세스 그룹을 마지막 신호까지 거두지 않은 채, Windows는 프로그램을 묶음(Job Object)에 넣은 채.
 * 공용 실행(`launch.ts`)이 실행기를 띄우고 넷째 표준 핸들의 제어 통로로 말한다. 통로의 약속은 실행기의 `src/protocol.rs` 머리말에
 * 있고, 서버가 사라져 통로가 끝나면 실행기가 스스로 트리를 끈다. 실행기를 준비하지 못하면 공용 실행이 프로그램을 띄우지 않고
 * 거절한다(Node.js가 직접 띄우는 길은 없다).
 *
 * 서버는 시작할 때 실행기를 찾아 해가 없는 시험 실행으로 약속대로 도는지 본다. 시험 실행은 실제 실행과 같은 코드(`supervised.ts`)로
 * 띄우고 끈다. 실행기는 저장소 소스에서 빌드한다
 * (`pnpm --filter @babojubot/process run build`). 실행 파일은 Git에 넣지 않는다.
 */

const trialLimitMs = 15_000;
const windows = () => process.platform === "win32";

/**
 * 이 시스템의 빌드 대상(빌드 명령 `supervisor/build.mjs`와 같은 표). Linux는 glibc에 매이지 않는 정적 musl 실행 파일이다. 실행기가
 * 없는 시스템이면 `undefined`다.
 */
function buildTarget() {
  const targets: unknown = JSON.parse(
    readFileSync(new URL("../supervisor/targets.json", import.meta.url), "utf8")
  );
  if (typeof targets !== "object" || targets === null) return undefined;
  const target: unknown = Reflect.get(
    targets,
    `${process.platform} ${process.arch}`
  );
  return typeof target === "string" ? target : undefined;
}

/** checkout에서 빌드한 실행기의 자리. */
function builtFile() {
  const target = buildTarget();
  if (target === undefined) return undefined;
  const name = windows() ? "babojubot-supervisor.exe" : "babojubot-supervisor";
  return fileURLToPath(
    new URL(`../supervisor/target/${target}/release/${name}`, import.meta.url)
  );
}

export type Supervisor =
  { ok: true; file: string } | { ok: false; reason: string };
let supervisor: Supervisor | undefined;

/** 실행기로 띄우는 방법, 또는 띄울 수 없는 이유. */
export type SupervisorLaunch =
  | { kind: "launch"; launch: SupervisorCommand }
  /** 쓸 수 없다: 준비하다 실패했거나 이 프로세스가 준비를 부르지 않았다. 이유는 `supervisorProblem`과 같다. */
  | { kind: "unavailable"; reason: string }
  /** Windows: 프로그램을 찾지 못했다. cross-spawn으로 띄우면 cmd.exe가 돌다 끝나며 시작 실패(ENOENT)로 알린다. */
  | { kind: "not-found" };

/** 실행기를 쓸 수 없는 이유. 쓸 수 있으면 `undefined`다. */
export function supervisorProblem() {
  if (!supervisor)
    return "the supervisor was not prepared in this process (prepareSupervisor)";
  return supervisor.ok ? undefined : supervisor.reason;
}

/** 프로그램을 실행기로 띄우는 방법. */
export function supervisorLaunch(
  command: readonly [string, ...string[]],
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string }
): SupervisorLaunch {
  // Windows에서 찾지 못한 프로그램은 준비와 상관없이 먼저 가려 둔다(cross-spawn과 같은 시작 오류로 알린다).
  const resolved = windows()
    ? resolvedCommand(command[0], [...command.slice(1), ...args], options)
    : undefined;
  if (windows() && !resolved) return { kind: "not-found" };
  if (!supervisor?.ok)
    return { kind: "unavailable", reason: supervisorProblem() ?? "unknown" };
  return {
    kind: "launch",
    launch: resolved
      ? windowsLaunch(
          supervisor.file,
          resolved.application,
          resolved.commandLine
        )
      : { file: supervisor.file, args: [...command, ...args], options: {} },
  };
}

const windowsFolder = () =>
  process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";

/**
 * 실행기를 띄워 실제 실행과 같은 약속대로 도는지 본다(`superviseTree`, 같은 해석기와 순서 검사). 해가 없는 `exit 7`을 실행기 아래에서
 * 돌려, 약속 판 → 시작(`ok`) → 프로그램 끝 `exit 7` → 끄기 → `ended` → 실행기의 정상 종료와 통로의 닫힘까지 모두 와야 성공이다.
 * 빠지거나 순서가 어긋나면 거부한다. 이 모두에 시한 하나를 둔다: 넘기면 실행기를 강제로 끝내고 통로를 닫은 뒤 준비 실패로 다룬다.
 */
async function trial(file: string): Promise<Supervisor> {
  const command = windows()
    ? windowsLaunch(
        file,
        path.join(windowsFolder(), "System32", "cmd.exe"),
        "cmd.exe /d /c exit 7"
      )
    : { file, args: ["/bin/sh", "-c", "exit 7"], options: {} };
  const { tree, abandon } = superviseTree(
    command,
    {
      command: windows() ? ["cmd.exe"] : ["/bin/sh"],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "ignore", "ignore"],
    },
    randomUUID()
  );
  const run = async (): Promise<Supervisor> => {
    const start = await tree.started;
    if (start.kind === "failed") {
      await tree.stop();
      return { ok: false, reason: start.reason };
    }
    const exit = await tree.exited;
    if (exit.code !== 7) {
      await tree.stop();
      return {
        ok: false,
        reason: `the supervisor's trial program ended with ${exit.signal ?? `code ${exit.code}`}, not code 7`,
      };
    }
    await tree.stop({ graceMs: 0 });
    return { ok: true, file };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run().catch((error: unknown) => ({
        ok: false as const,
        reason: `the supervisor's trial did not end as it should: ${error instanceof Error ? error.message : String(error)}`,
      })),
      new Promise<Supervisor>((resolve) => {
        timer = setTimeout(() => {
          abandon();
          resolve({
            ok: false,
            reason: `the supervisor's trial did not finish within ${trialLimitMs} ms`,
          });
        }, trialLimitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 서버 시작 때 한 번 부른다. 실행기(기본은 checkout에서 빌드한 것, `file`로 바꿀 수 있다)를 찾아 시험 실행하고, 이후 실행 시도가
 * 그것을 쓴다. 어떤 이유로든 준비하지 못하면 던지지 않고(서버는 뜬다) 서버 운영 기록에 남긴다. 그때 실행 시도는 띄우지 않고 그
 * 이유로 실패한다(대시보드의 실행 시도 실패 원인).
 */
export async function prepareSupervisor(
  options: { file?: string } = {}
): Promise<Supervisor> {
  const file = options.file ?? builtFile();
  try {
    supervisor =
      file === undefined
        ? {
            ok: false,
            reason: `this system (${process.platform} ${process.arch}) has no supervisor build`,
          }
        : !existsSync(file)
          ? {
              ok: false,
              reason: `the supervisor program was not found at ${file}; build it with "pnpm --filter @babojubot/process run build"`,
            }
          : await trial(file);
  } catch (error) {
    supervisor = {
      ok: false,
      reason: `the supervisor could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!supervisor.ok)
    console.warn(
      `[provider] the supervisor is not available, so runs are refused until it is: ${supervisor.reason}`
    );
  return supervisor;
}
