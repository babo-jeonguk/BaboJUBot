import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  launchTree,
  prepareJobObjectLauncher,
  runTree,
  type LaunchedTree,
} from "./launch.ts";
import { openLifelines, type Lifelines } from "./lifeline-support.ts";
import { testFolders } from "./test-folders.ts";

// 공용 실행(#262): 띄운 트리를 stop()이 모두 끄고 확인한다. 실제 프로세스로 보고, 남았는지는 번호가 아니라 각 프로세스가 쥔 연결로
// 본다(#259). Windows는 묶음 실행기를 준비하고 그것 없이는 띄우지 않게(`refuse`) 돌린다.
const windows = process.platform === "win32";
// 묶음 실행기와 시험 스크립트를 둔 폴더는 파일의 모든 시험이 함께 쓴다. 트리는 시험마다 끈 뒤 마지막에 지운다.
const folders = testFolders(afterAll);
let lifelines: Lifelines;
let dataDir = "";
/** 시험이 띄운 트리. 끝마다 모두 끈다. */
const trees: LaunchedTree[] = [];

beforeAll(async () => {
  lifelines = await openLifelines();
  dataDir = await folders.make("babojubot-launch-");
  if (windows)
    expect(await prepareJobObjectLauncher(dataDir)).toMatchObject({ ok: true });
}, 180_000);
// 앞 트리가 끄기에 실패해도 나머지를 끈다. 실패는 모아 알린다.
afterEach(async () => {
  const results = await Promise.allSettled(
    trees.splice(0).map((tree) => tree.stop())
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length)
    throw new AggregateError(failures, "a tree the test started did not stop");
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
    withoutJob: "refuse",
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
    expect(await tree.started).toEqual({ kind: "confined" });
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
      `import { launchTree, prepareJobObjectLauncher } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "launch.ts")).href)};
       await prepareJobObjectLauncher(${JSON.stringify(dataDir)});
       launchTree({
         command: [process.execPath, "-e", ${JSON.stringify(`${lifelines.hold(inner)} ${keep}`)}],
         args: [],
         cwd: process.cwd(),
         env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
         stdio: ["ignore", "ignore", "ignore"],
         withoutJob: "refuse",
       });
       setInterval(() => {}, 1000);`
    );
    const tree = launchTree({
      command: [process.execPath, script],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "ignore", "ignore"],
      withoutJob: "refuse",
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
      withoutJob: "warn",
    });
    trees.push(tree);
    expect((await tree.started).kind).toBe("failed");
    await tree.stop();
  });
});

describe.runIf(windows)("launchTree on Windows", () => {
  // 묶음 실행기를 준비하지 않은 프로세스에서는 묶음 없이 띄우지 않고 이유와 함께 거절한다(작업자 실행기의 쓰임).
  it("refuses to start without the job object launcher", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { launchTree } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "launch.ts")).href)};
         try {
           launchTree({ command: [process.execPath, "-e", ""], args: [], cwd: process.cwd(), env: {}, stdio: "pipe", withoutJob: "refuse" });
           console.log("started");
         } catch (error) {
           console.log(error.name + ": " + error.message);
         }`,
      ],
      { encoding: "utf8", timeout: 60_000 }
    );
    expect(result.stdout).toMatch(
      /^TreeLaunchRefused: the Windows job object launcher was not prepared/
    );
  });
});

describe("runTree", () => {
  const run = (script: string, limitMs = 10_000) =>
    runTree({
      command: [process.execPath, "-e", script],
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      withoutJob: "refuse",
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
