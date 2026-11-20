import { spawnSync } from "node:child_process";

/**
 * `ps -o <칸>= -p <pid>`로 프로세스 하나의 칸 하나를 읽는다. 대상이 없으면 ps는 아무것도 쓰지 않고 1로 끝나므로(macOS·procps)
 * 그때만 `undefined`다. 띄우지 못했거나 시한을 넘겼거나, 다른 종료 코드·오류 출력·빈 성공으로 끝나면 pid와 원인을 담아 던진다.
 * 동기 실행이라 `timeoutMs`를 반드시 받는다.
 */
export function psField(
  pid: number,
  field: string,
  timeoutMs: number
): string | undefined {
  const result = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const out = result.stdout?.trim() ?? "";
  const reported = result.stderr?.trim() ?? "";
  if (!result.error && result.status === 0 && out) return out;
  if (!result.error && result.status === 1 && !out && !reported)
    return undefined;
  const ending = result.error
    ? ((result.error as NodeJS.ErrnoException).code ?? result.error.name)
    : result.status === 0
      ? "no output"
      : `exit ${result.status ?? result.signal}`;
  throw new Error(
    `ps could not read ${field} of process ${pid} (${ending})${reported ? `: ${reported}` : ""}`,
    { cause: result.error }
  );
}
