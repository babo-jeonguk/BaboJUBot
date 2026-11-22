import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  leaseEntry,
  leaseHolders,
  leaseVariable,
  lookupInPs,
  processStartTicks,
  stopLeaseHolders,
  type LeaseLookup,
} from "./lease.ts";
import { exited, killAndWait, readyLine } from "./process-test-support.ts";
import { manualClock } from "./test-support.ts";

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
// 그렇게 확인할 수 없는데 `-E` 줄에 표식이 있으면 우리 것인지 모른다. 끄지 않고 "확인하지 못함"으로 둔다(PR #220 외부 리뷰 SPEC-3).
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
  expect(lookupInPs(before, withEnvironment, after, lease)).toEqual({
    holders: [101],
    unverified: [104, 106, 107, 108],
  });
});

// 표식을 환경에 가진 프로그램의 실행 인자가 세 조회 사이에 바뀌었다. 표식이 없는 것으로 치면 정리 성공이 되어 기록이 지워진다.
it("does not take a marked program whose command line changed for an absent one", () => {
  const entry = leaseEntry("abc");
  expect(
    lookupInPs(
      "  123 node old.js",
      `  123 node new.js ${entry}`,
      "  123 node new.js",
      "abc"
    )
  ).toEqual({ holders: [], unverified: [123] });
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
  await vi.waitFor(
    () => {
      if (!exited(zombie)) throw new Error("the forked child did not exit");
    },
    { timeout: 5000, interval: 25 }
  );
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

/**
 * 정리의 시한 규칙을 가짜 시계로 시험한다(#225). 시한·유예·다시 찾기 간격을 이 시계로 재고, 조회가 끝나는 때도 시험이 이 시계로 정한다.
 * 조회가 실제로 하는 일(`answer`)이 모두 끝나 정리가 시계만 기다릴 때에만 시간을 다음 타이머까지 옮기므로, 실행기가 느려도 순서가 같다.
 * 신호는 보내지 않고 `process.kill` 호출을 그때의 시각과 함께 기록한다. 실제 TERM·KILL 전달은 위의 실제 프로그램 시험이 본다.
 */
function fakeTime() {
  const clock = manualClock();
  const signals: { pid: number; signal: string; at: number }[] = [];
  const kill = vi
    .spyOn(process, "kill")
    .mockImplementation((pid: number, signal?: string | number) => {
      signals.push({ pid, signal: String(signal), at: clock.now() });
      return true;
    });
  onTestFinished(() => kill.mockRestore());
  let working = 0;
  let calls = 0;
  let finished = 0;
  return {
    clock,
    /** 그 번호가 받은 신호와 시각. */
    signalsTo: (pid: number) =>
      signals
        .filter((each) => each.pid === pid)
        .map(({ signal, at }) => ({ signal, at })),
    /** 끝난 조회 수. */
    finished: () => finished,
    /**
     * 조회. 몇 번째 조회인지(0부터)와 시작한 시각으로 `answer`가 답을 정하고, 그 뒤 `takesMs`만큼 가짜 시계로 걸린다.
     */
    find(
      answer: (
        call: number,
        startedAt: number
      ) => LeaseLookup | Promise<LeaseLookup>,
      takesMs: (call: number) => number = () => 0
    ) {
      return async () => {
        const call = calls++;
        const startedAt = clock.now();
        working++;
        let found: LeaseLookup;
        try {
          found = await answer(call, startedAt);
        } finally {
          working--;
        }
        const takes = takesMs(call);
        if (takes > 0)
          await new Promise((resolve) =>
            clock.setTimeout(() => resolve(null), takes)
          );
        finished++;
        return found;
      };
    },
    /** 정리가 끝날 때까지 돌린다. 기다리는 일이 없는데 끝나지 않으면 실패한다. */
    async run<T>(work: Promise<T>): Promise<T> {
      let settled = false;
      work.then(
        () => (settled = true),
        () => (settled = true)
      );
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (settled) return work;
        if (working > 0) continue;
        const next = clock.untilNext();
        if (next === undefined)
          throw new Error("the cleanup waits on nothing and never ends");
        clock.advance(next);
      }
    },
  };
}

// 확인하지 못했던 프로그램이 유예가 거의 끝날 때 처음 보유자로 확인되어도, 그 프로그램은 TERM 뒤 자기 유예를 다 받은 뒤에야 KILL을 받는다(PR #220 외부 리뷰 SPEC-4).
it("gives a holder confirmed late its own grace before KILL", async () => {
  const fake = fakeTime();
  const late = 2 ** 22 + 7;
  const killed = () =>
    fake.signalsTo(late).some(({ signal }) => signal === "SIGKILL");
  const result = await fake.run(
    stopLeaseHolders("lease", {
      clock: fake.clock,
      graceMs: 1000,
      find: fake.find((_, startedAt) =>
        startedAt < 900
          ? { holders: [], unverified: [late] }
          : { holders: killed() ? [] : [late], unverified: [] }
      ),
    })
  );
  const [term, kill, ...rest] = fake.signalsTo(late);
  expect([term?.signal, kill?.signal, rest]).toEqual([
    "SIGTERM",
    "SIGKILL",
    [],
  ]);
  // 처음 확인된 때 TERM을 받고, 전체 유예(시작 뒤 1000)가 아니라 자기 유예가 지난 뒤에 KILL을 받는다.
  expect(term!.at).toBeGreaterThanOrEqual(900);
  expect(kill!.at - term!.at).toBeGreaterThanOrEqual(1000);
  expect(result).toEqual({ stopped: [late], left: [] });
});

// 전체 시한 안에 자기 유예를 받을 수 없을 만큼 늦게 확인된 보유자는 강제로 끄지 않고 끄지 못한 것으로 돌려준다(정리 실패·기록 유지).
// 끝나지 않는 보유자(TERM·KILL을 받아도 계속 보이는 번호) 하나가 시한까지 정리를 붙잡는 동안, 다른 프로그램이 시한(2000) 직전에 처음 확인된다.
it("leaves a holder confirmed too late for its grace running and reports it", async () => {
  const fake = fakeTime();
  const stuck = 2 ** 22 + 1;
  const late = 2 ** 22 + 9;
  const result = await fake.run(
    stopLeaseHolders("lease", {
      clock: fake.clock,
      graceMs: 1000,
      waitMs: 1000,
      find: fake.find((_, startedAt) =>
        startedAt < 1900
          ? { holders: [stuck], unverified: [late] }
          : { holders: [stuck, late], unverified: [] }
      ),
    })
  );
  expect(fake.signalsTo(late).map(({ signal }) => signal)).toEqual(["SIGTERM"]);
  expect(fake.signalsTo(late)[0]!.at).toBeGreaterThanOrEqual(1900);
  expect(result).toEqual({ stopped: [], left: [stuck, late] });
});

// 조회 하나가 전체 시한(유예 + 대기)을 넘겨도 기다리지 않는다. 시한에 걸린 조회는 버리고 마지막으로 끝난 조회가 본 것을 끄지 못한 것(`left`)으로 돌려주며,
// 늦게 돌아온 조회 결과로는 신호를 보내지 않는다(PR #220 외부 리뷰 SPEC-5). 끝난 조회가 하나도 없으면 조회 실패로 던진다(아래 시험).
it("gives up on a lookup that outlasts the overall limit and sends nothing after it", async () => {
  const fake = fakeTime();
  const stuck = 2 ** 22 + 1;
  const late = 2 ** 22 + 5;
  const result = await fake.run(
    stopLeaseHolders("lease", {
      clock: fake.clock,
      graceMs: 100,
      waitMs: 100,
      // 처음 조회는 바로 끝나고, 그 뒤 조회는 600 걸린다(시한 200을 넘긴다).
      find: fake.find(
        (call) =>
          call === 0
            ? { holders: [stuck], unverified: [] }
            : { holders: [stuck, late], unverified: [] },
        (call) => (call === 0 ? 0 : 600)
      ),
    })
  );
  // 늦은 조회가 끝나기 전, 시한에 끝냈다.
  expect(fake.clock.now()).toBe(200);
  expect(fake.finished()).toBe(1);
  expect(result.left).toEqual([stuck]);
  // 늦은 조회가 끝나고 그 뒤에 이어질 수 있는 일까지 돈 다음에도 그 결과로 신호를 보내지 않았다.
  fake.clock.advance(1000);
  await new Promise((resolve) => setImmediate(resolve));
  expect(fake.finished()).toBe(2);
  expect(fake.signalsTo(late)).toEqual([]);
});

it("gives up on a first lookup that outlasts the overall limit", async () => {
  const fake = fakeTime();
  await expect(
    fake.run(
      stopLeaseHolders("lease", {
        clock: fake.clock,
        graceMs: 100,
        waitMs: 100,
        find: () => new Promise(() => {}),
      })
    )
  ).rejects.toThrow("Run marker lookup did not finish in time");
  // 시한(유예 + 대기)에 실패했다.
  expect(fake.clock.now()).toBe(200);
});

// 끈 것(`stopped`)과 끄지 못한 것(`left`)에 같은 번호가 함께 들어가지 않는다. TERM을 보낸 뒤 확인하지 못하게 된 것은 끄지 못한 것이다(SPEC-6).
it("does not report a program as both stopped and left", async () => {
  const pid = 2 ** 22 + 3;
  let lookups = 0;
  const result = await stopLeaseHolders("lease", {
    graceMs: 200,
    find: async () =>
      lookups++ === 0
        ? { holders: [pid], unverified: [] }
        : { holders: [], unverified: [pid] },
  });
  expect(result).toEqual({ stopped: [], left: [pid] });
});

// 처음에 확인하지 못한 프로그램은 유예 동안 다시 찾아 본다. 표식이 확인되면 끈다.
it.runIf(posix)(
  "looks again at unverified programs and stops them once the marker is confirmed",
  async () => {
    const lease = randomUUID();
    const holder = await program({ env: { [leaseVariable]: lease } });
    let lookups = 0;
    const result = await stopLeaseHolders(lease, {
      find: async (value) =>
        lookups++ === 0
          ? { holders: [], unverified: [holder.pid] }
          : { holders: (await leaseHolders(value)).holders, unverified: [] },
    });
    await holder.exited;
    expect(result).toEqual({ stopped: [holder.pid], left: [] });
  },
  30_000
);

// 확인하지 못한 프로그램에는 신호를 보내지 않고, 끝까지 확인하지 못하면 끄지 못한 것(`left`)으로 돌려준다.
it.runIf(posix)(
  "reports unverified programs as left without signalling them",
  async () => {
    const unknown = await program();
    const result = await stopLeaseHolders("lease", {
      find: async () => ({ holders: [], unverified: [unknown.pid] }),
      graceMs: 200,
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

// #268 PR 2: 찾은 번호에 나중에 신호하면, 찾은 뒤 그 번호가 다른 프로그램에 다시 주어졌을 때 그 프로그램이 신호를 받는다. 신원을
// 확인한 바로 그 프로세스에만 신호해야 한다. 첫 조회가 돌려준 직후 그 번호가 표식 없는 다른 프로그램에 갔다고 본다.
it("sends no signal to a number that went to another program after it was found", async () => {
  const fake = fakeTime();
  const pid = 2 ** 22 + 5;
  const result = await fake.run(
    stopLeaseHolders("lease", {
      clock: fake.clock,
      graceMs: 100,
      waitMs: 100,
      find: fake.find((call) =>
        call === 0
          ? { holders: [pid], unverified: [] }
          : { holders: [], unverified: [] }
      ),
    })
  );
  expect(fake.signalsTo(pid)).toEqual([]);
  expect(result.left).toEqual([]);
});
