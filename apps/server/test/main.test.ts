import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestDatabase, type TestDatabase } from "@babojubot/db/testing";
import { listOrganizations } from "@babojubot/db";
import { hasErrorCode, orIfMissing } from "@babojubot/contracts";
import { removeFolder } from "@babojubot/process/remove-folder";
import {
  beforeEach,
  expect,
  it,
  onTestFailed,
  onTestFinished,
  vi,
} from "vitest";
import { containerOwner } from "../src/isolation.ts";
import { stopRequest } from "../src/stop-request.ts";
import { waitForPostmaster } from "./postmaster.ts";
import { ownedListener, pollUntil } from "./support.ts";
import { ownHome } from "./product-home.ts";
import { psField } from "@babojubot/process";
import { reportedPid, within } from "@babojubot/process/test-support";
import {
  awaitedLater,
  folderCleanup,
  killUnlessGone,
  processAlive,
  withCleanup,
} from "@babojubot/process/test-cleanup";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
/**
 * 서버 시작의 남은 컨테이너 정리가 부르는 docker. 이 컴퓨터의 Docker 유무·권한에 따라 시작 출력이 달라지지 않게, 이 제품 폴더의
 * 컨테이너 목록 명령 하나만 받아 "남은 것 없음"으로 답하는 가짜를 쓴다(Windows는 그 정리가 Docker를 부르지 않는다). 받은 명령은
 * 서버마다 따로 둔 Docker 설정 폴더에 남는다(`startMain`). 실제 Docker는 runtime의 실제 Docker 묶음만 쓴다.
 */
const fakeDocker = fileURLToPath(
  new URL("fixtures/fake-docker.ts", import.meta.url)
);
/** DB 닫기를 실패시키는 preload(`startMain`의 `preload`). */
const failDatabaseClose = fileURLToPath(
  new URL("./fixtures/fail-database-close.ts", import.meta.url)
);
const readyTimeoutMs = 45_000;
// 종료 신호 뒤 서버가 끝나기까지. 서버의 기본 종료 시한(30초)보다 길게 둔다.
const shutdownWaitMs = 35_000;
// SIGKILL 뒤 종료가 보고되기까지.
const killWaitMs = 10_000;
// Windows의 `kill(신호)`는 정리를 맡기지 않고 강제로 끝낸다. 신호·프로세스 그룹·SIGSTOP 시험은 POSIX에서만 돈다.
// 모든 OS에서 같은 정리 경로는 부모의 멈춤 메시지(IPC) 시험이 확인한다.
const posix = process.platform === "win32" ? it.skip : it;
/** 서버를 멈추라는 요청. 신호는 POSIX에서만, 멈춤 메시지는 모든 OS에서 정리를 맡긴다. */
const stopRequests = [
  ...(process.platform === "win32"
    ? []
    : [
        {
          name: "SIGTERM",
          ipc: false,
          send: (child: MainProcess) => void child.kill("SIGTERM"),
        },
      ]),
  {
    name: "a stop request from the parent",
    ipc: true,
    send: (child: MainProcess) => void child.send(stopRequest),
  },
];

// 외부 DB는 시험마다 새로 만든다. 같이 쓰면 앞 시험이 남긴 일(예: 조직 생성의 Lead 깨우기)을 뒤 시험의 서버가 이어받아
// 그 시험의 결과가 실행 순서에 달린다.
let external: TestDatabase;
/**
 * 그 시험의 DB를 닫기 전에 끝나야 하는 서버. 시험의 서버가 이 DB를 쓰므로 서버가 끝난 것을 확인한 뒤에만 닫고, 끄지 못한 서버가
 * 있으면 닫지 않고 그 실패를 알린다(`folderCleanup`: 맡긴 멈춤이 모두 끝나야 마지막 단계를 한다). `startMain`이 띄운 서버를 맡긴다.
 */
let databaseUsers: ReturnType<typeof folderCleanup>;
beforeEach(async ({ onTestFinished }) => {
  const database = await createTestDatabase();
  external = database;
  const users = folderCleanup(() => database.close());
  databaseUsers = users;
  onTestFinished(users.cleanUp);
});

