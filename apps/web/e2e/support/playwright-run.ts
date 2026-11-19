import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";

// 시험 하나 안에서 Playwright 실행을 따로 띄운다. 안쪽 실행이 끝난 뒤에야 보이는 것(fixture·globalSetup 정리 뒤의 상태, 종료 코드,
// 실패 문구)을 바깥 시험이 확인할 때 쓴다(공용 서버 수명 shared-server.spec.ts, 전역 설정 정리 shared-settings.spec.ts).

const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");

/** 바깥 Playwright의 실행 설정이 안쪽 실행에 새지 않게 지운다. */
function runEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (upper.startsWith("TEST_") || upper.startsWith("PW_")) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/**
 * `config`로 Playwright를 돌리고 종료 코드와 출력(stdout·stderr)을 돌려준다. `args`는 `test` 뒤에 붙는다(파일 거르기 등).
 * `timeoutMs`가 지나면 안쪽 실행을 끝내고 실패로 알린다.
 */
export async function runPlaywright(options: {
  config: string;
  env: Record<string, string>;
  timeoutMs: number;
  args?: string[];
}) {
  const { config, env, timeoutMs, args = [] } = options;
  const child = spawn(
    process.execPath,
    [cli, "test", "--config", config, ...args],
    {
      cwd: path.dirname(config),
      env: runEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const exit = once(child, "exit") as Promise<[number | null]>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  const finished = await Promise.race([exit, timedOut]).finally(() =>
    clearTimeout(timer)
  );
  if (!finished) {
    child.kill("SIGKILL");
    await exit;
    throw new Error(
      `안쪽 Playwright 실행이 ${timeoutMs}ms 안에 끝나지 않았다: ${output}`
    );
  }
  const [code] = finished;
  return { code, output };
}
