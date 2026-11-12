// scripts/boot-check.test.mjs의 감독 시험용. boot-check가 멈춘 경우를 흉내 낸다: 임시 폴더에 자리를 만들고,
// 같은 프로세스 그룹의 자식 하나와 그룹을 벗어난 자식 하나(pg_ctl이 띄운 Postgres처럼)를 띄운 뒤 멈춤 요청을 무시하고 멈춰 있다.
// 그룹을 벗어난 자식의 pid는 Postgres처럼 postmaster.pid에 남긴다. 두 자식은 명령줄에 그 폴더를 가진다.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.on("SIGTERM", () => {});
const home = mkdtempSync(path.join(tmpdir(), "stuck-run-"));
const dataDir = path.join(home, "postgres");
mkdirSync(dataDir);
const idle = ["-e", "setInterval(() => {}, 1000)", dataDir];
const inGroup = spawn(process.execPath, idle, { stdio: "ignore" });
const escaped = spawn(process.execPath, idle, {
  stdio: "ignore",
  detached: true,
});
escaped.unref();
writeFileSync(
  path.join(dataDir, "postmaster.pid"),
  `${escaped.pid}\n${dataDir}\n`
);
// 감독자가 넘긴 무관한 프로세스를 가리키는 오래된 pid 파일(pid 재사용). 감독자는 그 프로세스를 건드리면 안 된다.
if (process.env.UNRELATED_PID) {
  const stale = path.join(home, "stale");
  mkdirSync(stale);
  writeFileSync(
    path.join(stale, "postmaster.pid"),
    `${process.env.UNRELATED_PID}\n${stale}\n`
  );
}
console.log(
  JSON.stringify({ home, inGroup: inGroup.pid, escaped: escaped.pid })
);
setInterval(() => {}, 1000);