it("starts against an external Postgres URL and leaves that Postgres running on shutdown", async () => {
  // 서버를 끈 뒤에 외부 DB가 남았는지 본다.
  await withCleanup(async (defer) => {
    const child = startMain({ DATABASE_URL: external.url });
    defer(child.stop);
    await child.ready();
    expect(child.stdoutText()).toContain("external Postgres");
    const url = child.stdoutText().match(/BaboJUBot server on (\S+)/)![1]!;

    const res = await fetch(`${url}/api/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "외부 DB 조직", goal: "외부 DB 목표" }),
    });
    expect(res.status).toBe(201);
  });

  // The server only owned its connections: the external database still answers.
  expect((await listOrganizations(external.db)).map((o) => o.name)).toContain(
    "외부 DB 조직"
  );
});

// 부모 셸의 서버 설정(BABOJUBOT_*)은 이 파일의 서버 시험에 새지 않는다. 시험이 고르지 않은 설정이 고장 나 있어도
// 서버는 그 설정과 무관하게 뜬다. 고장 난 모델 목적지 설정으로 확인한다(서버가 시작할 때 JSON으로 읽는다).
it("ignores the parent's server settings that the test did not choose", async () => {
  vi.stubEnv("BABOJUBOT_MODEL_DESTINATIONS", "not json");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const child = startMain({ DATABASE_URL: external.url });
  await child.ready();
});

// 서버 시작은 지난 실행이 남긴 컨테이너 가운데 이 제품 폴더의 것(주인 표식)만 골라 지운다. 같은 Docker를 쓰는 다른 제품 폴더의
// 컨테이너는 건드리지 않는다. 가짜 docker가 받은 명령을 그대로 본다. 시작 정리는 듣기 전에 끝나므로 시작 줄 뒤에는 기록이 다 있다.
// Windows는 격리 실행이 컨테이너를 띄우지 않아 그 정리가 Docker를 부르지 않는다(isolation.ts `removeOrphans`).
it("lists only this product folder's leftover containers at startup", async () => {
  const child = startMain({ DATABASE_URL: external.url });
  await child.ready();
  const owner = containerOwner(path.resolve(process.env.BABOJUBOT_HOME!));
  expect(child.dockerCalls()).toEqual(
    process.platform === "win32"
      ? []
      : [["ps", "-aq", "--filter", `label=babojubot.owner=${owner}`]]
  );
});

// 종료 신호는 서버 진입점 하나가 받아, 서버 정리를 끝낸 뒤 DB를 닫고 성공으로 끝난다.
// 라이브러리가 같은 신호로 먼저 프로세스를 끝내면 서버 정리가 잘리고 종료 코드가 128+신호 번호가 된다.
posix.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "finishes its own shutdown on %s with an external Postgres",
  async (signal) => {
    const child = startMain({ DATABASE_URL: external.url });
    await child.ready();
    child.kill(signal);
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(0);
    expect(child.stderrText()).toBe("");
  },
  60_000
);

// 터미널의 Ctrl+C와 창 닫힘은 서버와 같은 프로세스 그룹 전체에 간다. 내장 Postgres가 그 신호로 따로 멈추면
// 서버가 정리하는 동안 연결이 끊긴다. 서버가 정리를 마치고 DB를 닫을 때까지 Postgres가 살아 있어야 한다.
posix.each(["SIGINT", "SIGHUP"] as const)(
  "closes the embedded Postgres only after its own shutdown when the terminal sends %s to the whole group",
  async (signal) => {
    // 임시 Postgres는 이 시험의 임시 폴더에 띄운다. 폴더 정리가 서버와 관찰한 Postgres의 끝을 확인한 뒤에만 지운다.
    const temp = temporaryFolder();
    const { folder, leftover } = postgresFolder(temp.dir);
    const child = startMain(
      { BABOJUBOT_EPHEMERAL_DB: "1", ...temp.env },
      { group: true }
    );
    folder.own(child.stop);
    await child.ready();
    leftover.postgres = temporaryPostgres(temp.dir);
    signalGroup(child, signal);
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(0);
    expect(child.stderrText()).toBe("");
  },
  60_000
);

// 시작하는 동안 온 멈춤 요청에도 서버가 띄운 내장 Postgres를 멈추고 끝난다. 남으면 다음 시작이 그 폴더를 못 쓴다.
// 서버는 띄우지 않는다(시작 줄이 없다).
it.each(stopRequests)(
  "stops the embedded Postgres it was starting when $name arrives during startup",
  async ({ ipc, send }) => {
    const home = mkdtempSync(path.join(tmpdir(), "babojubot-main-test-"));
    const { folder, leftover } = postgresFolder(home);
    const pidFile = path.join(home, "postgres", "postmaster.pid");
    const child = startMain(
      { BABOJUBOT_HOME: home, EMBEDDED_POSTGRES_PORT: "0" },
      { ipc }
    );
    folder.own(child.stop);
    const postgres = (leftover.postgres = await waitForPostmaster(
      child,
      pidFile,
      {
        timeoutMs: readyTimeoutMs,
        observe: observePostgres,
      }
    ));
    send(child);
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(0);
    expect(child.stdoutText()).not.toContain("BaboJUBot server on");
    await expectGone(postgres);
    expect(existsSync(pidFile)).toBe(false);
  },
  60_000
);

// 시작이 실패하면 그 사이 멈춤 요청이 왔어도 실패로 끝나야 서비스 관리자가 알 수 있다.
// Postgres port 범위(1..65535) 밖의 번호는 initdb 뒤 Postgres 시작에서 반드시 실패한다.
it.each(stopRequests)(
  "ends with a failure when the start fails after $name arrived during startup",
  async ({ ipc, send }) => {
    const home = mkdtempSync(path.join(tmpdir(), "babojubot-main-test-"));
    // 폴더는 만든 직후 정리에 맡긴다. 그 안에서 도는 것(서버·Postgres)은 띄운 뒤 `own`으로 맡긴다.
    const folder = folderCleanup(() => removeFolder(home));
    onTestFinished(folder.cleanUp);
    // 이 시험은 Postgres를 관찰하지 않는다. 그 끝의 증거는 서버 진단 전체다: 시작 실패 진단 하나뿐이면 제품이 시작 실패 뒤 Postgres를
    // 멈췄다(멈추지 못하면 그 진단이 따로 남는다). 시험이 그 진단을 확인하기 전에 끝나면 끝을 확인할 수 없어 폴더를 남긴다(fail closed).
    const postgresEnded = { seen: false };
    folder.own(() => {
      if (!postgresEnded.seen)
        throw new Error(
          "the embedded Postgres was not seen ending, so its end cannot be confirmed; its folder is kept"
        );
    });
    const child = startMain(
      { BABOJUBOT_HOME: home, EMBEDDED_POSTGRES_PORT: "65536" },
      { ipc }
    );
    folder.own(child.stop);
    await waitForPath(child, path.join(home, "postgres"));
    send(child);
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(1);
    // 끝난 뒤에도 출력이 남아 있을 수 있어, 출력이 닫힌 뒤에 진단 전체를 읽는다.
    await within(
      child.closed,
      killWaitMs,
      `server ${child.pid} did not close its output`
    );
    // 진단은 오류 문구(Postgres 로그가 섞임) 대신 원인 코드만 남긴다. 진단 전체가 이것뿐이면 시작 실패 뒤 Postgres 정리(`embedded.ts`가
    // 시작에 실패하면 멈추기를 시도하고 실패하면 진단으로 남김)가 실패하지 않은 것이다(CODING_STANDARDS.md 「제품 코드」의 정리 규칙).
    expect(stderrLines(child)).toEqual([
      "[server] start failed (EMBEDDED_EXITED_BEFORE_READY)",
      "",
    ]);
    postgresEnded.seen = true;
  },
  60_000
);

// HTTP 서버가 시작하지 못하면 그 오류로 실패한다. 뒤이어 DB를 닫다 난 오류는 원래 오류를 덮지 않고 따로 남는다.
it("ends with the HTTP start error and records the database close failure when both fail", async () => {
  const { server: taken } = await ownedListener(
    createServer(),
    { port: 0, host: "127.0.0.1" },
    onTestFinished,
    "the port-taking server"
  );
  const { port } = taken.address() as { port: number };
  const child = startMain(
    { DATABASE_URL: external.url, PORT: String(port) },
    { preload: failDatabaseClose }
  );
  const { code } = await waitExit(child, shutdownWaitMs);
  expect(code, child.stderrText()).toBe(1);
  expect(child.stderrText()).toContain("EADDRINUSE");
  // 닫기 실패는 오류 문구 대신 원인 코드로 따로 남는다. 주입한 실패는 code가 없는 Error다.
  expect(stderrLines(child)).toContain(
    "[server] closing the database after a failed start failed (Error)"
  );
  expect(child.stderrText()).not.toContain(
    "injected: closing the database failed"
  );
}, 60_000);

// 정리가 멈추면 정해진 시한(BABOJUBOT_SHUTDOWN_TIMEOUT_MS)에 실패로 끝난다. 서버를 감싼 실행기(Playwright·Docker·
// Kubernetes)는 그보다 긴 시한을 두어, 서버가 스스로 끝나며 내장 Postgres를 멈출 기회를 갖는다.
// 멈춘 Postgres로 정리가 끝나지 않는 상황을 만든다. 서버가 끝난 뒤 다시 움직인 Postgres는 받은 정지 신호로 끝난다.
// Postgres를 멈추는 SIGSTOP이 POSIX에만 있어 POSIX에서만 돈다. 멈춤 요청은 신호와 메시지 둘 다 같은 시한을 따른다.
const posixStopRequests = process.platform === "win32" ? [] : stopRequests;
posix.each(posixStopRequests)(
  "ends with a failure at its configured shutdown deadline after $name and leaves no Postgres behind",
  async ({ ipc, send }) => {
    const home = mkdtempSync(path.join(tmpdir(), "babojubot-main-test-"));
    const { folder, leftover } = postgresFolder(home);
    const child = startMain(
      {
        BABOJUBOT_HOME: home,
        EMBEDDED_POSTGRES_PORT: "0",
        BABOJUBOT_SHUTDOWN_TIMEOUT_MS: "2000",
      },
      { ipc }
    );
    folder.own(child.stop);
    await child.ready();
    const postgres = (leftover.postgres = lockedPostgres(
      path.join(home, "postgres")
    ));
    expect(signalPostgres(postgres, "SIGSTOP")).toBe(true);
    send(child);
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(1);
    // 정한 시한(2s)으로 끝났다는 것은 그 시한을 적은 진단으로 본다. 진단은 프로세스를 끝내는 시한 타이머가 낸다.
    // 시한을 정리 몫과 비상 정지 몫으로 나누는 계산은 shutdown-budget.test.ts가 본다. 걸린 시간은 재지 않는다(CODING_STANDARDS.md#시간).
    expect(child.stderrText()).toContain("did not finish in 2s");

    // 멈춰 둔 Postgres는 끝날 수 없으므로 그대로 그 프로세스다. 다시 움직이면 받아 둔 정지 신호로 끝난다.
    expect(signalPostgres(postgres, "SIGCONT")).toBe(true);
    await expectGone(postgres, 15_000);
  },
  60_000
);

// 서버를 IPC 채널로 띄운 부모는 멈춤 메시지로 정리를 맡긴다(Windows에서도 정상 정리하는 길). 서버는 정리를 끝내고 0으로 끝나며
// 임시 내장 Postgres를 멈추고 그 dataDir를 지운다. 임시 폴더(TMP)를 이 시험의 폴더로 바꿔 서버가 만든 임시 DB만 본다.
it("finishes its own shutdown on a stop request from the parent and leaves no temporary Postgres behind", async () => {
  const temp = temporaryFolder();
  const { folder, leftover } = postgresFolder(temp.dir);
  const child = startMain(
    { BABOJUBOT_EPHEMERAL_DB: "1", ...temp.env },
    { ipc: true }
  );
  folder.own(child.stop);
  await child.ready();
  const postgres = (leftover.postgres = temporaryPostgres(temp.dir));
  expect(running(postgres)).toBe(true);
  child.send(stopRequest);
  const { code } = await waitExit(child, shutdownWaitMs);
  expect(code, child.stderrText()).toBe(0);
  expect(child.stderrText()).toBe("");
  await expectGone(postgres);
  expect(temporaryPostgresEntries(temp.dir)).toEqual([]);
}, 60_000);

// 부모가 사라져 채널이 끊겨도 서버를 챙길 쪽이 없으므로 같은 정리를 하고 끝난다. 부모와 서버가 함께 강제로 끝나는 경우는
// 정리할 기회가 없어 다음 시작이 남은 Postgres를 멈춘다(db/embedded.ts).
it("finishes its own shutdown when the parent's channel closes", async () => {
  const temp = temporaryFolder();
  const { folder, leftover } = postgresFolder(temp.dir);
  const child = startMain(
    { BABOJUBOT_EPHEMERAL_DB: "1", ...temp.env },
    { ipc: true }
  );
  folder.own(child.stop);
  await child.ready();
  const postgres = (leftover.postgres = temporaryPostgres(temp.dir));
  child.disconnect();
  const { code } = await waitExit(child, shutdownWaitMs);
  expect(code, child.stderrText()).toBe(0);
  expect(child.stderrText()).toBe("");
  await expectGone(postgres);
  expect(temporaryPostgresEntries(temp.dir)).toEqual([]);
}, 60_000);

// 멈춤 요청이 겹쳐도(같은 메시지 여러 번, 신호와 메시지) 정리는 한 번이다. 두 번 닫으면 DB 연결 닫기가 오류를 낸다.
it("cleans up once when stop requests repeat", async () => {
  const child = startMain({ DATABASE_URL: external.url }, { ipc: true });
  await child.ready();
  child.send(stopRequest);
  child.send(stopRequest);
  if (process.platform !== "win32") child.kill("SIGTERM");
  child.send(stopRequest);
  const { code } = await waitExit(child, shutdownWaitMs);
  expect(code, child.stderrText()).toBe(0);
  expect(child.stderrText()).toBe("");
}, 60_000);

// 멈춤 메시지가 아닌 메시지로는 멈추지 않는다. 어떤 메시지가 요청인지는 단위 시험(src/stop-request.test.ts)이 정하고,
// 여기서는 실제 채널로 받은 다른 메시지 뒤에도 API가 응답하고 마지막 멈춤 메시지로 정상 종료하는지 본다.
it("keeps serving after messages that are not a stop request", async () => {
  const child = startMain({ DATABASE_URL: external.url }, { ipc: true });
  await child.ready();
  const url = child.stdoutText().match(/BaboJUBot server on (\S+)/)![1]!;
  for (const message of ["shutdown", { type: "stop" }, { id: 1 }])
    await within(
      new Promise<void>((resolve, reject) =>
        child.send(message, (error) => (error ? reject(error) : resolve()))
      ),
      10_000,
      `the server did not take the message ${JSON.stringify(message)}`
    );
  const res = await fetch(`${url}/api/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "메시지 뒤 조직", goal: "계속 응답" }),
  });
  expect(res.status).toBe(201);
  expect(child.exitCode).toBeNull();
  child.send(stopRequest);
  const { code } = await waitExit(child, shutdownWaitMs);
  expect(code, child.stderrText()).toBe(0);
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
    // 설정을 읽다 던지고 끝난다. 끝나지 않으면 시한의 실패가 그대로 이 시험의 실패다.
    const { code } = await waitExit(child, shutdownWaitMs);
    expect(code, child.stderrText()).toBe(1);
    expect(child.stdoutText()).not.toContain("BaboJUBot server on");
    expect(stderrLines(child)).toContain(
      `Error: BABOJUBOT_SHUTDOWN_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, got "${value}"`
    );
  },
  60_000
);

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type MainProcess = ChildProcess & {
  stdoutText: () => string;
  stderrText: () => string;
  exited: Promise<Exit>;
  closed: Promise<void>;
  ready: () => Promise<void>;
  /**
   * 이 서버를 끝내고 그 끝과 출력 닫힘을 확인한다. 서버마다 한 번만 하고 그 결과를 나눈다: 그 서버가 쓰는 폴더·DB의 정리와 시험
   * 본문이 모두 같은 끝을 기다리고, 끄지 못한 실패는 한 번 원인과 함께 보인다. 그룹으로 띄운 서버는 그룹 전체를 끈다.
   */
  stop: () => Promise<void>;
  /** 가짜 docker가 받은 명령의 인수. 받은 차례대로다. */
  dockerCalls: () => unknown[];
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
  // 서버가 docker 클라이언트에 넘기는 Docker 설정 폴더(container.ts `dockerClientEnv`). 시험이 서버마다 정한다.
  "DOCKER_CONFIG",
];
function inheritedEnv() {
  const env = { ...process.env };
  // Windows는 환경 변수 이름의 대소문자를 가리지 않으므로 대문자로 바꿔 비교한다.
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (
      (upper.startsWith("BABOJUBOT_") && upper !== "BABOJUBOT_HOME") ||
      serverSettings.includes(upper)
    )
      delete env[name];
  }
  return env;
}

