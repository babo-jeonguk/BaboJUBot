import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  processStartedAt,
  recordProcess,
  recoverProviderProcesses,
} from "./recovery.ts";
import { leaseVariable, processStartTicks } from "./lease.ts";
import { killUnlessGone, readyLine } from "./process-test-support.ts";
import { testFolders } from "./test-folders.ts";
import { withCleanup } from "../test-cleanup.ts";

// Linux 기록의 시작 시각(clock tick). 표식을 읽을 수 없는 프로그램은 이 뒤에 생겼을 때만 우리 것일 수 있다.
// 시험이 만든 기록은 시험 프로세스의 시작 시각을 쓴다. 그 전부터 돌던 이 컴퓨터의 프로그램(gpg-agent 등)은 대상이 아니다.
const testStart = () => String(processStartTicks(process.pid) ?? 1);

// 표식 조회 실패를 주입한다.
const lease = vi.hoisted(() => ({ fails: false }));
vi.mock("./lease.ts", async (original) => {
  const real = await original<typeof import("./lease.ts")>();
  return {
    ...real,
    stopLeaseHolders: async (
      value: string,
      options?: Parameters<typeof real.stopLeaseHolders>[1]
    ) => {
      if (lease.fails) throw new Error("ps failed");
      return real.stopLeaseHolders(value, options);
    },
  };
});

// 복구 기록 하나 때문에 서버가 뜨지 못하면 안 된다. 경고하고 넘어간다.
const folders = testFolders();
// 시험이 새 세션으로 띄운 프로그램(그룹 번호 = 프로그램 번호). 띄우자마자 넣어, 준비나 단언이 실패해도 그룹째 끄고 끝날 때까지 기다린다.
const groups: number[] = [];
afterEach(async () => {
  lease.fails = false;
  for (const group of groups)
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // 이미 끝났다.
    }
  for (const group of groups.splice(0)) await until(() => groupGone(group));
});
async function records() {
  const root = await folders.make("babojubot-recovery-");
  const directory = path.join(root, "providers/claude/processes");
  await mkdir(directory, { recursive: true });
  return { root, directory };
}

it("skips a record that cannot be read and still handles the others", async () => {
  const { root, directory } = await records();
  await writeFile(path.join(directory, "123.json"), '{"pid":12');
  // 이미 끝난 프로세스의 번호를 쓴다. 고정 번호는 다른 시스템에서 살아 있을 수 있다.
  const finished = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(
    path.join(directory, `${finished}.json`),
    JSON.stringify({
      pid: finished,
      start: "1",
      group: finished,
      boot: "another-boot",
      lease: "x",
    })
  );
  await expect(recoverProviderProcesses(root)).resolves.toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
});

