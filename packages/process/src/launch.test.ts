import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { attemptAll } from "@babojubot/contracts";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchTree, runTree, type LaunchedTree } from "./launch.ts";
import { leaseHolders } from "./lease.ts";
import { openLifelines, type Lifelines } from "./lifeline-support.ts";
import { supervisorProtocol } from "./supervisor.ts";
import { killUnlessGone } from "./test-cleanup.ts";
import { testFolders } from "./test-folders.ts";

// 공용 실행(#262): 띄운 트리를 stop()이 모두 끄고 확인한다. 실제 프로세스로 보고, 남았는지는 번호가 아니라 각 프로세스가 쥔 연결로
// 본다(#259). 세 OS 모두 실행 시도마다 감독 실행기로 띄우고(#268), 시험 파일마다 준비한다(launcher-setup-support.ts).
const windows = process.platform === "win32";
const launchModule = JSON.stringify(
  pathToFileURL(path.join(import.meta.dirname, "launch.ts")).href
);
// 시험 스크립트를 둔 폴더는 파일의 모든 시험이 함께 쓴다. 트리는 시험마다 끈 뒤 마지막에 지운다.
const folders = testFolders(afterAll);
let lifelines: Lifelines;
let dataDir = "";
/** 시험이 띄운 트리. 끝마다 모두 끈다. */
const trees: LaunchedTree[] = [];

beforeAll(async () => {
  lifelines = await openLifelines();
  dataDir = await folders.make("babojubot-launch-");
}, 180_000);
// 앞 트리가 끄기에 실패해도 나머지를 끈다. 실패는 모아 알린다.
afterEach(async () => {
  await attemptAll(
    trees.splice(0).map((tree) => () => tree.stop()),
    "a tree the test started did not stop"
  );
}, 60_000);
afterAll(async () => {
  await lifelines.close();
});

const keep = "setInterval(() => {}, 1000);";
const ignoreTerm = 'process.on("SIGTERM", () => {});';
/** 자식 하나를 띄우는 코드. 자식은 연결 `name`을 쥐고 돈다. */
const child = (name: string, options: string, body = "") =>
  `process.getBuiltinModule("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`${lifelines.hold(name)} ${body} ${keep}`)}], ${options});`;
let count = 0;
/** 시험마다 겹치지 않는 연결 이름. */
const unique = (label: string) => `${label}-${++count}`;

function launch(script: string) {
  const tree = launchTree({
    command: [process.execPath, "-e", script],
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    stdio: ["ignore", "ignore", "ignore"],
  });
  trees.push(tree);
  return tree;
}