/** `ipc`면 부모와의 IPC 채널을 열어 띄운다(멈춤 메시지·채널 끊김 시험). `preload`는 서버보다 먼저 불러올 모듈이다. */
function startMain(
  env: Record<string, string>,
  {
    group = false,
    ipc = false,
    preload,
  }: { group?: boolean; ipc?: boolean; preload?: string } = {}
): MainProcess {
  const args = preload
    ? ["--import", pathToFileURL(preload).href, main]
    : [main];
  const inherited = inheritedEnv();
  const home = env.BABOJUBOT_HOME ?? inherited.BABOJUBOT_HOME;
  if (home === undefined)
    throw new Error("BABOJUBOT_HOME is not set (test/product-home.ts sets it)");
  // 서버는 docker 클라이언트에 자기 환경을 넘기지 않고 Docker 설정 폴더(DOCKER_CONFIG)만 넘긴다. 서버마다 그 폴더를 따로 두어
  // 가짜 docker에 이 서버의 주인 표식을 알리고, 가짜가 받은 명령을 그 폴더에서 읽는다. 서버가 끝난 것을 확인한 뒤에만 지운다.
  // 끄지 못하면 폴더(가짜가 받은 명령의 기록)를 남기고 그 실패를 알린다.
  const dockerConfig = mkdtempSync(
    path.join(tmpdir(), "babojubot-fake-docker-")
  );
  const dockerFolder = folderCleanup(() => removeFolder(dockerConfig));
  onTestFinished(dockerFolder.cleanUp);
  writeFileSync(
    path.join(dockerConfig, "fake-docker.json"),
    JSON.stringify({ owner: containerOwner(path.resolve(home)) })
  );
  const child = spawn(process.execPath, args, {
    env: {
      ...inherited,
      HOST: "127.0.0.1",
      PORT: "0",
      BABOJUBOT_PROVIDERS: "",
      BABOJUBOT_FAKE_PROVIDERS: "1",
      BABOJUBOT_FAKE_PROVIDER_SETTINGS: "{}",
      BABOJUBOT_DOCKER_COMMAND: fakeDocker,
      DOCKER_CONFIG: dockerConfig,
      ...env,
    },
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    detached: group,
  }) as MainProcess;
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdoutText = () => stdout;
  child.stderrText = () => stderr;
  // 시험이 실패하면 그때 이 서버의 종료 상태와 출력 끝을 남긴다. 대기 시한뿐 아니라 이 서버가 있는 모든 실패에서 남는다.
  onTestFailed(() => {
    console.error(
      `server ${child.pid} when the test failed (exit code ${child.exitCode}, signal ${child.signalCode}): stdout=${JSON.stringify(stdout.slice(-2000))} stderr=${JSON.stringify(stderr.slice(-2000))}`
    );
  });
  child.dockerCalls = () =>
    orIfMissing(
      () => readFileSync(path.join(dockerConfig, "calls.jsonl"), "utf8"),
      hasErrorCode("ENOENT"),
      ""
    )
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line));
  // 정리(`stop`)가 늘 기다린다. 시작하자마자 spawn 오류로 거절돼도 그 전에 처리되지 않은 거절이 되지 않는다.
  child.exited = awaitedLater(
    new Promise<Exit>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    })
  );
  // 출력(stdout·stderr)이 닫힌 때. 자식의 close 이벤트는 IPC 채널까지 세어 부모가 채널을 끊으면 오지 않을 수 있어 출력만 본다.
  child.closed = Promise.all(
    [child.stdout!, child.stderr!].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (stream.closed) resolve();
          else stream.once("close", () => resolve());
        })
    )
  ).then(() => {});
  // 시작 줄은 기다리는 시험만 본다. 일찍 끝나는 것을 확인하는 시험은 종료(exited)를 본다.
  let ready: Promise<void> | undefined;
  child.ready = () =>
    (ready ??= waitForReady(
      child,
      () => stdout,
      () => stderr
    ));
  // 서버의 끝은 한 작업이 맡는다. 이 서버가 쓰는 폴더와 그 시험의 DB는 그 끝을 기다린 뒤에 정리한다.
  let ending: Promise<void> | undefined;
  child.stop = () => (ending ??= endServer(child, { group }));
  dockerFolder.own(child.stop);
  databaseUsers.own(child.stop);
  // 시험이 제품 폴더를 주지 않은 서버는 파일의 제품 폴더(test/product-home.ts)를 쓴다. 그 폴더는 이 서버의 끝을 확인한 뒤에만 지운다.
  if (env.BABOJUBOT_HOME === undefined) ownHome(child.stop);
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
    // 기다리기 전에 이미 나온 시작 줄과 이미 끝난 자식도 본다.
    onData();
    if (child.exitCode !== null || child.signalCode !== null)
      onExit(child.exitCode, child.signalCode);
  });
}

