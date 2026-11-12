import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

// 공용 E2E 서버(playwright.config.ts)는 모든 spec과 반복 실행이 DB 하나를 같이 써서 비어 있다고 가정할 수 없다.
// 빈 상태나 전체 개수처럼 서버 전체를 보는 검사는 이 fixture가 테스트마다 띄우는 자기 서버에서 한다.
// 서버는 임시 embedded Postgres와 임시 제품 폴더를 쓰고, 빈 port를 골라 빌드된 화면(apps/web/dist)과 API를 한 origin으로 낸다.
// 화면 빌드는 공용 설정의 webServer(`vite build`)가 테스트 전에 끝낸다.

const main = fileURLToPath(
  new URL("../../../server/src/main.ts", import.meta.url)
);
const readyTimeoutMs = 60_000;
// 서버의 정리 시한. 기다리는 쪽은 그보다 길게 기다려, 서버가 스스로 끝나며 내장 Postgres를 멈출 기회를 준다.
const shutdownMs = 10_000;
const exitWaitMs = shutdownMs + 5_000;
const killWaitMs = 5_000;

type IsolatedServer = { url: string; stop: () => Promise<void> };

/**
 * 부모 셸과 공용 설정의 서버 설정이 이 서버에 새지 않게 지운다. 서버가 읽는 설정은 `BABOJUBOT_*`와 아래 이름이다.
 * Windows는 환경 변수 이름의 대소문자를 가리지 않으므로 대문자로 비교한다.
 */
const serverSettings = [
  "DATABASE_URL",
  "HOST",
  "PORT",
  "EMBEDDED_POSTGRES_PORT",
];
function inheritedEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("BABOJUBOT_") || serverSettings.includes(upper))
      delete env[name];
  }
  return env;
}

async function startIsolatedServer(): Promise<IsolatedServer> {
  const home = mkdtempSync(path.join(os.tmpdir(), "babojubot-e2e-isolated-"));
  const child = spawn(process.execPath, [main], {
    env: {
      ...inheritedEnv(),
      HOST: "127.0.0.1",
      PORT: "0",
      DATABASE_URL: "",
      BABOJUBOT_EPHEMERAL_DB: "1",
      BABOJUBOT_HOME: home,
      BABOJUBOT_SHUTDOWN_TIMEOUT_MS: String(shutdownMs),
      BABOJUBOT_FAKE_PROVIDERS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const output = () =>
    `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
  // 종료 관찰은 시작을 기다리기 전에 붙인다. 시작 전에 끝나도 놓치지 않는다.
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    }
  );
  void exited.catch(() => {});

  const stop = async () => {
    try {
      await stopChild(child, exited, output);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  };
  try {
    const url = await waitForReadyLine(child, exited, () => stdout, output);
    return { url, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/** 완전한 시작 줄(`BaboJUBot server on <url> (…)`)이 나올 때까지 기다려 그 주소를 돌려준다. */
function waitForReadyLine(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: string | null }>,
  stdout: () => string,
  output: () => string
) {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      done();
    };
    const onData = () => {
      const match = /^BaboJUBot server on (https?:\/\/\S+) \(.*\)\r?\n/m.exec(
        stdout()
      );
      if (match) finish(() => resolve(match[1]!));
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `격리 E2E 서버가 ${readyTimeoutMs}ms 안에 시작하지 않았다: ${output()}`
            )
          )
        ),
      readyTimeoutMs
    );
    child.stdout!.on("data", onData);
    exited.then(
      ({ code, signal }) =>
        finish(() =>
          reject(
            new Error(
              `격리 E2E 서버가 시작 전에 끝났다(code ${code}, signal ${signal}): ${output()}`
            )
          )
        ),
      (error: unknown) => finish(() => reject(error))
    );
    onData();
  });
}

/** SIGTERM으로 정리를 맡기고 시한 안에 끝나기를 기다린다. 넘기면 SIGKILL하고 실패로 알린다. */
async function stopChild(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: string | null }>,
  output: () => string
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exit = await within(exited, exitWaitMs);
  if (exit) {
    if (exit.code !== 0)
      throw new Error(
        `격리 E2E 서버가 정리에 실패했다(code ${exit.code}, signal ${exit.signal}): ${output()}`
      );
    return;
  }
  child.kill("SIGKILL");
  await within(exited, killWaitMs);
  throw new Error(
    `격리 E2E 서버가 SIGTERM 뒤 ${exitWaitMs}ms 안에 끝나지 않아 SIGKILL했다: ${output()}`
  );
}

async function within<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 테스트마다 빈 DB의 자기 서버를 띄우고 `baseURL`을 그 서버로 바꾼다. 테스트가 끝나면 서버를 멈추고 그 폴더를 지운다. */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const server = await startIsolatedServer();
    try {
      await use(server.url);
    } finally {
      await server.stop();
    }
  },
});