describe("launchTree", () => {
  it("stops the leader and a child that ignores SIGTERM", async () => {
    const leader = unique("leader");
    const stubborn = unique("stubborn");
    const tree = launch(
      `${lifelines.hold(leader)} ${child(stubborn, '{ stdio: "ignore" }', ignoreTerm)} ${keep}`
    );
    expect(await tree.started).toEqual({ kind: "running" });
    await lifelines.connected(leader);
    await lifelines.connected(stubborn);
    await tree.stop();
    await lifelines.closed(leader);
    await lifelines.closed(stubborn);
  }, 60_000);

  it("stops a child that left for a new session", async () => {
    const leader = unique("leader");
    const moved = unique("moved");
    const tree = launch(
      `${lifelines.hold(leader)} ${child(moved, '{ stdio: "ignore", detached: true }', ignoreTerm)} ${keep}`
    );
    await lifelines.connected(moved);
    await tree.stop();
    await lifelines.closed(leader);
    await lifelines.closed(moved);
  }, 60_000);

  // 대표가 먼저 끝나도 그 자손은 stop()까지 돈다(모든 시스템이 같다). Windows에서 대표가 끝나며 남긴 자손도 stop()이 끈다.
  // Windows의 Node.js는 detached가 아닌 자식을 자기가 끝날 때 함께 끄므로, 대표보다 오래 남는 자식은 detached로 만든다.
  it("keeps what a leader left until stop, then stops it", async () => {
    const left = unique("left");
    const tree = launch(
      `${child(left, '{ stdio: "ignore", detached: true }')} setTimeout(() => process.exit(3), 200);`
    );
    await lifelines.connected(left);
    expect(await tree.exited).toMatchObject({ code: 3 });
    expect(lifelines.open(left)).toBe(true);
    await tree.stop();
    await lifelines.closed(left);
  }, 60_000);

  it("ends only the leader on killLeader, and the rest on stop", async () => {
    const leader = unique("leader");
    const left = unique("left");
    const tree = launch(
      `${lifelines.hold(leader)} ${child(left, '{ stdio: "ignore", detached: true }')} ${keep}`
    );
    await lifelines.connected(leader);
    await lifelines.connected(left);
    tree.killLeader();
    await tree.exited;
    await lifelines.closed(leader);
    expect(lifelines.open(left)).toBe(true);
    await tree.stop();
    await lifelines.closed(left);
  }, 60_000);

  it("leaves other trees running", async () => {
    const ours = unique("ours");
    const theirs = unique("theirs");
    const tree = launch(
      `${child(ours, '{ stdio: "ignore", detached: true }')} ${keep}`
    );
    const other = launch(
      `${child(theirs, '{ stdio: "ignore", detached: true }')} ${keep}`
    );
    await lifelines.connected(ours);
    await lifelines.connected(theirs);
    await tree.stop();
    await lifelines.closed(ours);
    expect(lifelines.open(theirs)).toBe(true);
    await other.stop();
    await lifelines.closed(theirs);
  }, 60_000);

  // 트리 안에서 다시 띄운 트리(작업자가 돌리는 시험 등)가 새 세션·새 묶음으로 나가도, 바깥 트리의 stop()이 닿는다.
  it("stops a tree started inside it", async () => {
    const inner = unique("inner");
    const script = path.join(dataDir, `${inner}.mjs`);
    await writeFile(
      script,
      `import { launchTree, prepareSupervisor } from ${launchModule};
       const supervisor = await prepareSupervisor();
       if (!supervisor.ok) throw new Error(supervisor.reason);
       launchTree({
         command: [process.execPath, "-e", ${JSON.stringify(`${lifelines.hold(inner)} ${keep}`)}],
         args: [],
         cwd: process.cwd(),
         env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
         stdio: ["ignore", "ignore", "ignore"],
       });
       setInterval(() => {}, 1000);`
    );
    const tree = launchTree({
      command: [process.execPath, script],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "ignore", "ignore"],
    });
    trees.push(tree);
    await lifelines.connected(inner, 30_000);
    await tree.stop();
    await lifelines.closed(inner);
  }, 60_000);

  it("reports a program that cannot start, and stops at once", async () => {
    const tree = launchTree({
      command: [path.join(dataDir, "no-such-program")],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "ignore"],
    });
    trees.push(tree);
    // 시작 오류는 Node.js의 spawn과 같은 이름(ENOENT)으로 남는다. 실행기가 띄우지 못한 프로그램도 마찬가지다.
    expect(await tree.started).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ code: "ENOENT" }),
    });
    await tree.stop();
  });

  // 서버가 강제로 끝나면 제어 통로가 끊기고, 감독 실행기가 자기 트리(대표와 같은 그룹의 자손, Windows는 묶음 전체)를 끄고 끝을
  // 확인한다(#268). 다음 시작의 복구에 맡기지 않는다. 새 세션으로 나간 자손의 정리는 아직 서버 쪽 표식 정리가 맡는다.
  // 서버는 이 시험이 띄운 트리의 대표이고, killLeader로 서버만 강제로 끝낸다.
  it("stops the tree when the process that launched it is killed", async () => {
    const leader = unique("leader");
    const stubborn = unique("stubborn");
    const script = path.join(dataDir, `${leader}.mjs`);
    await writeFile(
      script,
      `import { launchTree, prepareSupervisor } from ${launchModule};
       const supervisor = await prepareSupervisor();
       if (!supervisor.ok) throw new Error(supervisor.reason);
       launchTree({
         command: [process.execPath, "-e", ${JSON.stringify(`${lifelines.hold(leader)} ${child(stubborn, '{ stdio: "ignore" }', ignoreTerm)} ${ignoreTerm} ${keep}`)}],
         args: [],
         cwd: process.cwd(),
         env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
         stdio: ["ignore", "ignore", "ignore"],
       });
       setInterval(() => {}, 1000);`
    );
    const server = launchTree({
      command: [process.execPath, script],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "ignore", 2],
    });
    trees.push(server);
    await lifelines.connected(leader, 30_000);
    await lifelines.connected(stubborn);
    server.killLeader();
    await server.exited;
    await lifelines.closed(leader);
    await lifelines.closed(stubborn);
  }, 60_000);

  // 감독 실행기는 트리의 관리자다. 실행 시도의 표식은 실행기가 띄우는 프로그램에만 주고 실행기 자신은 지니지 않는다. 그래야 표식
  // 정리가 트리를 끄는 중인 실행기에 신호를 보내지 않는다(#274 외부 리뷰 1회차 STD-1/SPEC-1). Windows는 표식 정리가 없다.
  it.skipIf(windows)(
    "keeps the run's marker off its supervisor",
    async () => {
      const leader = unique("leader");
      const tree = launch(`${lifelines.hold(leader)} ${keep}`);
      await lifelines.connected(leader);
      const { holders } = await leaseHolders(tree.lease);
      expect(holders.length).toBeGreaterThan(0);
      expect(holders).not.toContain(tree.pid);
    },
    60_000
  );

  // 프로그램이 끝나면 그 출력은 감독 실행기가 살아 있는 동안에도 닫힌다. 실행기는 물려준 표준 입력·출력·오류의 자기 사본을 쥐지 않고,
  // 프로그램에는 표준 핸들만 물려준다(#263에서 Windows 출력이 실행기가 끝날 때까지 닫히지 않던 경우). 닫힘을 시간으로 기다리지 않는다.
  it("closes the output when the program ends, while its supervisor still runs", async () => {
    const tree = launchTree({
      command: [
        process.execPath,
        "-e",
        `process.stdout.write("tail"); process.stderr.write("err");`,
      ],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    trees.push(tree);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    tree.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    tree.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    await Promise.all([
      once(tree.stdout!, "close", { signal: AbortSignal.timeout(10_000) }),
      once(tree.stderr!, "close", { signal: AbortSignal.timeout(10_000) }),
    ]);
    expect(Buffer.concat(out).toString()).toBe("tail");
    expect(Buffer.concat(err).toString()).toBe("err");
    expect(await tree.exited).toMatchObject({ code: 0 });
    await tree.stop();
  }, 60_000);
});