/** 서버가 stderr에 남긴 줄. */
function stderrLines(child: MainProcess) {
  return child.stderrText().split(/\r?\n/);
}

/** 이미 붙여 둔 종료 관찰을 시한 안에서 기다린다. 시한은 기다리기 시작할 때부터 센다. */
function waitExit(child: MainProcess, ms: number): Promise<Exit> {
  return within(child.exited, ms, `server ${child.pid} did not exit`);
}

/**
 * 자식이 살아 있으면 끝내고, 이미 끝났으면 그 종료를 기다린다. 그룹으로 띄운 서버는 아직 거두지 않았으면 그룹 전체를 끄고, 끝난 뒤
 * 그룹에 남은 프로세스가 없는지 본다(남았으면 끄지 않고 그 그룹과 함께 알린다).
 */
async function endServer(child: MainProcess, { group }: { group: boolean }) {
  if (child.exitCode === null && child.signalCode === null) {
    if (group) signalGroup(child, "SIGKILL");
    else child.kill("SIGKILL");
  }
  // 끝을 확인한다. 종료 관찰이 `error`로 끝나면(띄우지 못함, 신호를 보내지 못함) 확인하지 못한 것으로 알린다.
  await within(child.exited, killWaitMs, `server ${child.pid} did not exit`);
  // 폴더를 지우기 전에 stdio 닫힘까지 확인한다.
  await within(
    child.closed,
    killWaitMs,
    `server ${child.pid} did not close its output`
  );
  if (group) await groupEnded(child);
}

