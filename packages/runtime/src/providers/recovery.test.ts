import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { launchTree } from "@babojubot/process";
import { recordProcess, recoverProviderProcesses } from "./recovery.ts";
import { leaseVariable, processStartTicks } from "@babojubot/process/recovery";
import { exited, readyLine } from "@babojubot/process/testing";
import { testFolders } from "./test-folders.ts";
import { openLifelines, type Lifelines } from "@babojubot/process/lifelines";
import {
  awaitedLater,
  lifelineHolder,
  withCleanup,
} from "@babojubot/process/test-cleanup";
import { within } from "@babojubot/process/test-support";

/**
 * 실행의 시작: 이 시험 프로세스의 시작 시각을 감독 실행기가 쓰는 단위로 나타낸 것. 기록의 시작 시각은 정리 요청의 실행 시작(`since`)으로도
 * 쓰이므로, 실제 기록처럼 과거의 값이어야 그 전부터 있던 이 컴퓨터의 숨은 프로그램(gpg-agent, macOS에서 정보가 막힌 로그인 때
 * 프로세스 등)을 "확인하지 못함"으로 세지 않고, 그 뒤에 생긴 것은 판정에 그대로 든다. 단위는 시스템마다 정해 고른다: Linux는
 * `/proc`의 부팅 뒤 clock tick(읽지 못하면 던진다. 다른 단위의 값으로 대신하면 실행 시작이 미래가 되어 판정이 꺼진다), macOS는
 * epoch 뒤 마이크로초, Windows는 100나노초 FILETIME.
 */
function testStart(): string {
  switch (process.platform) {
    case "linux": {
      const ticks = processStartTicks(process.pid);
      if (ticks === undefined)
        throw new Error(
          "this test process's start could not be read from /proc"
        );
      return String(ticks);
    }
    case "darwin":
      return String(Math.floor(performance.timeOrigin * 1000));
    case "win32":
      // 1601년부터의 100나노초. 2^53을 넘으므로 BigInt로 센다.
      return String(
        (BigInt(Math.floor(performance.timeOrigin)) + 11_644_473_600_000n) *
          10_000n
      );
    default:
      throw new Error(`no start unit is known on ${process.platform}`);
  }
}

// 감독 실행기의 표식 정리 실패를 주입하고, 정리를 청한 표식을 기록한다.
const lease = vi.hoisted(() => ({
  fails: false,
  stopped: [] as unknown[],
  /** 실제 실행기 정리가 성공한(남은 것 없음을 실행기가 확인한) 요청. */
  cleaned: [] as {
    lease?: string;
    recorded?: { pid: number; start: string };
  }[],
  /** 실행기에 청한 정리 요청 전부. */
  requests: [] as { recorded?: unknown }[],
}));
vi.mock("@babojubot/process/recovery", async (original) => {
  const real = await original<typeof import("@babojubot/process/recovery")>();
  return {
    ...real,
    cleanThroughSupervisor: async (
      request: Parameters<typeof real.cleanThroughSupervisor>[0]
    ) => {
      lease.requests.push(request);
      if (request.lease !== undefined) lease.stopped.push(request.lease);
      if (lease.fails) throw new Error("the supervisor's cleanup failed");
      const result = await real.cleanThroughSupervisor(request);
      lease.cleaned.push(request);
      return result;
    },
  };
});

