import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  holdersInPs,
  leaseEntry,
  leaseHolders,
  leaseVariable,
  stopLeaseHolders,
} from "./lease.ts";

// 실행 시도의 프로그램과 그 자손은 표식 환경 변수를 물려받는다. 프로세스 그룹 밖으로 나간 자손도 이 표식으로 찾는다(#219).
const posix = process.platform !== "win32";
const started: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    started.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    })
  );
});

/** 새 세션(`detached`)에서 오래 도는 프로그램. 준비 줄을 낸 뒤에 돌려준다. */
async function program(
  options: {
    env?: NodeJS.ProcessEnv;
    args?: string[];
    ignoreTerm?: boolean;
  } = {}
) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""} console.log("ready"); setInterval(() => {}, 1000);`,
      ...(options.args ?? []),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH, ...options.env },
    }
  );
  started.push(child);
  const exited = new Promise<void>((resolve) =>
    child.on("exit", () => resolve())
  );
  // 준비 줄 전에 끝나면 기다리지 않고 실패한다.
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("error", reject);
    child.once("close", () => reject(new Error("exited before ready")));
  });
  return { pid: child.pid!, exited };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.runIf(posix)(
  "finds only programs whose environment holds this run's marker exactly",
  async () => {
    const lease = randomUUID();
    const entry = leaseEntry(lease);
    const holder = await program({ env: { [leaseVariable]: lease } });
    const inArgs = await program({ args: [entry] });
    const otherRun = await program({
      env: { [leaseVariable]: randomUUID() },
    });
    const insideValue = await program({ env: { OTHER: entry } });
    const unrelated = await program();
    const found = await leaseHolders(lease);
    expect(found).toEqual([holder.pid]);
    for (const { pid } of [inArgs, otherRun, insideValue, unrelated])
      expect(found).not.toContain(pid);
    expect(found).not.toContain(process.pid);
  }
);

// Linux는 환경 변수 항목을 NUL로 나눠 정확히 비교하므로, 다른 변수의 값 안에 공백과 함께 들어 있어도 아니다. macOS `ps`는 구분하지 못한다(알려진 한계).
it.runIf(process.platform === "linux")(
  "does not take a marker inside another variable's value for the marker",
  async () => {
    const lease = randomUUID();
    const inside = await program({
      env: { OTHER: `x ${leaseEntry(lease)}` },
    });
    expect(await leaseHolders(lease)).not.toContain(inside.pid);
  }
);

// macOS `ps -E`는 실행 인자 뒤에 환경 변수를 붙인다. 같은 줄의 실행 인자 부분은 비교하지 않는다.
it("reads only the environment part of a ps listing", () => {
  const lease = "lease-1";
  const entry = leaseEntry(lease);
  const commands = [
    "  101 node server.js",
    `  102 node tool.js ${entry}`,
    "  103 sh -c run",
    "  104 node moved.js",
    "  105 node other.js",
  ].join("\n");
  const withEnvironment = [
    `  101 node server.js PATH=/bin ${entry} HOME=/h`,
    `  102 node tool.js ${entry} PATH=/bin`,
    `  103 sh -c run OTHER=${entry}`,
    // 두 조회 사이에 실행 인자가 바뀐 프로그램은 확인할 수 없다. 다음 조회에서 다시 본다.
    `  104 node changed.js ${entry}`,
    `  105 node other.js ${leaseEntry("lease-2")}`,
    `  106 node new.js ${entry}`,
  ].join("\n");
  expect(holdersInPs(commands, withEnvironment, lease)).toEqual([101]);
});

it.runIf(posix)(
  "stops a holder that ignores TERM with KILL after the grace",
  async () => {
    const lease = randomUUID();
    const holder = await program({
      env: { [leaseVariable]: lease },
      ignoreTerm: true,
    });
    const result = await stopLeaseHolders(lease);
    await holder.exited;
    expect(result).toEqual({ stopped: [holder.pid], left: [] });
  },
  30_000
);

// 찾은 뒤 강제 종료 전에 그 번호가 끝나 다른 프로그램에 재사용될 수 있다. KILL은 표식으로 다시 찾은 번호에만 보낸다.
it.runIf(posix)(
  "sends KILL only to programs found again by the marker",
  async () => {
    const lease = randomUUID();
    const holder = await program({
      env: { [leaseVariable]: lease },
      ignoreTerm: true,
    });
    // 첫 조회가 표식이 없는 프로그램을 잘못 돌려준 경우다(번호 재사용을 흉내 낸다). 그 프로그램도 TERM은 무시한다.
    const reused = await program({ ignoreTerm: true });
    let lookups = 0;
    const result = await stopLeaseHolders(lease, {
      find: async (value) =>
        lookups++ === 0 ? [holder.pid, reused.pid] : leaseHolders(value),
    });
    await holder.exited;
    expect(alive(reused.pid)).toBe(true);
    expect(result.left).toEqual([]);
    expect(result.stopped).toContain(holder.pid);
  },
  30_000
);

it("reports a failed lookup instead of a clean stop", async () => {
  await expect(
    stopLeaseHolders("lease", {
      find: async () => {
        throw new Error("ps failed");
      },
    })
  ).rejects.toThrow("ps failed");
});

it("reports what is still running when the wait runs out", async () => {
  const result = await stopLeaseHolders("lease", {
    find: async () => [2 ** 22 + 1],
    waitMs: 100,
  });
  expect(result).toEqual({ stopped: [], left: [2 ** 22 + 1] });
});