async function waitForPath(child: MainProcess, target: string) {
  await pollUntil(
    () => {
      if (existsSync(target)) return true;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `server ended before ${target} appeared (code ${child.exitCode}, signal ${child.signalCode}): ${child.stderrText()}`
        );
      return undefined;
    },
    {
      timeoutMs: readyTimeoutMs,
      intervalMs: 10,
      timedOut: () =>
        `${target} did not appear in ${readyTimeoutMs}ms: ${child.stderrText()}`,
    }
  );
}

/**
 * 그룹으로 띄운 서버(그룹 번호 = 서버 번호)의 그룹 전체에 신호한다. Node가 서버를 아직 거두지 않았으면 그 번호는 이 그룹이다(거두기 전의
 * 프로세스는 번호를 쥐고 있다). 거둔 뒤에는 그 번호가 다른 그룹에 쓰였을 수 있어 보내지 않고 실패한다.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(
      `server ${child.pid} already ended (code ${child.exitCode}, signal ${child.signalCode}); its group number is not signalled`
    );
  killUnlessGone(-child.pid!, signal);
}

/**
 * 거둔 서버의 그룹에 남은 프로세스가 없다. 구성원이 하나라도 살아 있으면 그 그룹 번호는 이 그룹이므로 신호 0으로 본다. 신호는 보내지
 * 않는다. macOS는 거두기 전의 프로세스만 남은 그룹에 EPERM으로 답해(`processAlive`가 원인과 함께 던짐) 그것만 "아직 있음"으로 보고
 * 다시 본다. 그 밖의 실패는 확인하지 못한 것이라 다시 묻지 않고 그 실패로 끝난다(`pollUntil`).
 */