// 복구 기록 하나 때문에 서버가 뜨지 못하면 안 된다. 경고하고 넘어간다.
const folders = testFolders();
// 시험이 띄운 프로그램과 그 정리는 모두 폴더 정리 하나가 맡는다(등록 역순으로 끄고 끝을 확인한 뒤에만 폴더를 지운다). 시험이 직접 띄운
// 대표는 띄운 직후 `ownChild`에 맡겨, Node가 끝을 보기 전에만 신호하고 끝과 출력 닫힘을 확인한다. 대표가 끝난 뒤 그룹에 남는 구성원은
// 연결을 쥐고 돌며, 연결이 열려 있음을 본 직후에만 그 번호로 끈다(`leavingMember`). 거둔 대표의 번호(그룹 번호)로는 신호하지도
// 판정하지도 않는다.
afterEach(() => {
  lease.fails = false;
  lease.stopped = [];
  lease.cleaned = [];
  lease.requests = [];
});
// 대표가 끝난 뒤 그룹에 남는 구성원은 연결을 쥐고 돈다. 구성원이 살아 있는 동안 그룹 번호는 다른 그룹에 쓰이지 않는다.
let lifelines: Lifelines;
beforeAll(async () => {
  lifelines = await openLifelines();
});
afterAll(() => lifelines.close());
let members = 0;
/**
 * 연결을 쥔 구성원 하나를 자기 그룹에 띄우고, 구성원이 연결을 쥐었다고 알린 뒤 끝나는 대표의 문장(`leader`). 구성원의 정리(`end`)는
 * 연결이 열려 있음을 본 직후에만 그 번호로 끄고 연결의 닫힘까지 기다린다(`lifelineHolder`). 폴더 정리에도 맡겨, 시험이 중간에
 * 실패해도 폴더를 지우기 전에 끈다. 이미 끈 구성원에는 다시 신호하지 않는다.
 */
async function leavingMember() {
  const folder = await folders.make("babojubot-member-");
  const name = `member-${++members}`;
  const member = lifelineHolder(
    lifelines,
    name,
    path.join(folder, "pid"),
    'require("node:fs").writeSync(3, "connected\\n");'
  );
  folders.own(member.end, name);
  return {
    name,
    end: member.end,
    leader: `const m = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`${member.code} setInterval(() => {}, 1000);`)}], { stdio: ["ignore", "ignore", "ignore", "pipe"] }); m.stdio[3].once("data", () => process.exit(0));`,
  };
}
/** 대표가 끝나고 연결을 쥔 구성원만 남은 새 세션 그룹. 그룹 번호는 끝난 대표의 번호다. 대표는 띄운 직후 정리에 맡긴다. */
async function leftGroup() {
  const member = await leavingMember();
  const leader = folders.ownChild(
    spawn(process.execPath, ["-e", member.leader], {
      detached: true,
      stdio: "ignore",
    })
  );
  await within(
    once(leader, "close"),
    10_000,
    `group leader ${leader.pid} did not end after its member connected`
  );
  return { group: leader.pid!, name: member.name, end: member.end };
}
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
      start: testStart(),
      group: finished,
      boot: "another-boot",
      lease: "x",
    })
  );
  await expect(recoverProviderProcesses(root)).resolves.toBeUndefined();
  expect(await readdir(directory)).toEqual([]);
});

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
    const left = await leftGroup();
    const { group } = left;
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
    // 끄지 않고 두었다: 남은 구성원의 연결이 열려 있다.
    expect(lifelines.open(left.name)).toBe(true);
    // 끝났음을 확인하지 못했으니 기록을 남겨 다음 시작 때 다시 본다.
    expect(await readdir(directory)).toEqual([`${group}.json`]);
    // 그룹은 시험 중간에 끝내고, 끝난 뒤의 복구를 이어서 본다.
    await left.end();
    // 구성원이 끝나도 거두어질 때까지 그룹은 남는다(좀비). 시험은 그 상태를 알 수단이 없어, 그룹 번호를 보는 대신 복구가 기록을
    // 지울 때까지 상한 안에서 다시 확인한다. 끝내 지우지 않으면 그 상한에서 실패한다.
    await vi.waitFor(
      async () => {
        await recoverProviderProcesses(root);
        expect(await readdir(directory)).toEqual([]);
      },
      { timeout: 10_000, interval: 50 }
    );
  }
);

