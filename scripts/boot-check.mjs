// 이 시스템에서 기본 설정의 서버가 실제로 뜨는지 본다. 내장 DB 시작·migration·DB를 읽는 API 하나까지 확인한다.
// CI의 macOS·Windows 작업이 부른다. 임시 폴더와 전용 포트를 쓰고, 끝나면 서버를 끝낸다.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = process.env.BOOT_CHECK_PORT ?? "38417";
const home = mkdtempSync(path.join(tmpdir(), "babojubot-boot-"));
const server = spawn(process.execPath, ["apps/server/src/main.ts"], {
  env: {
    ...process.env,
    BABOJUBOT_HOME: home,
    PORT: port,
    EMBEDDED_POSTGRES_PORT: process.env.BOOT_CHECK_DB_PORT ?? "38418",
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
let output = "";
const keep = (chunk) => {
  output = (output + chunk).slice(-4000);
};
server.stdout.on("data", keep);
server.stderr.on("data", keep);
let exited = false;
server.on("exit", () => {
  exited = true;
});

const stop = () => {
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], {
        stdio: "ignore",
      });
    else process.kill(-server.pid, "SIGTERM");
  } catch {
    /* Already gone. */
  }
};
const finish = (code, message) => {
  console.log(message);
  if (code) console.log(output);
  stop();
  // 내장 DB가 파일을 놓을 시간을 준다. 지우지 못해도 임시 폴더이므로 결과에 영향이 없다.
  setTimeout(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* Temporary folder. */
    }
    process.exit(code);
  }, 2000);
};

const deadline = Date.now() + 180_000;
for (;;) {
  if (exited) {
    finish(1, "server exited before it was ready");
    break;
  }
  if (Date.now() > deadline) {
    finish(1, "server was not ready in time");
    break;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/overview`);
    if (response.ok) {
      const body = await response.json();
      finish(
        0,
        `server ready on ${process.platform}: ${Object.keys(body).length} overview fields`
      );
      break;
    }
  } catch {
    /* Not listening yet. */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