async function groupEnded(child: ChildProcess) {
  await pollUntil(
    () => {
      try {
        return processAlive(-child.pid!) ? undefined : true;
      } catch (error) {
        if (
          process.platform === "darwin" &&
          hasErrorCode("EPERM")((error as Error).cause)
        )
          return undefined;
        throw error;
      }
    },
    {
      timeoutMs: killWaitMs,
      intervalMs: 20,
      timedOut: () =>
        `the process group of server ${child.pid} still has members after the server ended`,
    }
  );
}

/** 서버의 임시 폴더. 임시 내장 Postgres(`openEphemeralDatabase`)는 이 안에 dataDir를 만든다. */
function temporaryFolder() {
  const dir = mkdtempSync(path.join(tmpdir(), "babojubot-main-tmp-"));
  // Node는 POSIX에서 TMPDIR, Windows에서 TEMP·TMP를 읽는다.
  return { dir, env: { TMPDIR: dir, TEMP: dir, TMP: dir } };
}

/** 준비된 서버가 임시 폴더에 띄운 임시 내장 Postgres 하나를 찾는다. */
function temporaryPostgres(temp: string): ObservedPostgres {
  const dirs = temporaryPostgresEntries(temp).filter(
    (name) => !name.endsWith(".owner")
  );
  expect(dirs).toHaveLength(1);
  return lockedPostgres(path.join(temp, dirs[0]!));
}