// 끝난 뒤 거두어지지 않은 프로세스만 남으면 macOS는 ESRCH 대신 EPERM을 돌려준다. 정말 없어질 때까지 본다.
const groupGone = (group: number) => {
  try {
    process.kill(-group, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};
const until = (done: () => boolean) =>
  expect.poll(done, { timeout: 10_000, interval: 25 }).toBe(true);

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
    // 그룹은 시험 중간에 끝내고, 끝난 뒤의 복구를 이어서 본다.
    await withCleanup(async (defer) => {
      defer(() => killUnlessGone(-group));
      await writeFile(
        path.join(directory, `${group}.json`),
        JSON.stringify({
          pid: group,
          start: testStart(),
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
    });
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
  const child = folders.ownChild(longRunning());
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");

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
}, 30_000);

// 번호가 같아도 시작 시각이 다르면 남이다. 시작 시각은 언제 물어도 같으므로 여유를 두지 않는다.
it("leaves a process whose start differs from the recorded one", async () => {
  const { root, directory } = await records();
  const child = folders.ownChild(longRunning());
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");

  const started = processStartedAt(child.pid!, withoutProc)!;
  await writeFile(
    path.join(directory, `${child.pid}.json`),
    JSON.stringify({ pid: child.pid, lease: "lease", started: started - 1 })
  );
  await recoverProviderProcesses(root, { platform: withoutProc });
  expect(gone(child.pid!)).toBe(false);
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

// 시작 시각을 남기기 전에 서버가 죽은 기록이다. 우리 것인지 모르니 건드리지 않고 남긴다.
it("keeps a record without a start and leaves the process alone", async () => {
  const { root, directory } = await records();
  const child = folders.ownChild(longRunning());
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");
  const file = `${child.pid}.json`;

  await writeFile(
    path.join(directory, file),
    JSON.stringify({ pid: child.pid, lease: "lease" })
  );
  await recoverProviderProcesses(root, { platform: withoutProc });
  expect(gone(child.pid!)).toBe(false);
  expect(await readdir(directory)).toEqual([file]);
}, 30_000);

// 이 시스템의 실제 경로: 기록을 남기면 다음 시작 때 그 프로세스를 찾아 끝낸다.
it("stops a process it recorded itself", async () => {
  const { root } = await records();
  const home = path.join(root, "providers/claude");
  const child = folders.ownChild(longRunning());
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");
  const file = path.join(home, "processes", `${child.pid}.json`);

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
}, 30_000);

// 기록은 서버 밖의 프로그램도 고칠 수 있다. 이름과 맞지 않거나 번호가 아닌 기록으로는 아무것도 끝내지 않는다.
it("does not act on a record that does not match its name", async () => {
  const { root, directory } = await records();
  const child = folders.ownChild(longRunning());
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");

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
    // 그룹은 시험 중간에 끝내고, 끝난 뒤의 복구를 이어서 본다.
    await withCleanup(async (defer) => {
      defer(() => killUnlessGone(-group));
      await writeFile(
        path.join(directory, `${group}.json`),
        JSON.stringify({ pid: group, lease: "lease" })
      );
      await recoverProviderProcesses(root, { platform: withoutProc });
      expect(groupGone(group)).toBe(false);
      expect(await readdir(directory)).toEqual([`${group}.json`]);
    });
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
  const closed = once(child, "close");
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");
  const file = `${child.pid}.json`;
  // 프로그램은 시험 중간에 끝내고, 끝난 뒤의 복구를 이어서 본다.
  await withCleanup(async (defer) => {
    defer(async () => {
      child.kill("SIGKILL");
      await closed;
    });
    defer(() => vi.unstubAllEnvs());
    await writeFile(
      path.join(directory, file),
      JSON.stringify({ pid: child.pid, lease: "lease", started: 1 })
    );
    vi.stubEnv("PATH", "");
    await recoverProviderProcesses(root, { platform: withoutProc });
    vi.unstubAllEnvs();
    expect(gone(child.pid!)).toBe(false);
    expect(await readdir(directory)).toEqual([file]);
  });
  await recoverProviderProcesses(root, { platform: withoutProc });
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

it("recovers every connection folder, including named ones", async () => {
  const root = await folders.make("babojubot-recovery-");
  const directory = path.join(root, "providers/claude-work/processes");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "123.json"), "broken");
  await recoverProviderProcesses(root);
  expect(await readdir(directory)).toEqual([]);
});

// 서버가 강제로 끝난 뒤 에이전트까지 죽으면 대표와 그룹은 사라지고 새 세션의 명령만 남는다. 표식으로 우리 것임을 확인해 끈다(#219).
const platforms = [...new Set([process.platform, withoutProc])].filter(
  (platform) => platform !== "win32"
);
/** 표식을 가진 새 세션 프로그램. 표식은 exec 뒤에 보이므로 준비 줄을 낸 뒤에 돌려준다. */
const marked = async (
  value: string,
  script = "setInterval(() => {}, 1000)"
) => {
  const child = spawn(
    process.execPath,
    ["-e", `console.log("ready"); ${script}`],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH, [leaseVariable]: value },
    }
  );
  groups.push(child.pid!);
  const closed = new Promise((resolve) => child.on("close", resolve));
  await readyLine(child);
  return { child, closed };
};
async function recordFor(directory: string, pid: number, value: string) {
  const boot =
    process.platform === "linux"
      ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
      : undefined;
  await writeFile(
    path.join(directory, `${pid}.json`),
    JSON.stringify({ pid, start: testStart(), group: pid, boot, lease: value })
  );
}

it.each(platforms)(
  "stops a marked program left in another session after the leader and its group are gone (%s)",
  async (platform) => {
    const { root, directory } = await records();
    const value = crypto.randomUUID();
    const leftover = await marked(value);
    const ignored = await marked(crypto.randomUUID());
    const finished = spawnSync(process.execPath, ["-e", ""]).pid;
    await recordFor(directory, finished, value);
    await recoverProviderProcesses(root, { platform });
    await leftover.closed;
    expect(gone(ignored.child.pid!)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  },
  30_000
);

// 대표만 끝나고 그룹이 남았을 때 /proc가 없으면 번호만으로는 우리 것인지 몰랐다. 남은 것이 모두 표식을 가졌으면 끄고 기록을 지운다.
it.each(platforms)(
  "stops a leftover group whose members carry the run marker (%s)",
  async (platform) => {
    const { root, directory } = await records();
    const value = crypto.randomUUID();
    const leader = await marked(
      value,
      `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).unref()`
    );
    await leader.closed;
    const group = leader.child.pid!;
    await recordFor(directory, group, value);
    await recoverProviderProcesses(root, { platform });
    await until(() => groupGone(group));
    expect(await readdir(directory)).toEqual([]);
  },
  30_000
);

it.skipIf(process.platform === "win32")(
  "keeps the record when programs with the run marker could not be looked up",
  async () => {
    const { root, directory } = await records();
    const finished = spawnSync(process.execPath, ["-e", ""]).pid;
    await recordFor(directory, finished, "lease");
    lease.fails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recoverProviderProcesses(root);
    expect(await readdir(directory)).toEqual([`${finished}.json`]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("it stays for the next start")
    );
    warn.mockRestore();
  }
);