// /proc가 없는 경로는 프로세스 시작 시각으로 판단하므로 Linux에서도 시험할 수 있다. 다른 OS는 자기 경로를 시험한다.
const withoutProc = process.platform === "linux" ? "darwin" : process.platform;
const longRunning = () =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
/**
 * 시험이 띄운 자식이 끝났는가. Node가 끝을 보기 전에는 거두어지지 않아 그 번호는 아직 그 자식이고, 거두어지기 전의 좀비도 끝난
 * 것으로 본다(`exited`).
 */
const gone = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null || exited(child.pid!);

// 번호가 같아도 시작 시각이 다르면 남이다. 기록의 시작 시각(감독 실행기가 알린 값)과 같은 프로세스만 실행기가 끈다. 시작 시각은 언제
// 물어도 같으므로 여유를 두지 않는다.
it("leaves a process whose start differs from the recorded one", async () => {
  const { root, directory } = await records();
  const child = folders.ownChild(longRunning());
  // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
  await once(child, "spawn");

  await writeFile(
    path.join(directory, `${child.pid}.json`),
    // 다른 시작 시각: 이 시험 프로세스의 것(자식은 그 뒤에 시작했다). 실제 기록처럼 과거의 값이다.
    JSON.stringify({
      pid: child.pid,
      lease: "lease",
      start: testStart(),
    })
  );
  await recoverProviderProcesses(root, { platform: withoutProc });
  expect(gone(child)).toBe(false);
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

// #283 외부 리뷰 2회차 SPEC-3: 초 단위로만 남은 예전 기록(`ps -o lstart`)은 그 정보만으로 신원을 확정하지 않는다. 같은 초 안에 번호가
// 다시 주어진 관계없는 프로그램일 수 있으므로, 그 번호의 프로세스를 정리 요청에 넣지 않고(신호 없음) 기록을 남겨 경고한다.
it.skipIf(process.platform === "win32")(
  "does not take a recorded start kept only to the second as the process's identity",
  async () => {
    const { root, directory } = await records();
    const child = folders.ownChild(longRunning());
    // 띄워졌다(exec가 끝났다)는 신호를 기다린다. 고정 시간으로 기다리지 않는다(#215).
    await once(child, "spawn");
    const file = `${child.pid}.json`;
    // 예전 서버가 남긴 그대로: ps가 초 단위로 알린 시작 시각을 밀리초로.
    const lstart = spawnSync("ps", ["-o", "lstart=", "-p", String(child.pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
    }).stdout;
    await writeFile(
      path.join(directory, file),
      JSON.stringify({
        pid: child.pid,
        lease: crypto.randomUUID(),
        started: Date.parse(lstart.trim()),
      })
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recoverProviderProcesses(root, { platform: withoutProc });
    warn.mockRestore();
    expect(lease.requests.map((request) => request.recorded)).toEqual([
      undefined,
    ]);
    expect(gone(child)).toBe(false);
    expect(await readdir(directory)).toEqual([file]);
  },
  60_000
);

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
  expect(gone(child)).toBe(false);
  expect(await readdir(directory)).toEqual([file]);
}, 30_000);

// 이 시스템의 실제 경로: 기록을 남기면 다음 시작 때 그 프로세스를 찾아 끝낸다.
// 이 시스템의 실제 경로: 감독 실행기 아래 트리를 기록하면(실행기가 알린 시작 시각과 함께) 다음 시작의 복구가 실행기에 정리를 청해
// 그 실행기(기록한 프로세스)와 표식을 가진 프로그램을 끈다. Windows는 실행기를 끄면 그 묶음이 닫혀 트리가 끝난다.
it("stops a process it recorded itself", async () => {
  const { root } = await records();
  const home = path.join(root, "providers/claude");
  const tree = launchTree({
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    stdio: ["ignore", "ignore", "ignore"],
  });
  // 시험이 어디서 끝나든 트리를 끈다(launchTree의 stop()은 끝을 그룹·표식·묶음으로 확인한다). 다만 복구의 실제 실행기 정리가 이
  // 트리의 실행기를 대상으로 성공했으면 부르지 않는다: 밖에서 끝난 실행기에 stop()을 부르면 규약 위반으로 던진다(제품 쪽 후속 후보).
  // 대상은 요청의 기록한 프로세스가 이 트리의 실행기인가(번호와 실행기가 알린 시작 시각), 그리고 Linux·macOS에서는 요청이 이 트리의
  // 표식을 실었는가로 본다. 그 정리의 성공은 실행기가 기록한 실행기와, Linux·macOS에서는 표식을 가진 프로그램(대표 포함)이 남지
  // 않았음을 확인한 것이다. 표식 정리가 없는
  // Windows에서는 실행기를 끄면 묶음이 닫혀 트리가 끝나는 것이 공용 실행의 계약이다(`launchTree`). `tree.exited`는 실행기가 끝나도
  // 이행하므로 대표의 끝의 증거로 쓰지 않는다. 복구가 실패했거나 확인되지 않았으면 stop()이 끝을 확인하고, 그것도 실패하면 폴더(기록
  // 포함)를 남긴다.
  let recoveredBySupervisor = false;
  folders.own(async () => {
    if (!recoveredBySupervisor) await tree.stop();
  }, "the recorded tree");
  expect((await tree.started).kind).toBe("running");
  const file = path.join(home, "processes", `${tree.pid}.json`);
  recordProcess(home, {
    pid: tree.pid!,
    lease: tree.lease,
    supervisorStart: tree.supervisorStart,
  });
  await vi.waitFor(
    async () => expect(await readFile(file, "utf8")).toMatch(/"start"/),
    { timeout: 20_000, interval: 50 }
  );
  const supervisorStart = await tree.supervisorStart;
  await recoverProviderProcesses(root);
  recoveredBySupervisor = lease.cleaned.some(
    (request) =>
      request.recorded?.pid === tree.pid &&
      request.recorded?.start === supervisorStart &&
      // Linux·macOS에서는 표식 정리가 대표를 포함한 프로그램을 끈다. 실행기만 끈 정리로는 트리의 끝이 아니다.
      (process.platform === "win32" || request.lease === tree.lease)
  );
  expect(recoveredBySupervisor).toBe(true);
  expect(await readdir(path.dirname(file))).toEqual([]);
}, 60_000);

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
  expect(gone(child)).toBe(false);
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

it.skipIf(process.platform === "win32")(
  "keeps the record while children outlive their leader on systems without /proc",
  async () => {
    const { root, directory } = await records();
    const left = await leftGroup();
    const { group } = left;
    await writeFile(
      path.join(directory, `${group}.json`),
      JSON.stringify({ pid: group, lease: "lease" })
    );
    await recoverProviderProcesses(root, { platform: withoutProc });
    // 끄지 않고 두었다: 남은 구성원의 연결이 열려 있다.
    expect(lifelines.open(left.name)).toBe(true);
    expect(await readdir(directory)).toEqual([`${group}.json`]);
    // 그룹은 시험 중간에 끝내고, 끝난 뒤의 복구를 이어서 본다.
    await left.end();
    // 구성원이 끝나도 거두어질 때까지 그룹은 남는다(좀비). 시험은 그 상태를 알 수단이 없어, 그룹 번호를 보는 대신 복구가 기록을
    // 지울 때까지 상한 안에서 다시 확인한다. 끝내 지우지 않으면 그 상한에서 실패한다.
    await vi.waitFor(
      async () => {
        await recoverProviderProcesses(root, { platform: withoutProc });
        expect(await readdir(directory)).toEqual([]);
      },
      { timeout: 10_000, interval: 50 }
    );
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
      await within(closed, 10_000, `process ${child.pid} did not close`);
    });
    defer(() => vi.unstubAllEnvs());
    await writeFile(
      path.join(directory, file),
      // 시작 시각은 이 시험의 뜻과 상관없다. 지금 시각으로 두어, 정리를 청받은 실행기가 그 뒤에 생긴 이 컴퓨터의 다른 프로그램을
      // "확인하지 못함"으로 세지 않게 한다(1970년이면 거의 모든 프로그램이 그 뒤에 생겼다).
      JSON.stringify({ pid: child.pid, lease: "lease", started: Date.now() })
    );
    vi.stubEnv("PATH", "");
    await recoverProviderProcesses(root, { platform: withoutProc });
    vi.unstubAllEnvs();
    expect(gone(child)).toBe(false);
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
  // 띄운 직후 정리에 맡긴다: 시험이 실패해도 Node가 끝을 보기 전이면 끄고, 끝과 출력 닫힘을 확인한다.
  folders.ownChild(child);
  const closed = awaitedLater(once(child, "close"));
  await readyLine(child);
  return {
    child,
    closed: () =>
      within(closed, 10_000, `marked program ${child.pid} did not end`),
  };
};
/** 지금 부팅의 식별자. Linux만 기록에 남긴다. */
const currentBoot = async () =>
  process.platform === "linux"
    ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
    : undefined;
async function recordFor(directory: string, pid: number, value: string) {
  await writeFile(
    path.join(directory, `${pid}.json`),
    JSON.stringify({
      pid,
      start: testStart(),
      group: pid,
      boot: await currentBoot(),
      lease: value,
    })
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
    await leftover.closed();
    expect(gone(ignored.child)).toBe(false);
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
    // 구성원은 대표의 표식(환경)을 물려받는다. 대표는 구성원이 연결을 쥔 뒤 끝난다.
    const member = await leavingMember();
    const leader = await marked(value, member.leader);
    await leader.closed();
    const group = leader.child.pid!;
    await recordFor(directory, group, value);
    await recoverProviderProcesses(root, { platform });
    // 남은 구성원이 꺼졌는지는 그 구성원이 쥔 연결의 닫힘으로 본다(거둔 대표의 그룹 번호로 보지 않는다).
    await lifelines.closed(member.name);
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

// 형식이 깨진 기록은 어떤 프로세스도 가리키지 않는다. 그 값으로 프로그램을 찾아 끄지 않고 기록만 지운다.
it.each([
  ["a run marker that is not text", { lease: 5 }],
  ["a leader start that is not text", { start: 5 }],
  ["a boot id that is not text", { boot: 5 }],
  ["a start time that is not a number", { started: "1" }],
])("does not trust a record with %s", async (_shape, broken) => {
  const { root, directory } = await records();
  const finished = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(
    path.join(directory, `${finished}.json`),
    JSON.stringify({
      pid: finished,
      start: testStart(),
      group: finished,
      boot: await currentBoot(),
      lease: crypto.randomUUID(),
      ...broken,
    })
  );
  await recoverProviderProcesses(root);
  expect(lease.stopped).toEqual([]);
  expect(await readdir(directory)).toEqual([]);
});

it.each([
  ["null", null],
  ["a list", [1]],
  ["text", "record"],
])("removes a record that is %s", async (_shape, content) => {
  const { root, directory } = await records();
  const finished = spawnSync(process.execPath, ["-e", ""]).pid;
  await writeFile(
    path.join(directory, `${finished}.json`),
    JSON.stringify(content)
  );
  await recoverProviderProcesses(root);
  expect(lease.stopped).toEqual([]);
  expect(await readdir(directory)).toEqual([]);
});

// 지원하는 예전 형식: /proc가 없는 시스템의 기록에는 시작 시각·부팅 식별자가 없을 수 있고, 표식이 없는 기록도 읽는다.
// Windows는 표식으로 프로그램을 찾아 끄지 않고 감독 실행기의 묶음이 끄므로, 표식 정리를 보는 이 시험을 건너뛴다.
it.skipIf(process.platform === "win32")(
  "still recovers the record shapes it has written before",
  async () => {
    // 시작 시각은 지금 시각으로 둔다(위 시험과 같은 까닭).
    for (const fields of [{}, { started: Date.now() }]) {
      const { root, directory } = await records();
      const finished = spawnSync(process.execPath, ["-e", ""]).pid;
      const value = crypto.randomUUID();
      await writeFile(
        path.join(directory, `${finished}.json`),
        JSON.stringify({ pid: finished, lease: value, ...fields })
      );
      lease.stopped = [];
      await recoverProviderProcesses(root, { platform: withoutProc });
      expect(lease.stopped).toEqual([value]);
      expect(await readdir(directory)).toEqual([]);
    }
    const { root, directory } = await records();
    const finished = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(
      path.join(directory, `${finished}.json`),
      JSON.stringify({ pid: finished })
    );
    lease.stopped = [];
    await recoverProviderProcesses(root, { platform: withoutProc });
    expect(lease.stopped).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  },
  30_000
);

// 정상 기록: 쓰지 않는 필드(프로세스 상태 등)가 더 있어도 그대로 읽는다. Windows는 표식 정리를 하지 않아 건너뛴다.
it.skipIf(process.platform === "win32")(
  "reads a complete record with the fields it does not use",
  async () => {
    const { root, directory } = await records();
    const finished = spawnSync(process.execPath, ["-e", ""]).pid;
    const value = crypto.randomUUID();
    await writeFile(
      path.join(directory, `${finished}.json`),
      JSON.stringify({
        pid: finished,
        start: testStart(),
        group: finished,
        state: "S",
        boot: await currentBoot(),
        lease: value,
      })
    );
    await recoverProviderProcesses(root);
    expect(lease.stopped).toEqual([value]);
    expect(await readdir(directory)).toEqual([]);
  },
  30_000
);

// 시작 시각이 없는 Linux 기록은 대표를 확인할 수 없다. 대표도 그룹도 없으면 남은 것이 없으므로 표식만 정리하고 기록을 지운다.
it.skipIf(process.platform !== "linux")(
  "finishes a Linux record without a leader start once nothing is left",
  async () => {
    const { root, directory } = await records();
    const finished = spawnSync(process.execPath, ["-e", ""]).pid;
    const value = crypto.randomUUID();
    await writeFile(
      path.join(directory, `${finished}.json`),
      JSON.stringify({
        pid: finished,
        boot: await currentBoot(),
        lease: value,
      })
    );
    await recoverProviderProcesses(root);
    expect(lease.stopped).toEqual([value]);
    expect(await readdir(directory)).toEqual([]);
  },
  30_000
);

// 복구 기록을 담는 폴더 자체를 읽지 못해도 서버는 뜬다. 폴더가 없으면 조용히 넘어가고, 그 밖의 이유면 경고하고 넘어간다.
it("stays quiet when there is no provider record folder", async () => {
  const root = await folders.make("babojubot-recovery-");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());

  await recoverProviderProcesses(root);

  expect(warn).not.toHaveBeenCalled();
});

it("warns with the failure code and goes on when the provider record folder cannot be listed", async () => {
  const root = await folders.make("babojubot-recovery-");
  // 목록을 읽을 수 없는 자리: 폴더 자리에 파일이 있다(ENOTDIR). 없음과 다른 오류다.
  await writeFile(path.join(root, "providers"), "");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());

  await recoverProviderProcesses(root);

  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(/process records could not be listed.*\(ENOTDIR\)/)
  );
});

it("warns with the failure code and goes on when one connection's record folder cannot be listed", async () => {
  const root = await folders.make("babojubot-recovery-");
  await mkdir(path.join(root, "providers", "codex"), { recursive: true });
  await writeFile(path.join(root, "providers", "codex", "processes"), "");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());

  await recoverProviderProcesses(root);

  expect(warn).toHaveBeenCalledWith(
    expect.stringMatching(/codex process records.*\(ENOTDIR\)/)
  );
});