/**
 * 서버가 띄운 Postgres 하나. 잠금 파일(postmaster.pid)의 번호와, 그 번호를 읽은 같은 동기 단계에서 읽은 시작 시각(POSIX `ps` lstart)이다.
 * 번호는 그 프로세스가 끝나면 다른 프로세스에 다시 쓰이므로, 신호하거나 끝났다고 볼 때마다 시작 시각을 다시 읽어 같은 프로세스인지
 * 본다. Windows는 시작 시각을 읽지 못해 `started`가 없고, 번호로 신호하지 않는다. `ended`는 시험이 끝남을 확인했는지다.
 */
type ObservedPostgres = { pid: number; started?: string; ended: boolean };
/** `ps` 한 번의 시한. */
const psWaitMs = 5_000;

function observePostgres(pid: number): ObservedPostgres {
  if (process.platform === "win32") return { pid, ended: false };
  const started = psField(pid, "lstart", psWaitMs);
  if (started === undefined)
    throw new Error(`Postgres ${pid} named in its lock file is not running`);
  return { pid, started, ended: false };
}

/** 그 dataDir의 잠금 파일에 적힌 Postgres. 읽기와 관찰 사이에 기다림이 없다. */
function lockedPostgres(dataDir: string): ObservedPostgres {
  return observePostgres(
    reportedPid(
      readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0],
      `the lock file of ${dataDir}`
    )
  );
}

