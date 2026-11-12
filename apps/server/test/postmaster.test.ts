import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { waitForPostmaster, type ObservedChild } from "./postmaster.ts";

// Postgres는 시작·종료 중에 pid 파일을 쓰고 지운다. 확인과 읽기 사이에 파일이 사라져도 준비 관찰을 이어가고,
// 준비를 볼 수 없는 경우(시한·자식 종료·다른 읽기 오류)만 그 이유로 실패한다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function pidFile() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-postmaster-"));
  roots.push(root);
  return path.join(root, "postmaster.pid");
}
const running = (stderr = ""): ObservedChild => ({
  exitCode: null,
  signalCode: null,
  stderrText: () => stderr,
});

it("keeps waiting when the pid file disappears between the check and the read", async () => {
  const file = await pidFile();
  await writeFile(file, "-7\n");
  const reads: string[] = [];
  const pid = await waitForPostmaster(running(), file, {
    timeoutMs: 5_000,
    read: (target) => {
      reads.push(target);
      // 첫 읽기 직전에 initdb가 파일을 지운다. 다음 읽기 전에 서버로 뜬 postgres가 다시 쓴다.
      if (reads.length === 1) rmSync(target);
      else writeFileSync(target, "4321\n/data\n");
      return readFileSync(target, "utf8");
    },
  });
  expect(pid).toBe(4321);
});

it("keeps waiting while the pid file is missing, empty, or still initdb's", async () => {
  const file = await pidFile();
  const contents = [undefined, "", "-12\n", "987\n"];
  const pid = await waitForPostmaster(running(), file, {
    timeoutMs: 5_000,
    read: (target) => {
      const next = contents.shift();
      if (next === undefined)
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return next;
    },
  });
  expect(pid).toBe(987);
});

it("fails with the read error when the pid file cannot be read for another reason", async () => {
  const file = await pidFile();
  await writeFile(file, "1\n");
  await expect(
    waitForPostmaster(running(), file, {
      timeoutMs: 5_000,
      read: () => {
        throw Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
      },
    })
  ).rejects.toThrow(/could not read .*postmaster\.pid.*EACCES/s);
});

it("fails when the server ends before Postgres starts", async () => {
  const file = await pidFile();
  await expect(
    waitForPostmaster(
      { exitCode: 1, signalCode: null, stderrText: () => "boom" },
      file,
      { timeoutMs: 5_000 }
    )
  ).rejects.toThrow(/server ended before Postgres started.*code 1.*boom/s);
});

it("fails at the deadline when Postgres never writes its pid", async () => {
  const file = await pidFile();
  await expect(
    waitForPostmaster(running("still starting"), file, { timeoutMs: 100 })
  ).rejects.toThrow(/Postgres did not start in 100ms: still starting/);
});
