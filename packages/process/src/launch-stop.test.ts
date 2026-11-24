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
import { reportedPid } from "./test-support.ts";

// 끄기가 실패하는 길(#263 외부 리뷰 1회차 S2·SP1·SP2). 실제 감독 실행기로는 그룹을 끄지 못한 답, 시작 응답 전에 멈춘 실행기를 만들 수
// 없어, 실행기만 같은 약속으로 답하는 가짜(Node.js 프로그램)로 바꾸고 나머지는 실제 프로세스로 본다(#268).
const fault = vi.hoisted(() => ({
  /** 진짜 감독 실행기 대신 이 Node.js 프로그램을 띄운다. 프로그램은 약속 판과 띄울 명령(JSON), SIGTERM 기록 파일을 인수로 받는다. */
  supervisor: undefined as string | undefined,
  /** 가짜 실행기가 SIGTERM을 받으면 이 파일에 남긴다. */
  termLog: undefined as string | undefined,
}));
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
  fault.supervisor = undefined;
  fault.termLog = undefined;
});
let count = 0;
const unique = (label: string) => `${label}-${++count}`;
const keep = "setInterval(() => {}, 1000);";

/**
 * 자기 번호를 파일에 남긴 뒤 연결을 쥐는 프로그램(#286: 번호를 먼저 남겨, 연결이 보이면 정리가 그 번호를 읽을 수 있다. 연결 뒤에
 * 남기면 그 사이 시험이 끝날 때 정리가 아직 없는 파일을 읽었다). 대역 때문에 시험이 끄지 못한 프로그램은 정리가 그 번호로 끈다. 연결이 열려 있으면
 * 그 번호의 프로세스는 아직 그 프로그램이다.
 */
async function holder(label: string, body = keep) {
  const name = unique(label);
  const folder = await folders.make("babojubot-launch-stop-");
  const pidFile = path.join(folder, "pid");
  folders.own(async () => {
    // 연결은 시험의 이벤트 루프가 처리한 뒤에야 보이므로 먼저 기다린다(오지 않으면 그 이유로 실패). 열려 있음을 본 직후에만 끈다.
    await lifelines.connected(name);
    if (lifelines.open(name))
      killUnlessGone(
        reportedPid(await readFile(pidFile, "utf8"), `the pid file of ${name}`)
      );
    await lifelines.closed(name);
  }, name);
  return {
    name,
    script: `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${lifelines.hold(name)} ${body}`,
  };
}

/**
 * 프로그램을 띄우고 시작을 알리지만, 끄기 요청에는 `reply`(기본은 그룹이 끝나지 않았다는 답)로 답하고 아무것도 끄지 않는 가짜 실행기.
 * 프로그램의 끝은 알리지 않는다. 서버가 제어 통로로 준 환경(표식)을 프로그램에 주고, 약속 판 2부터는 `start`를 받은 뒤에 띄운다. 판
 * 3부터는 메시지를 netstring으로 주고받는다(판 4의 `marker`는 무시한다). 답한 뒤 `linger`ms 있다가 `code`로 끝난다. SIGTERM을 받으면
 * 기록 파일에 남긴다(서버가 관리자인 실행기에 TERM을 보냈는지 본다). Linux·macOS 제어 통로는 넷째 표준 핸들의 소켓이다.
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
  control.write(frame("babojubot-supervisor " + protocol + (framed ? " -" : "")));
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
    // #268 PR 2: 표식으로 찾아 끄는 일은 실행기 안에서 한다(신호는 표식을 확인한 바로 그 프로세스에만). 실행기가 트리를 끄지 못했다고
    // 답하면 서버는 그 실패로 끝내고, 번호로 따로 찾아 신호하지 않는다. 남은 것은 기록에 남아 다음 시작의 복구가 실행기로 정리한다.
    it("fails with the supervisor's answer and signals nothing by number itself", async () => {
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
      // 진단은 문구가 아니라 원인 코드와 실행기의 답(그대로)으로 남는다(#286, failureCode).
      await expect(tree.stop()).rejects.toMatchObject({
        name: "TreeStopFailure",
        code: "TREE_LEFT",
        left: "1 (the process group did not end)",
        message: expect.stringMatching(/process group did not end/),
      });
      expect(lifelines.open(moved.name)).toBe(true);
      expect(lifelines.open(leader.name)).toBe(true);
    }, 60_000);

    // #274 외부 리뷰 1회차 STD-1/SPEC-1: 감독 실행기는 트리의 관리자다. 실행기가 트리의 끝을 확인하지 못했다고 답하고 아직 끝나지
    // 않았어도, 서버의 끄기는 실행기에 TERM을 보내지 않는다(실행기의 끝을 기다리고, 상한을 넘기면 강제로 끝낸다). 표식 정리는
    // 실행기 안에서 하고 실행기 자신은 표식을 지니지 않는다(#268 PR 2).
    it("never signals the supervisor with SIGTERM while it answers the stop", async () => {
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
      await expect(tree.stop()).rejects.toMatchObject({
        name: "TreeStopFailure",
        code: "TREE_END_UNCONFIRMED",
        protocolFailure: expect.stringContaining("broke the protocol"),
        message: expect.stringMatching(/broke the protocol/),
      });
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
    }, 60_000);

    // SP1: 끄기를 시작한 뒤의 끝은 끄기의 결과로 정한다. 트리가 끝나지 않으면 끄기는 원인과 함께 실패하고, 그 실패로 끝나야 한다.
    // 대표의 끝만 기다리면 끝나지 않는다.
    it("ends a run at its limit with the stop failure when the leader does not end", async () => {
      const leader = await holder("stuck-run");
      fault.supervisor = await fakeSupervisor(stubbornSupervisor(0));
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
      ).rejects.toMatchObject({
        code: "TREE_LEFT",
        message: expect.stringMatching(/process group did not end/),
      });
    }, 60_000);
  }
);

// Linux의 감독 실행기는 트리의 고아를 거두는 부모(subreaper)다. 그룹을 끈 뒤 새 세션으로 나간 자손도 자기 자식이 되므로 직접 끄고
// 끝까지 확인한다. 거두지 않은 자식이라 그 번호는 다른 프로세스에 가지 않는다. macOS에는 subreaper가 없어 실행기의 표식 정리가 맡는다.
describe.runIf(process.platform === "linux")("stopping a tree on Linux", () => {
  it("ends what left for a new session through the supervisor alone", async () => {
    const leader = await holder("leader");
    const moved = await holder(
      "moved",
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`
    );
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
    await tree.stop();
    await lifelines.closed(leader.name);
    await lifelines.closed(moved.name);
  }, 60_000);
});

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
