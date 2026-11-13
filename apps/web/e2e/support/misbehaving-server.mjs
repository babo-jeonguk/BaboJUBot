// E2E 서버 프로세스 helper(server-process.ts)의 실패 경로를 시험하는 가짜 서버. 실제 서버(apps/server/src/main.ts)처럼
// 임시 폴더(TMPDIR·TEMP·TMP)에 임시 내장 Postgres 폴더와 잠금 파일(postmaster.pid)을 만들고, 그 자리에 가짜 Postgres
// 프로세스(잠자는 Node)를 띄운다. 그 뒤 `MISBEHAVE`대로 고장 난다.
// - exit-before-ready: 시작 줄을 내기 전에 정리 없이 끝난다(가짜 Postgres는 남는다).
// - hang: 시작 줄을 낸 뒤 이벤트 루프를 막아 멈춤 메시지를 읽지도 끝나지도 않는다.
// - disconnect: 시작 줄을 낸 뒤 IPC 채널을 닫고 살아 있다.
// - leave-postgres-on-stop: 멈춤 메시지에 임시 Postgres 폴더(잠금 파일 포함)를 지우고 종료 코드 0으로 끝나지만 가짜 Postgres는
//   살아 있다(잠금 파일을 지운 뒤에도 끝나지 않는 Postgres).
// - exit-before-ready-undeletable: 임시 폴더에 지울 수 없는 폴더(쓰기 권한 없음, POSIX)를 만들고 시작 줄 전에 끝난다.
// 가짜 Postgres의 pid와 임시 폴더를 `MISBEHAVE_STATE` 파일에 적는다(시험이 정리를 확인한다).
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = os.tmpdir();
const dataDir = path.join(temp, "babojubot-pg-fake");
mkdirSync(dataDir);
const postgres = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }
);
postgres.unref();
writeFileSync(
  path.join(dataDir, "postmaster.pid"),
  `${postgres.pid}\n${dataDir}\n`
);
writeFileSync(
  process.env.MISBEHAVE_STATE,
  JSON.stringify({ postgresPid: postgres.pid, temp })
);

const ready = "BaboJUBot server on http://127.0.0.1:9 (misbehaving)\n";
switch (process.env.MISBEHAVE) {
  case "exit-before-ready":
    process.exit(1);
    break;
  case "hang":
    process.stdout.write(ready, () =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    );
    break;
  case "disconnect":
    process.stdout.write(ready, () => process.disconnect());
    setInterval(() => {}, 1000);
    break;
  case "leave-postgres-on-stop":
    process.on("message", (message) => {
      if (message?.type !== "babojubot:stop") return;
      rmSync(dataDir, { recursive: true, force: true });
      process.exit(0);
    });
    process.stdout.write(ready);
    break;
  case "exit-before-ready-undeletable": {
    const locked = path.join(temp, "undeletable");
    mkdirSync(locked);
    writeFileSync(path.join(locked, "file"), "");
    chmodSync(locked, 0o500);
    process.exit(1);
    break;
  }
  default:
    throw new Error(`unknown MISBEHAVE ${process.env.MISBEHAVE}`);
}
