import { readFileSync } from "node:fs";

/** 서버 자식 프로세스에서 Postgres 준비를 기다리는 데 필요한 관찰만 모은다. */
export type ObservedChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderrText: () => string;
};

export async function waitForPostmaster(
  child: ObservedChild,
  pidFile: string,
  {
    timeoutMs,
    read = (file: string) => readFileSync(file, "utf8"),
  }: { timeoutMs: number; read?: (file: string) => string }
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `server ended before Postgres started (code ${child.exitCode}, signal ${child.signalCode}): ${child.stderrText()}`
      );
    const pid = readPid(pidFile, read);
    if (pid !== undefined) return pid;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Postgres did not start in ${timeoutMs}ms: ${child.stderrText()}`
  );
}

/**
 * 서버로 뜬 postgres의 pid를 한 번 읽는다. 존재 확인과 읽기를 따로 하면 그 사이에 initdb·Postgres가 파일을 지울 수
 * 있으므로 읽기 하나로 관찰한다. 아직 없음·빈 파일·initdb의 음수 pid는 준비 전이고, 그 밖의 읽기 오류는 실패다.
 */
function readPid(pidFile: string, read: (file: string) => string) {
  let text: string;
  try {
    text = read(pidFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(
      `could not read ${pidFile} while waiting for Postgres (${code}): ${(error as Error).message}`,
      { cause: error }
    );
  }
  const pid = Number(text.split("\n")[0]);
  return pid > 0 ? pid : undefined;
}
