import { readFileSync } from "node:fs";
import { pollUntil } from "./support.ts";

/** 서버 자식 프로세스에서 Postgres 준비를 기다리는 데 필요한 관찰만 모은다. */
export type ObservedChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderrText: () => string;
};

/**
 * 서버가 띄운 Postgres가 pid 파일에 번호를 쓸 때까지 기다린다. `observe`는 번호를 읽은 같은 동기 단계에서 그 프로세스를 관찰해
 * (시작 시각 등) 그 결과를 돌려준다. 읽은 뒤 기다림을 거쳐 관찰하면 그사이 그 번호가 다른 프로세스에 쓰였을 수 있다.
 */
export async function waitForPostmaster<T = number>(
  child: ObservedChild,
  pidFile: string,
  {
    timeoutMs,
    read = (file: string) => readFileSync(file, "utf8"),
    observe = (pid: number) => pid as T,
  }: {
    timeoutMs: number;
    read?: (file: string) => string;
    observe?: (pid: number) => T;
  }
): Promise<T> {
  // 확인은 바로 한 번 하고, 그 뒤 간격마다 다시 한다. 준비·자식 종료·읽기나 관찰의 오류 중 하나를 보면 끝낸다.
  return pollUntil(
    () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `server ended before Postgres started (code ${child.exitCode}, signal ${child.signalCode}): ${child.stderrText()}`
        );
      const pid = readPid(pidFile, read);
      return pid === undefined ? undefined : { observed: observe(pid) };
    },
    {
      timeoutMs,
      intervalMs: 20,
      timedOut: () =>
        `Postgres did not start in ${timeoutMs}ms: ${child.stderrText()}`,
    }
  ).then(({ observed }) => observed);
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
