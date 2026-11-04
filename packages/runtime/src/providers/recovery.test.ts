import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  processStartedAt,
  recordProcess,
  recoverProviderProcesses,
} from "./recovery.ts";

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

const groupGone = (group: number) => {
  try {
    process.kill(-group, 0);
    return false;
  } catch {
    return true;
  }
};
const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(done()).toBe(true);
};

it("starts even when a record can be neither read nor removed", async () => {
  const { root, directory } = await records();
  await mkdir(path.join(directory, "123.json"));
  await expect(recoverProviderProcesses(root)).resolves.toBeUndefined();
  expect(await readdir(directory)).toEqual(["123.json"]);
});

it.runIf(process.platform === "linux")(
  "leaves a process group it cannot identify alone and still starts",
  async () => {
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
      // 끝났음을 확인하지 못했으니 기록을 남겨 다음 시작 때 다시 본다.
      expect(await readdir(directory)).toEqual([`${group}.json`]);
    } finally {
      process.kill(-group, "SIGKILL");
    }
    await until(() => groupGone(group));
    await recoverProviderProcesses(root);
    expect(await readdir(directory)).toEqual([]);
  }
);

// /proc가 없는 경로는 프로세스 시작 시각으로 판단하므로 Linux에서도 시험할 수 있다. 다른 OS는 자기 경로를 시험한다.
const withoutProc = process.platform === "linux" ? "darwin" : process.platform;
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
      JSON.stringify({
        pid: child.pid,
        lease: "lease",
        started: processStartedAt(child.pid!, withoutProc),
      })
    );
    const closed = new Promise((resolve) => child.on("close", resolve));
    await recoverProviderProcesses(root, { platform: withoutProc });
    await closed;
    expect(gone(child.pid!)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    if (!gone(child.pid!)) process.kill(child.pid!, "SIGKILL");
  }
}, 30_000);

// 번호가 같아도 시작 시각이 다르면 남이다. 시작 시각은 언제 물어도 같으므로 여유를 두지 않는다.
it("leaves a process whose start differs from the recorded one", async () => {
  const { root, directory } = await records();
  const child = longRunning();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const started = processStartedAt(child.pid!, withoutProc)!;
    await writeFile(
      path.join(directory, `${child.pid}.json`),
      JSON.stringify({ pid: child.pid, lease: "lease", started: started - 1 })
    );
    await recoverProviderProcesses(root, { platform: withoutProc });
    expect(gone(child.pid!)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    process.kill(child.pid!, "SIGKILL");
  }
}, 30_000);

// 시작 시각을 남기기 전에 서버가 죽은 기록이다. 우리 것인지 모르니 건드리지 않고 남긴다.
it("keeps a record without a start and leaves the process alone", async () => {
  const { root, directory } = await records();
  const child = longRunning();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const file = `${child.pid}.json`;
  try {
    await writeFile(
      path.join(directory, file),
      JSON.stringify({ pid: child.pid, lease: "lease" })
    );
    await recoverProviderProcesses(root, { platform: withoutProc });
    expect(gone(child.pid!)).toBe(false);
    expect(await readdir(directory)).toEqual([file]);
  } finally {
    process.kill(child.pid!, "SIGKILL");
  }
}, 30_000);

// 이 시스템의 실제 경로: 기록을 남기면 다음 시작 때 그 프로세스를 찾아 끝낸다.
it("stops a process it recorded itself", async () => {
  const { root } = await records();
  const home = path.join(root, "providers/claude");
  const child = longRunning();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const file = path.join(home, "processes", `${child.pid}.json`);
  try {
    recordProcess(home, child.pid!, "lease");
    await vi.waitFor(
      async () => expect(await readFile(file, "utf8")).toMatch(/"start(ed)?"/),
      { timeout: 20_000, interval: 50 }
    );
    const closed = new Promise((resolve) => child.on("close", resolve));
    await recoverProviderProcesses(root);
    await closed;
    expect(gone(child.pid!)).toBe(true);
    expect(await readdir(path.dirname(file))).toEqual([]);
  } finally {
    if (!gone(child.pid!)) process.kill(child.pid!, "SIGKILL");
  }
}, 30_000);

it("does not write the record again after forgetting it", async () => {
  const { root } = await records();
  const home = path.join(root, "providers/claude");
  const child = longRunning();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    recordProcess(home, child.pid!, "lease")();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await readdir(path.join(home, "processes"))).toEqual([]);
  } finally {
    process.kill(child.pid!, "SIGKILL");
  }
}, 30_000);

// 기록은 서버 밖의 프로그램도 고칠 수 있다. 이름과 맞지 않거나 번호가 아닌 기록으로는 아무것도 끝내지 않는다.
it("does not act on a record that does not match its name", async () => {
  const { root, directory } = await records();
  const child = longRunning();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    await writeFile(
      path.join(directory, "123.json"),
      JSON.stringify({ pid: child.pid, lease: "lease" })
    );
    await writeFile(
      path.join(directory, "124.json"),
      JSON.stringify({ pid: "124; echo hello", lease: "lease" })
    );
    await recoverProviderProcesses(root, { platform: withoutProc });
    expect(gone(child.pid!)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    process.kill(child.pid!, "SIGKILL");
  }
}, 30_000);

it.skipIf(process.platform === "win32")(
  "keeps the record while children outlive their leader on systems without /proc",
  async () => {
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
        JSON.stringify({ pid: group, lease: "lease" })
      );
      await recoverProviderProcesses(root, { platform: withoutProc });
      expect(groupGone(group)).toBe(false);
      expect(await readdir(directory)).toEqual([`${group}.json`]);
    } finally {
      process.kill(-group, "SIGKILL");
    }
    await until(() => groupGone(group));
    await recoverProviderProcesses(root, { platform: withoutProc });
    expect(await readdir(directory)).toEqual([]);
  },
  30_000
);

// 시작 시각을 알 수 없다고 끝난 것은 아니다. 프로세스가 살아 있으면 기록을 남긴다.
it("keeps the record of a live process whose start cannot be read", async () => {
  const { root, directory } = await records();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const file = `${child.pid}.json`;
  try {
    await writeFile(
      path.join(directory, file),
      JSON.stringify({ pid: child.pid, lease: "lease", started: 1 })
    );
    vi.stubEnv("PATH", "");
    await recoverProviderProcesses(root, { platform: withoutProc });
    vi.unstubAllEnvs();
    expect(gone(child.pid!)).toBe(false);
    expect(await readdir(directory)).toEqual([file]);
  } finally {
    vi.unstubAllEnvs();
    const closed = new Promise((resolve) => child.on("close", resolve));
    child.kill("SIGKILL");
    await closed;
  }
  await recoverProviderProcesses(root, { platform: withoutProc });
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

it("recovers every connection folder, including named ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "babojubot-recovery-"));
  roots.push(root);
  const directory = path.join(root, "providers/claude-work/processes");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "123.json"), "broken");
  await recoverProviderProcesses(root);
  expect(await readdir(directory)).toEqual([]);
});
