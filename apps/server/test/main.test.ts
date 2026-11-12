import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@babojubot/db/testing";
import { listOrganizations } from "@babojubot/db";
import { afterAll, beforeAll, expect, it } from "vitest";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const readyTimeoutMs = 45_000;
// 종료 신호 뒤 서버가 끝나기까지. 서버의 기본 종료 시한(30초)보다 길게 둔다.
const shutdownWaitMs = 35_000;
// SIGKILL 뒤 종료가 보고되기까지.
const killWaitMs = 10_000;

let external: TestDatabase;
beforeAll(async () => {
  external = await createTestDatabase();
});
afterAll(async () => {
  await external?.close();
});

it("starts against an external Postgres URL and leaves that Postgres running on shutdown", async () => {
  const child = startMain({ DATABASE_URL: external.url });
  try {
    await child.ready;
    expect(child.stdoutText()).toContain("external Postgres");
    const url = child.stdoutText().match(/BaboJUBot server on (\S+)/)![1]!;

    const res = await fetch(`${url}/api/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "외부 DB 조직", goal: "외부 DB 목표" }),
    });
    expect(res.status).toBe(201);
  } finally {
    await stopMain(child);
  }

  // The server only owned its connections: the external database still answers.
  expect((await listOrganizations(external.db)).map((o) => o.name)).toContain(
    "외부 DB 조직"
  );
});

// 부모 셸의 서버 설정(BABOJUBOT_*)은 이 파일의 서버 시험에 새지 않는다. 시험이 고르지 않은 설정이 고장 나 있어도
// 서버는 그 설정과 무관하게 뜬다. 고장 난 모델 목적지 설정으로 확인한다(서버가 시작할 때 JSON으로 읽는다).
it("ignores the parent's server settings that the test did not choose", async () => {
  const saved = process.env.BABOJUBOT_MODEL_DESTINATIONS;
  process.env.BABOJUBOT_MODEL_DESTINATIONS = "not json";
  let child: MainProcess | undefined;
  try {
    child = startMain({ DATABASE_URL: external.url });
  } finally {
    if (saved === undefined) delete process.env.BABOJUBOT_MODEL_DESTINATIONS;
    else process.env.BABOJUBOT_MODEL_DESTINATIONS = saved;
  }
  try {
    await child!.ready;
  } finally {
    await stopMain(child!);
  }
});

// 종료 신호는 서버 진입점 하나가 받아, 서버 정리를 끝낸 뒤 DB를 닫고 성공으로 끝난다.
// 라이브러리가 같은 신호로 먼저 프로세스를 끝내면 서버 정리가 잘리고 종료 코드가 128+신호 번호가 된다.
it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "finishes its own shutdown on %s with an external Postgres",
  async (signal) => {
    const child = startMain({ DATABASE_URL: external.url });
    try {
      await child.ready;
      child.kill(signal);
      const { code } = await waitExit(child, shutdownWaitMs);
      expect(code, child.stderrText()).toBe(0);
      expect(child.stderrText()).toBe("");
    } finally {
      await stopMain(child);
    }
  },
  60_000
);

// 터미널의 Ctrl+C와 창 닫힘은 서버와 같은 프로세스 그룹 전체에 간다. 내장 Postgres가 그 신호로 따로 멈추면
// 서버가 정리하는 동안 연결이 끊긴다. 서버가 정리를 마치고 DB를 닫을 때까지 Postgres가 살아 있어야 한다.
it.each(["SIGINT", "SIGHUP"] as const)(
  "closes the embedded Postgres only after its own shutdown when the terminal sends %s to the whole group",
  async (signal) => {
    const child = startMain({ BABOJUBOT_EPHEMERAL_DB: "1" }, { group: true });
    try {
      await child.ready;
      process.kill(-child.pid!, signal);
      const { code } = await waitExit(child, shutdownWaitMs);
      expect(code, child.stderrText()).toBe(0);
      expect(child.stderrText()).toBe("");
    } finally {
      await stopMain(child, { group: true });
    }
  },
  60_000
);

// 시작하는 동안 온 종료 신호에도 서버가 띄운 내장 Postgres를 멈추고 끝난다. 남으면 다음 시작이 그 폴더를 못 쓴다.
it("stops the embedded Postgres it was starting when a stop signal arrives during startup", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "babojubot-main-test-"));
  const pidFile = path.join(home, "postgres", "postmaster.pid");
  const child = startMain({
    BABOJUBOT_HOME: home,
    EMBEDDED_POSTGRES_PORT: "0",
  });
  let postgresPid = 0;
  try {
    postgresPid = await waitForPostmaster(child, pidFile);
    expect(postgresPid).toBeGreaterThan(0);
    child.kill("SIGTERM");
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(0);
    expect(isAlive(postgresPid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  } finally {
    await stopMain(child);
    if (postgresPid && isAlive(postgresPid)) {
      try {
        process.kill(postgresPid, "SIGKILL");
      } catch {
        /* Already gone between the check and the signal. */
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

// 시작이 실패하면 그 사이 종료 신호가 왔어도 실패로 끝나야 서비스 관리자가 알 수 있다.
// Postgres port 범위(1..65535) 밖의 번호는 initdb 뒤 Postgres 시작에서 반드시 실패한다.
it("ends with a failure when the start fails after a stop signal arrived during startup", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "babojubot-main-test-"));
  const child = startMain({
    BABOJUBOT_HOME: home,
    EMBEDDED_POSTGRES_PORT: "65536",
  });
  try {
    await waitForPath(child, path.join(home, "postgres"));
    child.kill("SIGTERM");
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(1);
    expect(child.stderrText()).toContain(
      "embedded Postgres exited before it was ready"
    );
  } finally {
    await stopMain(child);
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

// 정리가 멈추면 정해진 시한(BABOJUBOT_SHUTDOWN_TIMEOUT_MS)에 실패로 끝난다. 서버를 감싼 실행기(Playwright·Docker·
// Kubernetes)는 그보다 긴 시한을 두어, 서버가 스스로 끝나며 내장 Postgres를 멈출 기회를 갖는다.
// 멈춘 Postgres로 정리가 끝나지 않는 상황을 만든다. 서버가 끝난 뒤 다시 움직인 Postgres는 받은 정지 신호로 끝난다.
it("ends with a failure at its configured shutdown deadline and leaves no Postgres behind", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "babojubot-main-test-"));
  const child = startMain({
    BABOJUBOT_HOME: home,
    EMBEDDED_POSTGRES_PORT: "0",
    BABOJUBOT_SHUTDOWN_TIMEOUT_MS: "2000",
  });
  let postgresPid = 0;
  try {
    await child.ready;
    postgresPid = Number(
      readFileSync(path.join(home, "postgres", "postmaster.pid"), "utf8").split(
        "\n"
      )[0]
    );
    process.kill(postgresPid, "SIGSTOP");
    const stoppedAt = Date.now();
    child.kill("SIGTERM");
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(1);
    // 시한은 프로세스가 끝나는 시각까지다. 프로세스 종료 때의 비상 정지도 그 안에 든다.
    // 타이머를 이 경계에 두므로 스케줄러가 늦게 깨는 몫을 더 두되, 기본 시한(30s)보다는 크게 짧게 잡는다.
    expect(Date.now() - stoppedAt).toBeLessThan(2_000 + 1_000);
    expect(child.stderrText()).toContain("did not finish");

    process.kill(postgresPid, "SIGCONT");
    const deadline = Date.now() + 15_000;
    while (isAlive(postgresPid) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(postgresPid)).toBe(false);
  } finally {
    await stopMain(child);
    if (postgresPid && isAlive(postgresPid)) {
      try {
        process.kill(postgresPid, "SIGCONT");
        process.kill(postgresPid, "SIGKILL");
      } catch {
        /* Already gone between the check and the signal. */
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

// 정리 시한이 잘못 설정되면 시작하지 않고 설정 오류로 알린다. Node 타이머는 1ms 미만이나 2147483647ms 초과를
// 1ms로 바꾸므로, 그대로 쓰면 첫 종료 신호에 정리가 바로 끊긴다.
it.each(["-1", "0", "1.5", "Infinity", "2147483648", "soon"])(
  "refuses to start with the shutdown deadline %s",
  async (value) => {
    const child = startMain({
      DATABASE_URL: external.url,
      BABOJUBOT_SHUTDOWN_TIMEOUT_MS: value,
    });
    try {
      expect(await startOutcome(child)).toEqual({ code: 1 });
      expect(child.stderrText()).toContain("BABOJUBOT_SHUTDOWN_TIMEOUT_MS");
    } finally {
      await stopMain(child);
    }
  },
  60_000
);

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type MainProcess = ChildProcess & {
  stdoutText: () => string;
  stderrText: () => string;
  exited: Promise<Exit>;
  ready: Promise<void>;
};

/**
 * 부모 셸의 서버 설정이 테스트가 고른 환경을 이기지 않게 지운다. 서버가 읽는 설정은 `BABOJUBOT_*`와 아래 이름이다.
 * 목록으로 지우면 서버에 설정이 늘 때마다 빠진다. BABOJUBOT_HOME은 테스트 setup(product-home.ts)이 정한 값을 남긴다.
 */
const serverSettings = [
  "DATABASE_URL",
  "HOST",
  "PORT",
  "EMBEDDED_POSTGRES_PORT",
];
function inheritedEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (
      (name.startsWith("BABOJUBOT_") && name !== "BABOJUBOT_HOME") ||
      serverSettings.includes(name)
    )
      delete env[name];
  return env;
}

function startMain(
  env: Record<string, string>,
  { group = false } = {}
): MainProcess {
  const child = spawn(process.execPath, [main], {
    env: {
      ...inheritedEnv(),
      HOST: "127.0.0.1",
      PORT: "0",
      BABOJUBOT_PROVIDERS: "",
      BABOJUBOT_FAKE_PROVIDERS: "1",
      BABOJUBOT_FAKE_PROVIDER_SETTINGS: "{}",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: group,
  }) as MainProcess;
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdoutText = () => stdout;
  child.stderrText = () => stderr;
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  void exited.catch(() => {});
  child.exited = exited;
  child.ready = waitForReady(
    child,
    () => stdout,
    () => stderr
  );
  void child.ready.catch(() => {});
  return child;
}

/** 시작 줄이 나올 때까지 기다린다. stdout은 끝까지 읽어 둔다(멈추면 서버의 쓰기가 막힌다). */
function waitForReady(
  child: MainProcess,
  stdout: () => string,
  stderr: () => string
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      done();
    };
    const onData = () => {
      if (/^BaboJUBot server on (https?:\/\/\S+) \(.*\)\r?\n/m.test(stdout()))
        finish(resolve);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() =>
        reject(
          new Error(
            `server ended before it was ready (code ${code}, signal ${signal}): stdout=${JSON.stringify(stdout())} stderr=${JSON.stringify(stderr())}`
          )
        )
      );
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `server did not become ready in ${readyTimeoutMs}ms: stdout=${JSON.stringify(stdout())} stderr=${JSON.stringify(stderr())}`
            )
          )
        ),
      readyTimeoutMs
    );
    child.stdout!.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null)
      onExit(child.exitCode, child.signalCode);
  });
}

/** 시작도 종료도 하지 못한 경우를 구분해 돌려준다. 시작했다면 finally가 끝낸다. */
async function startOutcome(child: MainProcess) {
  try {
    await child.ready;
    return { started: true };
  } catch (error) {
    const exit = await waitExit(child, 1_000).catch(() => undefined);
    return exit ? { code: exit.code } : { error: String(error) };
  }
}

/** 이미 붙여 둔 종료 관찰을 시한 안에서 기다린다. 시한은 기다리기 시작할 때부터 센다. */
async function waitExit(child: MainProcess, ms: number): Promise<Exit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `server ${child.pid} did not exit in ${ms}ms (exit code ${child.exitCode}, signal ${child.signalCode}): stdout=${JSON.stringify(child.stdoutText().slice(-2000))} stderr=${JSON.stringify(child.stderrText().slice(-2000))}`
              )
            ),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 자식이 살아 있으면 끝내고, 이미 끝났으면 그 종료를 기다린다. 그룹 테스트는 남은 그룹까지 정리한다. */
async function stopMain(child: MainProcess, { group = false } = {}) {
  if (group) killGroup(child);
  else if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  try {
    await waitExit(child, killWaitMs);
  } catch (error) {
    // spawn 오류는 시작 실패로 이미 드러났다. 끝나지 않는 자식만 실패로 알린다.
    if (child.exitCode === null && child.signalCode === null) throw error;
  }
}

async function waitForPostmaster(child: MainProcess, pidFile: string) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `server ended before Postgres started (code ${child.exitCode}, signal ${child.signalCode}): ${child.stderrText()}`
      );
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
      // initdb도 잠깐 음수 pid로 이 파일을 쓴다. 서버로 뜬 postgres만 기다린다.
      if (pid > 0) return pid;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Postgres did not start in ${readyTimeoutMs}ms: ${child.stderrText()}`
  );
}

async function waitForPath(child: MainProcess, target: string) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `server ended before ${target} appeared (code ${child.exitCode}, signal ${child.signalCode}): ${child.stderrText()}`
      );
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `${target} did not appear in ${readyTimeoutMs}ms: ${child.stderrText()}`
  );
}

function killGroup(child: ChildProcess) {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    /* Already gone. */
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
