import { tmpdir } from "node:os";
import path from "node:path";
import { prepareJobObjectLauncher } from "./job-object.ts";

// 감독 실행기(#268)의 입구. 이 커밋은 시험이 쓰는 입구만 두고 예전 동작(Windows 묶음 실행기, Linux·macOS는 Node.js가 직접 띄움)을
// 따른다. 실행기는 다음 커밋에서 구현한다.

export type Supervisor =
  { ok: true; file: string } | { ok: false; reason: string };

export type SupervisorLaunch =
  | {
      kind: "launch";
      launch: {
        file: string;
        args: string[];
        options: { argv0?: string; windowsVerbatimArguments?: boolean };
      };
    }
  | { kind: "unavailable"; reason: string }
  | { kind: "not-found" };

export async function prepareSupervisor(
  options: { file?: string } = {}
): Promise<Supervisor> {
  if (process.platform !== "win32")
    return { ok: true, file: options.file ?? "" };
  const launcher = await prepareJobObjectLauncher(
    path.join(tmpdir(), "babojubot-test-launcher")
  );
  return launcher?.ok
    ? { ok: true, file: launcher.file }
    : { ok: false, reason: launcher?.reason ?? "unknown" };
}

export function supervisorLaunch(
  _command: readonly [string, ...string[]],
  _args: readonly string[],
  _options: { env: NodeJS.ProcessEnv; cwd: string }
): SupervisorLaunch {
  return {
    kind: "unavailable",
    reason: "the supervisor is not implemented yet",
  };
}