/**
 * 이 시험 프로세스와 따로 돈 Node.js 프로그램(모듈)의 표준 출력 줄. 감독 실행기 준비는 프로세스 전체의 상태라, 준비하지 않았거나 다른
 * 실행기를 준비한 프로세스는 따로 띄워 본다.
 */
function separately(module: string) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", module],
    { encoding: "utf8", timeout: 60_000 }
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split("\n");
}
const tryLaunch = `try {
  launchTree({ command: [process.execPath, "-e", ""], args: [], cwd: process.cwd(), env: {}, stdio: "pipe" });
  console.log("started");
} catch (error) {
  console.log(error.name + ": " + error.message);
}`;

describe("launchTree without a supervisor", () => {
  // 감독 실행기를 준비하지 않은 프로세스에서는 실행기 없이 띄우지 않고 이유와 함께 거절한다(작업자 실행기의 쓰임). Node.js가 직접
  // 띄우는 길은 없다(#268).
  it("refuses to start when no supervisor was prepared", () => {
    expect(
      separately(`import { launchTree } from ${launchModule};
        ${tryLaunch}`)
    ).toEqual([
      "TreeLaunchRefused: 감독 실행기를 준비하지 못해 프로그램을 시작하지 않았습니다. 이유: the supervisor was not prepared in this process (prepareSupervisor)",
    ]);
  });

  // 실행기 파일이 없으면(빌드하지 않음, 설치에서 빠짐) 준비는 던지지 않고 그 이유를 돌려주며, 실행은 그 이유로 거절한다.
  it("names a supervisor program that is not there, and refuses with that reason", () => {
    const missing = path.join(dataDir, "no-such-supervisor");
    const [prepared, launched] = separately(
      `import { launchTree, prepareSupervisor } from ${launchModule};
       console.log(JSON.stringify(await prepareSupervisor({ file: ${JSON.stringify(missing)} })));
       ${tryLaunch}`
    );
    expect(JSON.parse(prepared!)).toEqual({
      ok: false,
      reason: expect.stringContaining(
        `the supervisor program was not found at ${missing}`
      ),
    });
    expect(launched).toMatch(
      /^TreeLaunchRefused: 감독 실행기를 준비하지 못해 프로그램을 시작하지 않았습니다\. 이유: the supervisor program was not found at /
    );
  });

  /** 셸 스크립트로 만든 가짜 실행기. 넷째 핸들(제어 통로)에 쓰고 읽는다. */
  async function fakeSupervisor(name: string, body: string) {
    const file = path.join(dataDir, name);
    await writeFile(file, `#!/bin/sh\n${body}`);
    await chmod(file, 0o755);
    return file;
  }
  const tryPrepare = (file: string) =>
    separately(`import { launchTree, prepareSupervisor } from ${launchModule};
       console.log(JSON.stringify(await prepareSupervisor({ file: ${JSON.stringify(file)} })));`);

  // 준비의 시험 실행은 실제 실행과 같은 약속을 처음부터 끝까지 본다(#274 외부 리뷰 1회차 SPEC-2). 약속 판을 알리고 끝 답을
  // 흉내 내도, 프로그램을 띄웠다는 답(`ok`) 없이 프로그램의 끝을 알리는 파일은 실행기로 쓰지 않는다.
  it.skipIf(windows)(
    "refuses a file that answers like a supervisor but starts nothing",
    async () => {
      const file = await fakeSupervisor(
        "mimic-supervisor",
        `echo "babojubot-supervisor ${supervisorProtocol}" >&3\necho "exit 7" >&3\nwhile read line <&3; do case "$line" in stop*) echo ended >&3; exit 0;; esac; done\n`
      );
      const [prepared] = tryPrepare(file);
      expect(JSON.parse(prepared!)).toEqual({
        ok: false,
        reason: expect.stringContaining("broke the protocol"),
      });
    }
  );

  // 준비의 시험 실행 전체에 시한이 하나 있다(#274 외부 리뷰 1회차 STD-2). 잘못 만든 실행기가 제어 통로를 자손에게 넘기고 끝나 통로가
  // 닫히지 않아도, 준비는 시한 안에 원인과 함께 실패한다.
  it.skipIf(windows)(
    "gives up a trial at its time limit when a child keeps the control channel open",
    async () => {
      const pidFile = path.join(dataDir, "channel-holder-pid");
      folders.own(async () => {
        killUnlessGone(Number(await readFile(pidFile, "utf8")));
      }, "the child that holds the control channel");
      const file = await fakeSupervisor(
        "leaky-supervisor",
        `echo "babojubot-supervisor ${supervisorProtocol}" >&3\nsleep 600 &\necho $! > ${JSON.stringify(pidFile)}\nexit 0\n`
      );
      const [prepared] = tryPrepare(file);
      expect(JSON.parse(prepared!)).toEqual({
        ok: false,
        reason: expect.stringMatching(/within \d+ ms/),
      });
    },
    90_000
  );

  // 다른 판의 실행기(예전에 빌드한 것, 다른 판의 패키지)는 약속이 달라 쓰지 않는다. 실행기가 첫 줄로 알리는 약속 판으로 가린다.
  // 그 판만 알리는 가짜 실행기는 셸 스크립트로 만든다(Windows에는 넷째 핸들에 쓰는 셸 스크립트가 없다).
  it.skipIf(windows)(
    "refuses a supervisor that speaks another protocol",
    async () => {
      const other = path.join(dataDir, "other-supervisor");
      await writeFile(
        other,
        `#!/bin/sh\necho "babojubot-supervisor 99" >&3\nexec cat <&3 >/dev/null\n`
      );
      await chmod(other, 0o755);
      const [prepared, launched] = separately(
        `import { launchTree, prepareSupervisor } from ${launchModule};
         console.log(JSON.stringify(await prepareSupervisor({ file: ${JSON.stringify(other)} })));
         ${tryLaunch}`
      );
      expect(JSON.parse(prepared!)).toEqual({
        ok: false,
        reason: expect.stringContaining("speaks protocol 99"),
      });
      expect(launched).toMatch(/speaks protocol 99/);
    }
  );
});

