import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { killUnlessGone } from "../test-cleanup.ts";
import { launchTree, runTree } from "./launch.ts";
import { openLifelines, type Lifelines } from "./lifeline-support.ts";
import { startProcess } from "./process.ts";
import { testFolders } from "./test-folders.ts";

// 끄기가 실패하는 길(#263 외부 리뷰 1회차 S2·SP1·SP2). 실제 프로세스로는 그룹 끄기 실패, SIGKILL 뒤에도 끝나지 않는 대표,
// 시작 응답 전에 멈춘 묶음 실행기를 만들 수 없어, 그 부분만 대역으로 바꾸고 나머지는 실제 프로세스로 본다.
const fault = vi.hoisted(() => ({
  /** 그룹 끄기가 끝을 확인하지 못하고 던진다. */
  group: false,
  /** 표식 정리가 아무것도 끄지 않고 대표가 남았다고 답한다. */
  marks: false,
  /** Windows 묶음 실행기 대신 시작 응답을 쓰지 않고 멈춘 프로그램을 띄운다. */
  silentLauncher: undefined as string | undefined,
}));
vi.mock("./recovery.ts", async (original) => {
  const real = await original<typeof import("./recovery.ts")>();
  return {
    ...real,
    stopProcessGroup: async (
      ...args: Parameters<typeof real.stopProcessGroup>
    ) => {
      if (fault.group) throw new Error("Process group did not stop");
      return real.stopProcessGroup(...args);
    },
  };
});
vi.mock("./lease.ts", async (original) => {
  const real = await original<typeof import("./lease.ts")>();
  return {
    ...real,
    stopLeaseHolders: async (
      ...args: Parameters<typeof real.stopLeaseHolders>
    ) =>
      fault.marks
        ? { stopped: [], left: [4242] }
        : real.stopLeaseHolders(...args),
  };
});
vi.mock("./job-object.ts", async (original) => {
  const real = await original<typeof import("./job-object.ts")>();
  return {
    ...real,
    jobObjectLaunch: (...args: Parameters<typeof real.jobObjectLaunch>) =>
      fault.silentLauncher === undefined
        ? real.jobObjectLaunch(...args)
        : {
            kind: "launch" as const,
            launch: {
              file: process.execPath,
              args: ["-e", fault.silentLauncher],
              options: {
                argv0: process.execPath,
                windowsVerbatimArguments: false,
              },
            },
          },
  };
});

const folders = testFolders();
let lifelines: Lifelines;
beforeAll(async () => {
  lifelines = await openLifelines();
});
afterAll(async () => {
  await lifelines.close();
});
afterEach(() => {
  fault.group = false;
  fault.marks = false;
  fault.silentLauncher = undefined;
});
let count = 0;
const unique = (label: string) => `${label}-${++count}`;
const keep = "setInterval(() => {}, 1000);";

/**
 * 연결을 쥐고 자기 번호를 파일에 남기는 프로그램. 대역 때문에 시험이 끄지 못한 프로그램은 정리가 그 번호로 끈다. 연결이 열려 있으면
 * 그 번호의 프로세스는 아직 그 프로그램이다.
 */
async function holder(label: string, body = keep) {
  const name = unique(label);
  const folder = await folders.make("babojubot-launch-stop-");
  const pidFile = path.join(folder, "pid");
  folders.own(async () => {
    if (lifelines.names().includes(name) && lifelines.open(name))
      killUnlessGone(Number(await readFile(pidFile, "utf8")));
    await lifelines.closed(name);
  }, name);
  return {
    name,
    script: `${lifelines.hold(name, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`)} ${body}`,
  };
}

describe.skipIf(process.platform === "win32")(
  "stopping a tree on Linux and macOS",
  () => {
    // S2: 그룹 끄기와 표식 정리는 서로 독립이다. 그룹 끄기가 실패해도 새 세션으로 나간 자손을 표식으로 끄고, 실패는 알린다.
    it("still stops what carries the marker when the group stop fails", async () => {
      const leader = await holder("leader");
      const moved = await holder("moved");
      fault.group = true;
      const tree = launchTree({
        command: [
          process.execPath,
          "-e",
          `${leader.script} require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(moved.script)}], { stdio: "ignore", detached: true });`,
        ],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "ignore"],
      });
      await lifelines.connected(leader.name);
      await lifelines.connected(moved.name);
      await expect(tree.stop()).rejects.toThrow(/process group/);
      await lifelines.closed(moved.name);
      await lifelines.closed(leader.name);
    }, 60_000);

    // SP1: 끄기를 시작한 뒤의 끝은 끄기의 결과로 정한다. 대표가 SIGKILL 뒤에도 끝나지 않으면 끄기는 상한 뒤 원인과 함께 실패하고,
    // 그 실패로 끝나야 한다. 대표의 끝만 기다리면 끝나지 않는다.
    it("ends a run at its limit with the stop failure when the leader does not end", async () => {
      const leader = await holder("stuck-run");
      fault.group = true;
      fault.marks = true;
      await expect(
        runTree({
          command: [process.execPath, "-e", leader.script],
          args: [],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH },
          limitMs: 500,
          maxOutputBytes: 1024,
          overflow: "stop",
        })
      ).rejects.toThrow(/process group|marker/);
    }, 60_000);

    it("ends an attempt as broken when its stop fails and the leader does not end", async () => {
      const leader = await holder("stuck-attempt");
      fault.group = true;
      fault.marks = true;
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => error.mockRestore());
      const attempt = startProcess({
        // 입력이 닫혀도 끝나지 않는다.
        command: [
          process.execPath,
          "-e",
          `process.stdin.resume(); ${leader.script}`,
        ],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        onFrame: async () => {},
      });
      await lifelines.connected(leader.name);
      attempt.end();
      const exit = await attempt.done;
      expect(exit.broken).toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("could not all be stopped")
      );
    }, 60_000);
  }
);

// SP2: 끄기는 시작 응답을 상한 없이 기다리지 않는다. 시작 응답 전에 멈춘 묶음 실행기는 그 프로세스를 끄고 끝을 확인한 뒤, 묶음의 끝을
// 확인하지 못했다는 원인과 함께 실패한다. Windows 길을 대역 실행기(시작 응답을 쓰지 않는 Node 프로그램)로 본다.
describe("stopping a tree whose launcher never reports its start", () => {
  it("ends the launcher and fails with the cause within its limit", async () => {
    const launcher = await holder("silent-launcher");
    fault.silentLauncher = launcher.script;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    let tree: ReturnType<typeof launchTree>;
    try {
      tree = launchTree({
        command: [process.execPath],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "ignore"],
      });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    await lifelines.connected(launcher.name);
    Object.defineProperty(process, "platform", { value: "win32" });
    onTestFinished(() => {
      Object.defineProperty(process, "platform", platform);
    });
    await expect(tree.stop()).rejects.toThrow(/did not report its start/);
    await lifelines.closed(launcher.name);
  }, 60_000);
});
