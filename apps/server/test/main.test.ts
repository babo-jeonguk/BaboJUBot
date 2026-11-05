import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  freePort,
  createTestDatabase,
  type TestDatabase,
} from "@babojubot/db/testing";
import { listOrganizations } from "@babojubot/db";
import { afterAll, beforeAll, expect, it } from "vitest";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let external: TestDatabase;
beforeAll(async () => {
  external = await createTestDatabase();
});
afterAll(async () => {
  await external?.close();
});

it("starts against an external Postgres URL and leaves that Postgres running on shutdown", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, DATABASE_URL: external.url, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const [line] = await once(child.stdout!, "data");
    expect(String(line)).toContain("external Postgres");

    const res = await fetch(`http://127.0.0.1:${port}/api/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "외부 DB 조직", goal: "외부 DB 목표" }),
    });
    expect(res.status).toBe(201);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }

  // The server only owned its connections: the external database still answers.
  expect((await listOrganizations(external.db)).map((o) => o.name)).toContain(
    "외부 DB 조직"
  );
});

// 종료 신호는 서버 진입점 하나가 받아, 서버 정리를 끝낸 뒤 DB를 닫고 성공으로 끝난다.
// 라이브러리가 같은 신호로 먼저 프로세스를 끝내면 서버 정리가 잘리고 종료 코드가 128+신호 번호가 된다.
it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "finishes its own shutdown on %s with an external Postgres",
  async (signal) => {
    const child = startMain({ DATABASE_URL: external.url });
    try {
      await ready(child);
      child.kill(signal);
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
      expect(child.stderrText()).toBe("");
    } finally {
      child.kill("SIGKILL");
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
      await ready(child);
      process.kill(-child.pid!, signal);
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
      expect(child.stderrText()).toBe("");
    } finally {
      killGroup(child);
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
    EMBEDDED_POSTGRES_PORT: String(await freePort()),
  });
  let postgresPid = 0;
  try {
    const deadline = Date.now() + 45_000;
    while (!postgresPid && Date.now() < deadline) {
      if (existsSync(pidFile))
        postgresPid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
      // initdb도 잠깐 음수 pid로 이 파일을 쓴다. 서버로 뜬 postgres만 기다린다.
      if (!(postgresPid > 0)) {
        postgresPid = 0;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(postgresPid).toBeGreaterThan(0);
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(isAlive(postgresPid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    if (postgresPid && isAlive(postgresPid))
      process.kill(postgresPid, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

// 시작이 실패하면 그 사이 종료 신호가 왔어도 실패로 끝나야 서비스 관리자가 알 수 있다.
// Postgres port 0은 initdb 뒤 Postgres 시작에서 반드시 실패한다.
it("ends with a failure when the start fails after a stop signal arrived during startup", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "babojubot-main-test-"));
  const child = startMain({
    BABOJUBOT_HOME: home,
    EMBEDDED_POSTGRES_PORT: "0",
  });
  try {
    while (!existsSync(path.join(home, "postgres")))
      await new Promise((r) => setTimeout(r, 10));
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(child.stderrText()).toContain(
      "embedded Postgres exited before it was ready"
    );
  } finally {
    child.kill("SIGKILL");
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
    EMBEDDED_POSTGRES_PORT: String(await freePort()),
    BABOJUBOT_SHUTDOWN_TIMEOUT_MS: "2000",
  });
  let postgresPid = 0;
  try {
    await ready(child);
    postgresPid = Number(
      readFileSync(path.join(home, "postgres", "postmaster.pid"), "utf8").split(
        "\n"
      )[0]
    );
    process.kill(postgresPid, "SIGSTOP");
    const stoppedAt = Date.now();
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    expect(child.stderrText()).toContain("did not finish");

    process.kill(postgresPid, "SIGCONT");
    const deadline = Date.now() + 15_000;
    while (isAlive(postgresPid) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(postgresPid)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    if (postgresPid && isAlive(postgresPid)) {
      process.kill(postgresPid, "SIGCONT");
      process.kill(postgresPid, "SIGKILL");
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

type MainProcess = ChildProcess & { stderrText: () => string };

function startMain(
  env: Record<string, string>,
  { group = false } = {}
): MainProcess {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: group,
  }) as MainProcess;
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stderrText = () => stderr;
  return child;
}

/** 시작 줄이 나올 때까지 기다린다. stdout은 끝까지 읽어 둔다(멈추면 서버의 쓰기가 막힌다). */
function ready(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("BaboJUBot server on")) resolve();
    });
    child.once("exit", () =>
      reject(new Error(`server ended before it was ready: ${stdout}`))
    );
  });
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
