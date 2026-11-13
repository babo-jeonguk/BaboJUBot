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
// 서버 띄우기·멈추기는 서버 진입점 시험(apps/server/test/main.test.ts의 startMain·stopMain)과 같은 방식이다.

const main = fileURLToPath(
  new URL("../../../server/src/main.ts", import.meta.url)
);
// 시각을 테스트가 정하는 서버의 시험용 진입점. 제품 진입점과 같은 서버를 띄우되 `now`만 IPC로 받은 시각에 고정한다.
const clockMain = fileURLToPath(
  new URL("../../../server/test/clock-server.ts", import.meta.url)
);
const readyTimeoutMs = 60_000;
// 서버의 정리 시한. 기다리는 쪽은 그보다 길게 기다려, 서버가 스스로 끝나며 내장 Postgres를 멈출 기회를 준다.
const shutdownMs = 10_000;
const exitWaitMs = shutdownMs + 5_000;
const killWaitMs = 5_000;

type Exit = { code: number | null; signal: string | null };
type IsolatedServer = {
  url: string;
  /**
   * 서버 시계를 이 시각으로 옮긴다. 기록 시각과 대시보드 기준 시각 모두 이 시계다. 서버가 받았다고 답한 뒤 돌아온다.
   * `clock`을 주고 띄운 서버만 할 수 있다.
   */
  setNow: (iso: string) => Promise<void>;
  /** 서버 프로세스 ID. fixture 시험(isolated-server.spec.ts)이 테스트 도중 서버가 끝나는 경우를 만들 때 쓴다. */
  pid: number;
  stop: () => Promise<void>;
};

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

/**
 * `clock`(ISO 시각)을 주면 서버 시계가 그 시각에 멈춘 채 시작하고 `setNow`로만 움직인다. 없으면 제품 진입점을 실제 시계로 띄운다.
 */
export async function startIsolatedServer({
  clock,
}: { clock?: string } = {}): Promise<IsolatedServer> {
  const home = mkdtempSync(path.join(os.tmpdir(), "babojubot-e2e-isolated-"));
  const child = spawn(process.execPath, [clock ? clockMain : main], {
    env: {
      ...inheritedEnv(),
      HOST: "127.0.0.1",
      PORT: "0",
      DATABASE_URL: "",
      BABOJUBOT_EPHEMERAL_DB: "1",
      BABOJUBOT_HOME: home,
      BABOJUBOT_SHUTDOWN_TIMEOUT_MS: String(shutdownMs),
      // 조직 생성만 보므로 기본 가짜 프로바이더 하나면 된다. 공용 서버의 프로바이더 고르기용 설정은 넘기지 않는다.
      BABOJUBOT_FAKE_PROVIDERS: "1",
      ...(clock && { BABOJUBOT_TEST_CLOCK_START: clock }),
    },
    stdio: clock
      ? ["ignore", "pipe", "pipe", "ipc"]
      : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const output = () =>
    `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
  // 종료 관찰은 시작을 기다리기 전에 붙인다. 시작 전에 끝나도 놓치지 않는다.
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
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
    return { url, pid: child.pid!, setNow: clockSetter(child, !!clock), stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

/** 완전한 시작 줄(`BaboJUBot server on <url> (…)`)이 나올 때까지 기다려 그 주소를 돌려준다. */
function waitForReadyLine(
  child: ChildProcess,
  exited: Promise<Exit>,
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

/** 시계 서버에 시각을 보내고 받았다는 답을 기다린다. 답에 오류가 있으면 던진다. */
function clockSetter(child: ChildProcess, enabled: boolean) {
  let nextId = 0;
  return (iso: string) => {
    if (!enabled)
      return Promise.reject(
        new Error("시계를 옮기려면 `clock`을 주고 서버를 띄워야 한다")
      );
    const id = ++nextId;
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (reply: { id: number; error?: string }) => {
        if (reply.id === id)
          done(reply.error ? new Error(reply.error) : undefined);
      };
      const onExit = () =>
        done(new Error(`시계를 ${iso}로 옮기기 전에 서버가 끝났다`));
      child.on("message", onMessage);
      child.on("exit", onExit);
      child.send({ id, now: iso }, (error) => error && done(error));
    });
  };
}

/** SIGTERM으로 정리를 맡기고 시한 안에 끝나기를 기다린다. 넘기면 SIGKILL하고 실패로 알린다. */
async function stopChild(
  child: ChildProcess,
  exited: Promise<Exit>,
  output: () => string
) {
  // 서버는 이 fixture가 멈추라고 할 때까지 살아 있어야 한다. 그 전에 끝났으면 종료 코드가 0이어도 테스트 도중의 이상이다.
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(
      `격리 E2E 서버가 테스트 중에 끝났다(code ${child.exitCode}, signal ${child.signalCode}): ${output()}`
    );
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

/**
 * 시각이 `clock`에 멈춘 자기 서버에서 도는 테스트. `baseURL`은 그 서버이고, `server.setNow`로 서버 시계를 옮긴다.
 * 날짜 경계를 보는 검사가 실행하는 날의 벽시계에 기대지 않게 한다.
 */
export const withServerClock = (clock: string) =>
  base.extend<{ server: IsolatedServer }>({
    // eslint-disable-next-line no-empty-pattern
    server: async ({}, use) => {
      const server = await startIsolatedServer({ clock });
      try {
        await use(server);
      } finally {
        await server.stop();
      }
    },
    baseURL: async ({ server }, use) => use(server.url),
  });
