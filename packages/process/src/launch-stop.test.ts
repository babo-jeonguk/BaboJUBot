import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { killUnlessGone } from "./test-cleanup.ts";
import { launchTree, runTree } from "./launch.ts";
import { openLifelines, type Lifelines } from "./lifeline-support.ts";
import { testFolders } from "./test-folders.ts";

// 끄기가 실패하는 길(#263 외부 리뷰 1회차 S2·SP1·SP2). 실제 감독 실행기로는 그룹을 끄지 못한 답, 시작 응답 전에 멈춘 실행기를 만들 수
// 없어, 실행기만 같은 약속으로 답하는 가짜(Node.js 프로그램)로 바꾸고 나머지는 실제 프로세스로 본다(#268).
const fault = vi.hoisted(() => ({
  /** 표식 정리가 아무것도 끄지 않고 대표가 남았다고 답한다. */
  marks: false,
  /** 진짜 감독 실행기 대신 이 Node.js 프로그램을 띄운다. 프로그램은 약속 판과 띄울 명령(JSON), SIGTERM 기록 파일을 인수로 받는다. */
  supervisor: undefined as string | undefined,
  /** 가짜 실행기가 SIGTERM을 받으면 이 파일에 남긴다. */
  termLog: undefined as string | undefined,
}));
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
vi.mock("./supervisor.ts", async (original) => {
  const real = await original<typeof import("./supervisor.ts")>();
  return {
    ...real,
    supervisorLaunch: (...args: Parameters<typeof real.supervisorLaunch>) => {
      if (fault.supervisor === undefined) return real.supervisorLaunch(...args);
      const [command, rest] = args;
      return {
        kind: "launch" as const,
        launch: {
          file: process.execPath,
          args: [
            fault.supervisor,
            String(real.supervisorProtocol),
            JSON.stringify([...command, ...rest]),
            fault.termLog ?? "",
          ],
          options: {},
        },
      };
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
  fault.marks = false;
  fault.supervisor = undefined;
  fault.termLog = undefined;
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

/**
 * 프로그램을 띄우고 시작을 알리지만, 끄기 요청에는 `reply`(기본은 그룹이 끝나지 않았다는 답)로 답하고 아무것도 끄지 않는 가짜 실행기.
 * 프로그램의 끝은 알리지 않는다. 서버가 제어 통로로 준 환경(표식)을 프로그램에 주고, 약속 판 2부터는 `start`를 받은 뒤에 띄운다. 판
 * 3부터는 메시지를 netstring으로 주고받는다. 답한 뒤 `linger`ms 있다가 `code`로 끝난다. SIGTERM을 받으면 기록 파일에 남긴다(관리자인
 * 실행기에 표식 정리가 신호를 보냈는지 본다). Linux·macOS 제어 통로는 넷째 표준 핸들의 소켓이다.
 */
const stubbornSupervisor = (
  linger: number,
  {
    reply = "left: 1 (the process group did not end)",
    code = 1,
  }: { reply?: string; code?: number } = {}
) => `
  const net = require("node:net");
  const fs = require("node:fs");
  const [protocol, commandJson, termLog] = process.argv.slice(2);
  const framed = Number(protocol) >= 3;
  const frame = (text) => framed ? Buffer.byteLength(text) + ":" + text + "," : text + "\\n";
  process.on("SIGTERM", () => { if (termLog) fs.appendFileSync(termLog, "TERM\\n"); });
  const control = new net.Socket({ fd: 3 });
  control.write(frame("babojubot-supervisor " + protocol));
  const env = { ...process.env };
  let started = false;
  const start = () => {
    started = true;
    const [command, ...args] = JSON.parse(commandJson);
    const leader = require("node:child_process").spawn(command, args, { stdio: "ignore", detached: true, env });
    leader.unref();
    control.write(frame("ok " + leader.pid));
  };
  if (Number(protocol) < 2) start();
  let received = Buffer.alloc(0);
  const next = () => {
    if (framed) {
      const colon = received.indexOf(58);
      if (colon < 0) return undefined;
      const length = Number(received.subarray(0, colon).toString());
      if (received.length < colon + length + 2) return undefined;
      const message = received.subarray(colon + 1, colon + 1 + length).toString();
      received = received.subarray(colon + length + 2);
      return message;
    }
    const newline = received.indexOf(10);
    if (newline < 0) return undefined;
    const message = received.subarray(0, newline).toString();
    received = received.subarray(newline + 1);
    return message;
  };
  control.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    for (let message; (message = next()) !== undefined; ) {
      if (message.startsWith("env ")) {
        const pair = message.slice(4);
        env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
      } else if (message === "start" && !started) start();
      else if (message.startsWith("stop"))
        control.write(frame(${JSON.stringify(reply)}), () => setTimeout(() => process.exit(${code}), ${linger}));
    }
  });
  control.on("end", () => process.exit(1));
`;

async function fakeSupervisor(body: string) {
  const folder = await folders.make("babojubot-fake-supervisor-");
  const file = path.join(folder, "supervisor.cjs");
  await writeFile(file, body);
  return file;
}

describe.skipIf(process.platform === "win32")(
  "stopping a tree on Linux and macOS",
  () => {
    // S2: 그룹 끄기(감독 실행기)와 표식 정리는 서로 독립이다. 실행기가 그룹을 끄지 못했다고 답해도 새 세션으로 나간 자손과 대표를
    // 표식으로 끄고, 실패는 알린다.
    it("still stops what carries the marker when the supervisor could not stop the group", async () => {
      const leader = await holder("leader");
      const moved = await holder("moved");
      fault.supervisor = await fakeSupervisor(stubbornSupervisor(0));
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
      await expect(tree.stop()).rejects.toThrow(/process group did not end/);
      await lifelines.closed(moved.name);
      await lifelines.closed(leader.name);
    }, 60_000);

    // #274 외부 리뷰 1회차 STD-1/SPEC-1: 감독 실행기는 트리의 관리자라 실행 시도의 표식을 지니지 않는다. 실행기가 트리의 끝을 확인하지
    // 못했다고 답하고 아직 끝나지 않았어도, 표식 정리는 실행기에 신호를 보내지 않는다(표식 정리는 실행기가 끝난 뒤에 한다).
    it("never signals the supervisor while cleaning up what carries the marker", async () => {
      const leader = await holder("leader");
      const folder = await folders.make("babojubot-launch-stop-term-");
      fault.termLog = path.join(folder, "term");
      fault.supervisor = await fakeSupervisor(stubbornSupervisor(1500));
      const tree = launchTree({
        command: [process.execPath, "-e", leader.script],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "ignore"],
      });
      await lifelines.connected(leader.name);
      await expect(tree.stop()).rejects.toThrow(/process group did not end/);
      await lifelines.closed(leader.name);
      expect(existsSync(fault.termLog)).toBe(false);
    }, 60_000);

    // #274 외부 리뷰 2회차 SPEC-4: 트리가 끝났다는 답(`ended`)은 프로그램의 끝(`exit`)이 온 뒤에만 받는다. 프로그램의 끝 없이 온 답은
    // 약속 위반이라 끄기를 성공으로 보지 않는다.
    it("refuses an end reply that comes without the program's end", async () => {
      const leader = await holder("leader");
      fault.supervisor = await fakeSupervisor(
        stubbornSupervisor(0, { reply: "ended", code: 0 })
      );
      const tree = launchTree({
        command: [process.execPath, "-e", leader.script],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "ignore"],
      });
      await lifelines.connected(leader.name);
      await expect(tree.stop()).rejects.toThrow(/broke the protocol/);
      await lifelines.closed(leader.name);
    }, 60_000);

    // #274 외부 리뷰 2회차 SPEC-4: 실행기가 프로그램의 끝을 알리지 않고 끝나면, 프로그램의 끝은 모르는 것이다. 실행기 자신의 종료
    // 코드를 프로그램의 끝으로 대신 쓰지 않는다.
    it("does not report the supervisor's own exit code as the program's end", async () => {
      const leader = await holder("leader");
      fault.supervisor = await fakeSupervisor(
        stubbornSupervisor(0, { code: 5 })
      );
      const tree = launchTree({
        command: [process.execPath, "-e", leader.script],
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "ignore"],
      });
      await lifelines.connected(leader.name);
      await expect(tree.stop()).rejects.toThrow(/process group did not end/);
      expect(await tree.exited).toEqual({ code: null, signal: null });
      await lifelines.closed(leader.name);
    }, 60_000);

    // SP1: 끄기를 시작한 뒤의 끝은 끄기의 결과로 정한다. 트리가 끝나지 않으면 끄기는 원인과 함께 실패하고, 그 실패로 끝나야 한다.
    // 대표의 끝만 기다리면 끝나지 않는다.
    it("ends a run at its limit with the stop failure when the leader does not end", async () => {
      const leader = await holder("stuck-run");
      fault.supervisor = await fakeSupervisor(stubbornSupervisor(0));
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
      ).rejects.toThrow(/process group did not end|marker/);
    }, 60_000);
  }
);

// SP2: 끄기는 시작 응답을 상한 없이 기다리지 않는다. 시작 응답 전에 멈춘 감독 실행기는 그 프로세스를 끄고 끝을 확인한 뒤, 트리의 끝을
// 확인하지 못했다는 원인과 함께 실패한다. 세 OS가 같은 길이다.
describe("stopping a tree whose supervisor never reports its start", () => {
  it("ends the supervisor and fails with the cause within its limit", async () => {
    const silent = await holder("silent-supervisor");
    fault.supervisor = await fakeSupervisor(silent.script);
    const tree = launchTree({
      command: [process.execPath],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "ignore"],
    });
    await lifelines.connected(silent.name);
    await expect(tree.stop()).rejects.toThrow(/did not report its start/);
    await lifelines.closed(silent.name);
  }, 60_000);
});