describe("runTree", () => {
  const run = (script: string, limitMs = 10_000) =>
    runTree({
      command: [process.execPath, "-e", script],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      limitMs,
      maxOutputBytes: 1024,
      overflow: "stop",
    });

  it("returns the output and exit code, and stops what the program left", async () => {
    const left = unique("left");
    const result = await run(
      `${child(left, '{ stdio: "ignore" }')} setTimeout(() => { process.stdout.write("done"); process.exit(4); }, 200);`
    );
    expect(result).toMatchObject({ started: true, code: 4 });
    expect(result.started && result.stdout.toString()).toBe("done");
    await lifelines.closed(left);
  }, 60_000);

  it("stops the tree at its limit", async () => {
    const leader = unique("leader");
    const stubborn = unique("stubborn");
    const result = await run(
      `${lifelines.hold(leader)} ${child(stubborn, '{ stdio: "ignore", detached: true }', ignoreTerm)} ${ignoreTerm} ${keep}`,
      2_000
    );
    expect(result).toMatchObject({ started: true, stopped: "limit" });
    await lifelines.closed(leader);
    await lifelines.closed(stubborn);
  }, 60_000);

  it("stops the tree when the output goes over its limit", async () => {
    const result = await run(`process.stdout.write("x".repeat(4096)); ${keep}`);
    expect(result).toMatchObject({ started: true, stopped: "output" });
    expect(result.started && result.stdout.length).toBe(1024);
  }, 60_000);
});
