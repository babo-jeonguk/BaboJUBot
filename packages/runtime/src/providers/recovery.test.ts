import { spawn } from "node:child_process";
import {
  utimes,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { recoverProviderProcesses } from "./recovery.ts";

// 복구 기록 하나 때문에 서버가 뜨지 못하면 안 된다. 경고하고 넘어간다.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function records() {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-recovery-"));
  roots.push(root);
  const directory = path.join(root, "providers/claude/processes");
  await mkdir(directory, { recursive: true });
  return { root, directory };
}

it("skips a record that cannot be read and still handles the others", async () => {
  const { root, directory } = await records();
  await writeFile(path.join(directory, "123.json"), '{"pid":12');
  await writeFile(
    path.join(directory, "456.json"),
    JSON.stringify({
      pid: 456,
      start: "1",
      group: 456,
      boot: "another-boot",
      lease: "x",
    })
  );
  await expect(recoverProviderProcesses(root)).resolves.toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
});

it("leaves a process group it cannot identify alone and still starts", async () => {
  const { root, directory } = await records();
  const leader = spawn("sh", ["-c", "sleep 30 & exit 0"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => leader.on("close", resolve));
  const group = leader.pid!;
  try {
    await writeFile(
      path.join(directory, `${group}.json`),
      JSON.stringify({
        pid: group,
        start: "1",
        group,
        boot: (
          await readFile("/proc/sys/kernel/random/boot_id", "utf8")
        ).trim(),
        lease: "not-the-real-lease",
      })
    );
    await expect(recoverProviderProcesses(root)).resolves.toBeUndefined();
    expect(() => process.kill(-group, 0)).not.toThrow();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    process.kill(-group, "SIGKILL");
  }
});

// macOS 경로는 프로세스 시작 시각으로 판단하므로 이 컴퓨터에서도 시험할 수 있다.
const longRunning = () =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

it("stops a leftover process on systems without /proc", async () => {
  const { root, directory } = await records();
  const child = longRunning();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    await writeFile(
      path.join(directory, `${child.pid}.json`),
      JSON.stringify({ pid: child.pid, lease: "lease" })
    );
    await recoverProviderProcesses(root, { platform: "darwin" });
    await new Promise((resolve) => child.on("close", resolve));
    expect(gone(child.pid!)).toBe(true);
  } finally {
    if (!gone(child.pid!)) process.kill(child.pid!, "SIGKILL");
  }
});

it("leaves a process that started after the record was written", async () => {
  const { root, directory } = await records();
  const child = longRunning();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const file = path.join(directory, `${child.pid}.json`);
  try {
    await writeFile(file, JSON.stringify({ pid: child.pid, lease: "lease" }));
    const yesterday = new Date(Date.now() - 86_400_000);
    await utimes(file, yesterday, yesterday);
    await recoverProviderProcesses(root, { platform: "darwin" });
    expect(gone(child.pid!)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    process.kill(child.pid!, "SIGKILL");
  }
});

it("recovers every connection folder, including named ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-recovery-"));
  roots.push(root);
  const directory = path.join(root, "providers/claude-work/processes");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "123.json"), "broken");
  await recoverProviderProcesses(root);
  expect(await readdir(directory)).toEqual([]);
});