/**
 * 그 Postgres가 아직 도는가. POSIX는 그 번호의 시작 시각이 같을 때만 그 프로세스다. Windows는 번호가 살아 있는지만 본다. 그 번호를
 * 다른 프로세스가 쓰면 끝나지 않은 것으로 보아 기다림이 실패한다(신호는 보내지 않는다).
 */
function running(postgres: ObservedPostgres): boolean {
  if (postgres.started === undefined) return processAlive(postgres.pid);
  return psField(postgres.pid, "lstart", psWaitMs) === postgres.started;
}

/**
 * 그 Postgres에 신호한다. 같은 프로세스임을 본 직후(사이에 기다림 없이)에만 보내고, 이미 끝났으면 보내지 않고 false다. 시작 시각을
 * 읽을 수 없는 시스템(Windows)에서는 그 번호가 아직 그 Postgres인지 알 수 없어 보내지 않고 실패한다.
 */
function signalPostgres(postgres: ObservedPostgres, signal: NodeJS.Signals) {
  if (postgres.started === undefined)
    throw new Error(
      `Postgres ${postgres.pid} cannot be identified on this system; it is not signalled by number`
    );
  if (!running(postgres)) return false;
  return killUnlessGone(postgres.pid, signal);
}

/** 임시 내장 Postgres가 임시 폴더에 남기는 항목(dataDir와 그 주인 기록 `.owner`). 정상 정지 뒤에는 없다. */
function temporaryPostgresEntries(temp: string) {
  return readdirSync(temp).filter((name) => name.startsWith("babojubot-pg-"));
}

/**
 * 서버가 멈춘 Postgres 프로세스가 사라졌다. pg_ctl의 정지 대기는 postmaster.pid가 지워지면 끝나고 프로세스는 그 뒤 잠시
 * 남을 수 있어(Windows는 완전히 끝날 때까지 살아 있다고 답함) 짧은 시한 안에서 기다린다.
 */
async function expectGone(postgres: ObservedPostgres, timeout = 5_000) {
  // 확인이 실패하면(`ps`·신호 0을 읽지 못함) 다시 묻지 않고 그 실패로 끝난다(`pollUntil`).
  await pollUntil(() => (running(postgres) ? undefined : true), {
    timeoutMs: timeout,
    intervalMs: 20,
    timedOut: () => `Postgres ${postgres.pid} did not end within ${timeout}ms`,
  });
  postgres.ended = true;
}

/**
 * 시험이 끝남을 확인하지 못한 Postgres만 끝내고, 끝난 것을 확인한다. 그 뒤에야 폴더를 지운다. 확인한 뒤에는 그 번호를 다시 보지
 * 않는다(다른 프로세스가 썼을 수 있다).
 */
/**
 * 시험 폴더와 그 안에서 서버가 띄울 Postgres의 소유. 폴더는 만든 직후 정리에 맡기고, 그 안 Postgres의 끝은 서버를 띄우기 전에 맡긴다
 * (정리는 역순이라 서버의 끝 뒤에 돈다). 관찰한 Postgres는 `leftover.postgres`에 넣는다. 관찰하지 못하면 끝을 확인할 수 없어 폴더를
 * 남기고 실패한다(`stopLeftover`). 서버는 띄운 직후 `folder.own(child.stop)`으로 맡긴다.
 */
function postgresFolder(dir: string) {
  const folder = folderCleanup(() => removeFolder(dir));
  onTestFinished(folder.cleanUp);
  const leftover: { postgres?: ObservedPostgres } = {};
  folder.own(() => stopLeftover(leftover.postgres));
  return { folder, leftover };
}

async function stopLeftover(postgres: ObservedPostgres | undefined) {
  // 관찰하지 못한 Postgres는 같은 프로세스인지 알 근거가 없어 끄지도, 끝났다고 보지도 않는다. 폴더를 남기고 실패한다(fail closed).
  if (!postgres)
    throw new Error(
      "the embedded Postgres was not observed, so its end cannot be confirmed; its folder is kept"
    );
  if (postgres.ended || !running(postgres)) return;
  // 멈춰 둔 Postgres는 다시 움직여야 끝난다. 그사이 끝났으면 보내지 않는다.
  signalPostgres(postgres, "SIGCONT");
  signalPostgres(postgres, "SIGKILL");
  await expectGone(postgres);
}
