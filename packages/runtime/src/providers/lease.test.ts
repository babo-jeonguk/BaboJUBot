import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  holdersInPs,
  leaseEntry,
  leaseHolders,
  leaseVariable,
  processStartTicks,
  stopLeaseHolders,
} from "./lease.ts";
import { exited, killAndWait, readyLine } from "./process-test-support.ts";

// 실행 시도의 프로그램과 그 자손은 표식 환경 변수를 물려받는다. 프로세스 그룹 밖으로 나간 자손도 이 표식으로 찾는다(#219).
const posix = process.platform !== "win32";
const linux = process.platform === "linux";
const started: number[] = [];
afterEach(async () => {
  await killAndWait(started.splice(0));
});

/** 새 세션(`detached`)에서 오래 도는 프로그램. 준비 줄을 낸 뒤에 돌려준다. */
async function program(
  options: {
    env?: NodeJS.ProcessEnv;
    args?: string[];
    ignoreTerm?: boolean;
  } = {}
) {
  return started_(
    spawn(
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
    )
  );
}
async function started_(child: ChildProcess) {
  started.push(child.pid!);
  const exit = new Promise<void>((resolve) =>
    child.on("exit", () => resolve())
  );
  await readyLine(child);
  return { pid: child.pid!, exited: exit };
}
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
    const { holders } = await leaseHolders(lease);
    expect(holders).toEqual([holder.pid]);
    for (const { pid } of [inArgs, otherRun, insideValue, unrelated])
      expect(holders).not.toContain(pid);
    expect(holders).not.toContain(process.pid);
  }
);

// Linux는 환경 변수 항목을 NUL로 나눠 정확히 비교하므로, 다른 변수의 값 안에 공백과 함께 들어 있어도 아니다. macOS `ps`는 구분하지 못한다(알려진 한계).
it.runIf(linux)(
  "does not take a marker inside another variable's value for the marker",
  async () => {
    const lease = randomUUID();
    const inside = await program({
      env: { OTHER: `x ${leaseEntry(lease)}` },
    });
    expect((await leaseHolders(lease)).holders).not.toContain(inside.pid);
  }
);

// macOS `ps -E`는 실행 인자 뒤에 환경 변수를 붙인다. 실행 인자 부분은 비교하지 않는다.
// 실행 인자를 따로 받은 두 목록(앞·뒤)이 같고, `-E` 줄이 그 실행 인자와 경계(공백)에서 이어질 때만 그 뒤를 환경 변수로 본다.
it("reads only the environment part of a ps listing", () => {
  const lease = "lease-1";
  const entry = leaseEntry(lease);
  const before = [
    "  101 node server.js",
    `  102 node tool.js ${entry}`,
    "  103 sh -c run",
    "  104 node moved.js",
    "  105 node other.js",
    "  107 node",
    "  108 node",
  ].join("\n");
  const withEnvironment = [
    `  101 node server.js PATH=/bin ${entry} HOME=/h`,
    `  102 node tool.js ${entry} PATH=/bin`,
    `  103 sh -c run OTHER=${entry}`,
    `  104 node changed.js ${entry}`,
    `  105 node other.js ${leaseEntry("lease-2")}`,
    `  106 node new.js ${entry}`,
    // 두 조회 사이에 실행 인자가 늘어 앞 목록의 실행 인자로 시작한다(exec 등). 늘어난 부분은 환경 변수가 아니다.
    `  107 node ${entry}`,
    // 실행 인자 경계가 맞지 않는다.
    `  108 nodejs ${entry}`,
  ].join("\n");
  const after = [
    "  101 node server.js",
    `  102 node tool.js ${entry}`,
    "  103 sh -c run",
    "  104 node changed.js",
    "  105 node other.js",
    "  106 node new.js",
    `  107 node ${entry}`,
    "  108 node",
  ].join("\n");
  expect(holdersInPs(before, withEnvironment, after, lease)).toEqual([101]);
});

// 끝났지만 거두어지지 않은 프로그램(좀비)도 환경을 읽을 수 없다. 이미 끝났으므로 확인하지 못한 것으로 세지 않는다.
it.runIf(linux)("does not count a zombie as unverified", async () => {
  const since = processStartTicks(process.pid)!;
  const parent = spawn(
    "python3",
    [
      "-c",
      "import os, time\npid = os.fork()\nif pid == 0: os._exit(0)\nprint(pid, flush=True)\ntime.sleep(60)",
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  started.push(parent.pid!);
  let line = "";
  for await (const chunk of parent.stdout!) {
    line += String(chunk);
    if (line.includes("\n")) break;
  }
  const zombie = Number(line.trim());
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () =>
      exited(zombie)
        ? resolve()
        : Date.now() > deadline
          ? reject(new Error("the forked child did not exit"))
          : setTimeout(check, 25);
    check();
  });
  expect(
    (await leaseHolders(randomUUID(), { since })).unverified
  ).not.toContain(zombie);
});

it.runIf(posix)(
  "stops a holder that ignores TERM with KILL after the grace",
  async () => {
    const lease = randomUUID();
    const holder = await program({
      env: { [leaseVariable]: lease },
      ignoreTerm: true,
    });
    const result = await stopLeaseHolders(lease, {
      find: async (value) => ({
        holders: (await leaseHolders(value)).holders,
        unverified: [],
      }),
    });
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
        lookups++ === 0
          ? { holders: [holder.pid, reused.pid], unverified: [] }
          : { holders: (await leaseHolders(value)).holders, unverified: [] },
    });
    await holder.exited;
    expect(exited(reused.pid)).toBe(false);
    expect(result.left).toEqual([]);
    expect(result.stopped).toContain(holder.pid);
  },
  30_000
);

// 확인하지 못한 프로그램에는 신호를 보내지 않고, 끄지 못한 것(`left`)으로 돌려준다.
it.runIf(posix)(
  "reports unverified programs as left without signalling them",
  async () => {
    const unknown = await program();
    const result = await stopLeaseHolders("lease", {
      find: async () => ({ holders: [], unverified: [unknown.pid] }),
    });
    expect(result).toEqual({ stopped: [], left: [unknown.pid] });
    expect(exited(unknown.pid)).toBe(false);
  }
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
    find: async () => ({ holders: [2 ** 22 + 1], unverified: [] }),
    waitMs: 100,
  });
  expect(result).toEqual({ stopped: [], left: [2 ** 22 + 1] });
});
