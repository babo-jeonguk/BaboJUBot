import { spawn } from "node:child_process";
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
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  // 종료와 출력의 끝을 한 대기로 본다. `exit` 때는 출력이 아직 열려 있을 수 있어(Node 문서 child_process `'exit'`) 부른 쪽이 단언할
  // 출력은 그 끝까지 읽은 것이고, 어느 길에서도 이 대기를 버리지 않는다(#287 리뷰 STD-2).
  const ended = Promise.all([
    once(child, "exit") as Promise<[number | null]>,
    once(child.stdout!, "end"),
    once(child.stderr!, "end"),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const finished = await Promise.race([ended, timedOut]).finally(() =>
    clearTimeout(timer)
  );
  if (!finished) {
    child.kill("SIGKILL");
    // 끈 실행도 끝까지 본다. 끝나지 않으면 그 실패를 시한 실패와 함께 알린다.
    const failures = await attemptEach([
      () =>
        within(
          ended,
          10_000,
          "the stopped inner Playwright run did not exit and end its output"
        ),
    ]);
    throw combinedFailure(
      [
        new Error(
          `안쪽 Playwright 실행이 ${timeoutMs}ms 안에 끝나지 않았다: ${output}`
        ),
        ...failures,
      ],
      "안쪽 Playwright 실행이 시한 안에 끝나지 않았다"
    );
  }
  const [[code]] = finished;
  return { code, output };
}
