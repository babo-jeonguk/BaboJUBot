import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { attemptEach, combinedFailure } from "@babojubot/contracts";
import { within } from "@babojubot/process/test-support";

// 시험 하나 안에서 Playwright 실행을 따로 띄운다. 안쪽 실행이 끝난 뒤에야 보이는 것(fixture·globalSetup 정리 뒤의 상태, 종료 코드,
// 실패 문구)을 바깥 시험이 확인할 때 쓴다(공용 서버 수명 shared-server.spec.ts, 전역 설정 정리 shared-settings.spec.ts).

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");

/**
 * 안쪽 실행의 환경. 바깥 Playwright의 실행 설정(`TEST_`·`PW_`)과 안쪽 실행이 읽는 시험 전용 키(`prefix`로 시작하는 것)는
 * 부모에서 물려받지 않는다. 시험 전용 키는 `env`에 준 것만 있으므로, 부모 셸에 남은 실패 스위치가 성공 실행을 실패시키지 않는다.
 */
function runEnv(prefix: string, env: Record<string, string>) {
  const outside = Object.keys(env).filter((name) => !name.startsWith(prefix));
  if (outside.length > 0)
    throw new Error(
      `안쪽 실행의 시험 전용 키는 ${prefix}로 시작한다: ${outside.join(", ")}`
    );
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (
      upper.startsWith("TEST_") ||
      upper.startsWith("PW_") ||
      upper.startsWith(prefix.toUpperCase())
    )
      continue;
    inherited[name] = value;
  }
  return { ...inherited, ...env };
}

/**
 * `config`로 Playwright를 돌리고 종료 코드와 출력(stdout·stderr)을 돌려준다. `args`는 `test` 뒤에 붙는다(파일 거르기 등).
 * `env`는 안쪽 실행이 읽는 시험 전용 키 전부이며 모두 `prefix`로 시작한다. 그 밖의 `prefix` 키는 안쪽 실행에 없다.
 * `timeoutMs`가 지나면 안쪽 실행을 끝내고 실패로 알린다.
 */
export async function runPlaywright(options: {
  config: string;
  prefix: string;
  env: Record<string, string>;
  timeoutMs: number;
  args?: string[];
}) {
  const { config, prefix, env, timeoutMs, args = [] } = options;
  const child = spawn(
    process.execPath,
    [cli, "test", "--config", config, ...args],
    {
      cwd: path.dirname(config),
      env: runEnv(prefix, env),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return runToEnd(child, {
    timeoutMs,
    what: "안쪽 Playwright 실행",
  });
}

/**
 * 띄운 자식(stdout·stderr가 파이프)을 끝까지 돌려 종료 코드와 출력(`output`은 stdout·stderr를 받은 차례대로, `stdout`은 표준
 * 출력만)을 돌려준다. 끝은 종료와 출력의
 * 끝을 함께 본다(`exit` 때는 출력이 아직 열려 있을 수 있다, Node 문서 child_process `'exit'`). 그 대기가 어떤 이유로든(`timeoutMs`
 * 시한, 출력 읽기 오류, 시작 실패) 끝나지 않으면 자식을 끄고 그 끝을 확인한 뒤, 원래 실패와 끄기의 실패를 함께 알린다(#287 리뷰
 * STD-3). 띄운 직후 넘겨받아 자식을 남기는 길이 없다.
 */
export async function runToEnd(
  child: ChildProcess,
  { timeoutMs, what }: { timeoutMs: number; what: string }
) {
  let output = "";
  let stdout = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
    stdout += chunk;
  });
  child.stderr!.on("data", (chunk) => (output += chunk));
  // 자식의 끝은 출력과 따로, 거절하지 않는 기록으로 둔다. 끈 뒤의 확인은 출력의 끝이 아니라 이것으로 한다.
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve())
  );
  const ended = Promise.all([
    once(child, "exit") as Promise<[number | null]>,
    once(child.stdout!, "end"),
    once(child.stderr!, "end"),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([ended, timedOut])
    .then(
      (result) =>
        result === "timeout"
          ? {
              ended: false as const,
              failure: new Error(
                `${what}: ${timeoutMs}ms 안에 끝나지 않았다: ${output}`
              ),
            }
          : { ended: true as const, result },
      (error: unknown) => ({ ended: false as const, failure: error })
    )
    .finally(() => clearTimeout(timer));
  if (outcome.ended) {
    const [[code]] = outcome.result;
    return { code, output, stdout };
  }
  const failures = await attemptEach([() => stopChild(child, exited, what)]);
  throw combinedFailure(
    [outcome.failure, ...failures],
    `${what} did not run to its end`
  );
}

/**
 * 끝까지 돌지 못한 자식을 끄고 그 끝을 상한 안에 확인한다. 띄우지 못한 자식(번호 없음)은 끌 것이 없다. Node가 이미 끝을 본 자식에는
 * `kill()`이 신호를 보내지 않으므로, 끝난 자식의 번호가 다른 프로세스에 다시 쓰였어도 신호가 그쪽으로 가지 않는다.
 */
async function stopChild(
  child: ChildProcess,
  exited: Promise<void>,
  what: string
) {
  if (child.pid === undefined) return;
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  await within(exited, 10_000, `${what}: the stopped child did not exit`);
}
