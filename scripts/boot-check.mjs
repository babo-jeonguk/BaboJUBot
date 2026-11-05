// 이 시스템에서 기본 설정의 서버가 실제로 뜨는지 본다. 내장 DB 시작·migration·DB를 읽는 API 하나까지 확인한다.
// 서버가 정리 없이 끝나 내장 DB가 남으면 다음 시작이 그 DB를 정상 정지하고 다시 뜨는지, 닫을 때 정상 정지하는지도 본다.
// CI의 macOS·Windows 작업이 부른다. 임시 폴더와 전용 포트를 쓰고, 끝나면 DB를 멈추고 폴더를 지운다.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const port = process.env.BOOT_CHECK_PORT ?? "38417";
const dbPort = Number(process.env.BOOT_CHECK_DB_PORT ?? "38418");
const home = mkdtempSync(path.join(tmpdir(), "babojubot-boot-"));
const dataDir = path.join(home, "postgres");
const pidFile = path.join(dataDir, "postmaster.pid");
const log = path.join(dataDir, "postgres.log");

/** 서버를 띄워 API가 답하면 서버 프로세스만 강제로 끝낸다(IDE 강제 정지·OOM과 같은 상황). 내장 DB는 따로 남는다. */
async function serveAndKill(label) {
  const server = spawn(process.execPath, ["apps/server/src/main.ts"], {
    env: {
      ...process.env,
      BABOJUBOT_HOME: home,
      PORT: port,
      EMBEDDED_POSTGRES_PORT: String(dbPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (chunk) => {
    output = (output + chunk).slice(-4000);
  };
  server.stdout.on("data", keep);
  server.stderr.on("data", keep);
  let gone = false;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + 180_000;
  try {
    for (;;) {
      if (gone)
        throw new Error(
          `${label}: server exited before it was ready\n${output}`
        );
      if (Date.now() > deadline)
        throw new Error(`${label}: server was not ready in time\n${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/overview`);
        if (response.ok) {
          const body = await response.json();
          console.log(
            `${label}: server ready on ${process.platform}: ${Object.keys(body).length} overview fields`
          );
          return;
        }
      } catch {
        /* Not listening yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    killServer(server);
    await exited;
  }
}

function killServer(server) {
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/F", "/PID", String(server.pid)], {
        stdio: "ignore",
      });
    else server.kill("SIGKILL");
  } catch {
    /* Already gone. */
  }
}

/** 이번 Postgres가 정상 정지된 cluster에서 시작했는지. 강제로 끝난 cluster면 복구 과정을 거친다. */
function expectCleanStart(label) {
  const text = readFileSync(log, "utf8");
  if (
    text.includes("not properly shut down") ||
    !text.includes("database system was shut down")
  )
    throw new Error(
      `${label}: Postgres did not start from a normal stop\n${text.slice(-2000)}`
    );
  console.log(`${label}: Postgres started from a normal stop`);
}

/** 실패했을 때 남은 Postgres를 멈춘다. */
function stopLeftPostgres() {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
    if (!(pid > 0)) return;
    if (process.platform === "win32")
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
      });
    else process.kill(pid, "SIGQUIT");
  } catch {
    /* Not running. */
  }
}

let code = 0;
try {
  await serveAndKill("first start");
  if (!existsSync(pidFile))
    throw new Error("the embedded Postgres did not outlive the killed server");
  await serveAndKill("start after a killed server");
  expectCleanStart("start after a killed server");
  // 서버 없이 열고 닫는다. 남은 DB를 다시 정상 정지하고 띄우며, 닫을 때도 정상 정지해야 한다.
  const { openDatabase } = await import(
    pathToFileURL(path.resolve("packages/db/src/index.ts")).href
  );
  const handle = await openDatabase({
    embedded: { dataDir, port: dbPort, persistent: true },
  });
  expectCleanStart("open after another killed server");
  await handle.close();
  if (existsSync(pidFile))
    throw new Error("the embedded Postgres was still running after close");
  console.log("embedded Postgres stopped normally on close");
} catch (error) {
  code = 1;
  console.log(error instanceof Error ? error.message : error);
  stopLeftPostgres();
}
// 내장 DB가 파일을 놓을 시간을 준다. 지우지 못해도 임시 폴더이므로 결과에 영향이 없다.
setTimeout(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Temporary folder. */
  }
  process.exit(code);
}, 2000);
