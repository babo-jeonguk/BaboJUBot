// 저장소 lint 설정(eslint.config.js)이 개발 스크립트에 제품 규칙을 걸고, 제품 코드·스크립트의 실패 경로에 정리 연쇄 규칙을 거는지 본다.
// 범위에 오타가 나면 아무것도 잡지 않은 채 lint가 통과하므로, 잡아야 할 모양과 잡지 말아야 할 모양을 짧은 코드로 넣어 확인한다.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const eslint = new ESLint({ cwd: repository });

/** `filePath` 자리에 둔 `code`의 lint 결과 중 `rules`의 메시지. 파일은 만들지 않는다. */
async function lint(code, filePath, rules) {
  const [result] = await eslint.lintText(code, { filePath });
  const fatal = result.messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], `${filePath}: parsing failed`);
  return result.messages.filter((m) => rules.includes(m.ruleId));
}

// 스크립트는 타입 정보로 검사하므로(scripts/tsconfig.json에 든 파일만) 있는 파일 자리를 빌린다.
const scriptPlaces = [
  "scripts/provider-live.mjs",
  "scripts/live/chaos-run.mjs",
  // agent가 직접 읽고 돌리는 도구 스크립트도 같은 규칙을 받는다.
  ".agents/scripts/run-worker.mjs",
  ".agents/skills/reference-first/scripts/mock-llm.mjs",
];
// 시험 파일, 시험이 부르는 가짜 프로그램, 일부러 실패하는 시험 묶음은 스크립트 규칙을 받지 않는다.
const scriptTestPlaces = [
  "scripts/gh-post.test.mjs",
  "scripts/test-fixtures/stuck-run.mjs",
  "scripts/fixtures/test-exit-code/broken-setup.mjs",
  ".agents/scripts/check-worker-change.test.mjs",
];

const scriptRules = {
  "@typescript-eslint/no-floating-promises": {
    reported: `import { readFile } from "node:fs/promises";\nreadFile("x");\n`,
    kept: `import { readFile } from "node:fs/promises";\nawait readFile("x");\n`,
  },
  "@typescript-eslint/no-misused-promises": {
    reported: `const work = async () => 1;\n[1].forEach(async () => {\n  await work();\n});\n`,
    kept: `const work = async () => 1;\nfor (const _ of [1]) await work();\n`,
  },
  "@typescript-eslint/no-deprecated": {
    reported: `import { parse } from "node:url";\nparse("http://x");\n`,
    kept: `new URL("http://x");\n`,
  },
  "product/sync-command-timeout": {
    reported: `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"]);\n`,
    kept: `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"], { timeout: 10_000, killSignal: "SIGKILL" });\n`,
  },
  "product/no-ignored-error": {
    reported: `try {\n  JSON.parse("x");\n} catch {\n  console.log("not JSON");\n}\n`,
    kept: `try {\n  JSON.parse("x");\n} catch (error) {\n  if (!(error instanceof SyntaxError)) throw error;\n}\n`,
  },
  eqeqeq: {
    reported: `export const same = (a, b) => a == b;\n`,
    kept: `export const same = (a, b) => a === b;\nexport const none = (a) => a == null;\n`,
  },
};

test("development scripts get the product rules", async () => {
  for (const place of scriptPlaces)
    for (const [rule, { reported, kept }] of Object.entries(scriptRules)) {
      const [message, ...rest] = await lint(reported, place, [rule]);
      assert.ok(message, `${place}: ${rule} not reported`);
      assert.deepEqual(rest, [], `${place}: ${rule}`);
      assert.deepEqual(
        await lint(kept, place, [rule]),
        [],
        `${place}: ${kept}`
      );
    }
  // 시험 쪽은 스크립트 규칙을 받지 않는다. Promise 규칙은 시험 규칙이 시험 파일에도 건다(scripts/lint-rules.test.mjs).
  const testPromiseRules = new Set([
    "@typescript-eslint/no-floating-promises",
    "@typescript-eslint/no-misused-promises",
  ]);
  for (const place of scriptTestPlaces)
    for (const [rule, { reported }] of Object.entries(scriptRules)) {
      const expected =
        testPromiseRules.has(rule) && place.endsWith(".test.mjs") ? 1 : 0;
      assert.equal(
        (await lint(reported, place, [rule])).length,
        expected,
        `${place}: ${rule}`
      );
    }
});

const chainRule = ["product/no-cleanup-chain"];
// 정리 연쇄 규칙은 제품 코드와 스크립트에 건다. 시험 코드는 시험 전용 정리 규칙이 본다.
const chainPlaces = [
  "apps/server/src/app.ts",
  "packages/runtime/src/providers/claude.ts",
  ...scriptPlaces,
];
const chainTestPlaces = [
  "packages/db/src/client.test.ts",
  "packages/process/src/test-cleanup.ts",
  ...scriptTestPlaces,
];

const chains = {
  "awaited cleanups in a finally": `export async function run(server, db) {\n  try {\n    await server.listen();\n  } finally {\n    await server.close();\n    await db.close();\n  }\n}\n`,
  "awaited cleanups in a catch": `export async function run(server, db) {\n  try {\n    await server.listen();\n  } catch (error) {\n    await server.close();\n    await db.close();\n    throw error;\n  }\n}\n`,
  "an optional cleanup followed by a folder removal": `import { rm } from "node:fs/promises";\nexport async function run(server, dir) {\n  try {\n    await server?.listen();\n  } finally {\n    await server?.close();\n    await rm(dir, { recursive: true, force: true });\n  }\n}\n`,
  "a cleanup followed by any other wait": `export async function run(service, events) {\n  try {\n    await service.start();\n  } finally {\n    await service.close();\n    await events;\n  }\n}\n`,
  "cleanups awaited in a loop": `export async function run(work, cleanups) {\n  try {\n    await work();\n  } finally {\n    for (const cleanup of cleanups) await cleanup();\n  }\n}\n`,
  "sync cleanups one after another": `import { closeSync, rmSync } from "node:fs";\nexport async function run(fd, dir) {\n  try {\n    await fd.sync();\n  } finally {\n    closeSync(fd);\n    rmSync(dir, { recursive: true, force: true });\n  }\n}\n`,
  "a sync cleanup before an awaited one": `import { rmSync } from "node:fs";\nexport async function run(server, dir) {\n  try {\n    await server.listen();\n  } catch (error) {\n    rmSync(dir, { recursive: true, force: true });\n    await server.close();\n    throw error;\n  }\n}\n`,
  "an awaited cleanup before a sync one": `import { rmSync } from "node:fs";\nexport async function run(server, dir) {\n  try {\n    await server.listen();\n  } finally {\n    await server.close();\n    rmSync(dir, { recursive: true, force: true });\n  }\n}\n`,
  "process.kill in a loop": `export async function run(work, pids) {\n  try {\n    await work();\n  } finally {\n    for (const pid of pids) process.kill(pid, "SIGKILL");\n  }\n}\n`,
};
const caughtChains = {
  "two cleanups in one try": `export async function run(server, db, report) {\n  try {\n    await server.listen();\n  } finally {\n    try {\n      await server.close();\n      await db.close();\n    } catch (error) {\n      report(error);\n    }\n  }\n}\n`,
  "two sync cleanups in one try": `import { closeSync, rmSync } from "node:fs";\nexport async function run(fd, dir, report) {\n  try {\n    await fd.sync();\n  } finally {\n    try {\n      closeSync(fd);\n      rmSync(dir, { force: true });\n    } catch (error) {\n      report(error);\n    }\n  }\n}\n`,
};
const keptChains = [
  // 정리마다 실패를 받는다.
  `export async function run(server, db, report) {\n  try {\n    await server.listen();\n  } finally {\n    await server.close().catch(report);\n    await db.close().catch(report);\n  }\n}\n`,
  `export async function run(server, db, failures) {\n  try {\n    await server.listen();\n  } finally {\n    try {\n      await server.close();\n    } catch (error) {\n      failures.push(error);\n    }\n    try {\n      await db.close();\n    } catch (error) {\n      failures.push(error);\n    }\n  }\n}\n`,
  // 정리 하나뿐이다.
  `export async function run(server) {\n  try {\n    await server.listen();\n  } finally {\n    await server.close();\n  }\n}\n`,
  // 던지지 않는 정리를 함께 시작해 한 번 기다린다.
  `export async function run(work, removeAttemptFolder, a, b) {\n  try {\n    await work();\n  } finally {\n    await Promise.all([removeAttemptFolder(a), removeAttemptFolder(b)]);\n  }\n}\n`,
  // 프로그램을 끈 뒤 그 폴더를 지운다(앞 단계가 끝나야 안전한 단계).
  `export async function run(child, dir, killProgram, removeFolder) {\n  try {\n    await child.done;\n  } finally {\n    await killProgram(child);\n    await removeFolder(dir);\n  }\n}\n`,
  // 서로 다른 갈래의 정리.
  `export async function run(a, b) {\n  try {\n    await a.listen();\n  } finally {\n    if (a.open) await a.close();\n    else await b.close();\n  }\n}\n`,
  // 순서를 이름으로 드러낸 한 단계.
  `export async function run(service, closeServiceThenDrainEvents) {\n  try {\n    await service.start();\n  } finally {\n    await closeServiceThenDrainEvents();\n  }\n}\n`,
  // 실패 경로가 아닌 곳의 차례 정리는 이 규칙이 보지 않는다.
  `export async function shutdown(server, db) {\n  await server.close();\n  await db.close();\n}\n`,
  // 동기 정리 하나뿐이다(연쇄가 아니다).
  `import { closeSync } from "node:fs";\nexport async function run(fd) {\n  try {\n    await fd.sync();\n  } finally {\n    closeSync(fd);\n  }\n}\n`,
  // 동기 정리마다 실패를 받는다.
  `import { closeSync, rmSync } from "node:fs";\nexport async function run(fd, dir, report) {\n  try {\n    await fd.sync();\n  } finally {\n    try {\n      closeSync(fd);\n    } catch (error) {\n      report(error);\n    }\n    rmSync(dir, { force: true });\n  }\n}\n`,
  // 이름 붙은 함수 안의 동기 정리는 블록의 연쇄가 아니다.
  `import { closeSync, rmSync } from "node:fs";\nexport async function run(fd, dir, continueAfterFailure, report) {\n  try {\n    await fd.sync();\n  } finally {\n    continueAfterFailure(() => closeSync(fd), report);\n    rmSync(dir, { force: true });\n  }\n}\n`,
];

test("cleanup chains in finally and catch blocks are reported in product code and scripts", async () => {
  for (const place of chainPlaces) {
    for (const [shape, code] of Object.entries({
      ...chains,
      ...caughtChains,
    })) {
      const [message, ...rest] = await lint(code, place, chainRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 무엇이 남는지와 쓸 수단·작성 기준을 알려 준다.
      assert.match(
        message.message,
        shape in caughtChains ? /한 try…catch/ : /차례로 기다리거나/
      );
      assert.match(message.message, /AggregateError/);
      assert.match(message.message, /withCleanup/);
      assert.match(message.message, /Promise\.all/);
      assert.match(message.message, /continueAfterFailure/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
    for (const code of keptChains)
      assert.deepEqual(
        await lint(code, place, chainRule),
        [],
        `${place}: ${code}`
      );
  }
  for (const place of chainTestPlaces)
    for (const code of Object.values(chains))
      assert.deepEqual(
        await lint(code, place, chainRule),
        [],
        `${place}: ${code}`
      );
});

const groupRule = ["product/no-process-group-signal"];
const groupSignals = {
  "process.kill on a negative pid": `export function stop(group) {\n  process.kill(-group, "SIGTERM");\n}\n`,
  "killUnlessGone on a negative pid": `export function stop(killUnlessGone, group) {\n  return killUnlessGone(-group, "SIGKILL");\n}\n`,
  "processAlive on a negative pid": `export function alive(processAlive, group) {\n  return processAlive(-group);\n}\n`,
};
const keptGroupCalls = [
  // 프로세스 하나에 보내는 신호와 자식 객체의 kill.
  `export function alive(pid) {\n  process.kill(pid, 0);\n}\n`,
  `export function stop(child) {\n  child.kill("SIGTERM");\n}\n`,
  // 그룹 끄기는 띄울 때 받은 트리의 끄기로.
  `export async function stop(tree) {\n  await tree.stop();\n}\n`,
];

test("signalling a process group is left to the product's process group stop", async () => {
  for (const place of chainPlaces) {
    for (const [shape, code] of Object.entries(groupSignals)) {
      const [message, ...rest] = await lint(code, place, groupRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 이유와 대안을 알려 준다.
      assert.match(message.message, /launchTree/);
      assert.match(message.message, /group\.ts/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
    for (const code of keptGroupCalls)
      assert.deepEqual(
        await lint(code, place, groupRule),
        [],
        `${place}: ${code}`
      );
  }
  // 그 함수를 둔 파일과 시험 코드는 범위 밖이다.
  for (const place of ["packages/process/src/group.ts", ...chainTestPlaces])
    for (const code of Object.values(groupSignals))
      assert.deepEqual(
        await lint(code, place, groupRule),
        [],
        `${place}: ${code}`
      );
});

const launchRule = ["product/no-direct-launch"];
// 오래 도는 자식을 직접 띄우는 모양. 이름 그대로·바꿔 가져오기, 모듈 객체, 다시 내보내기, import 밖에서 불러오기.
const directLaunches = {
  "spawn imported by name": `import { spawn } from "node:child_process";\nspawn("x", []);\n`,
  "execFile renamed": `import { execFile as run } from "child_process";\nrun("x", [], () => {});\n`,
  "fork imported by name": `import { fork } from "node:child_process";\nfork("x.js");\n`,
  "exec imported by name": `import { exec } from "node:child_process";\nexec("x", () => {});\n`,
  "spawn from a namespace": `import * as cp from "node:child_process";\ncp.spawn("x", []);\n`,
  "execFile from the default import": `import cp from "node:child_process";\ncp.execFile("x", [], () => {});\n`,
  "a computed name on the module": `import * as cp from "node:child_process";\nconst name = "spawn";\ncp[name]("x", []);\n`,
  "cross-spawn called": `import spawn from "cross-spawn";\nspawn("x", []);\n`,
  "cross-spawn spawn": `import crossSpawn from "cross-spawn";\ncrossSpawn.spawn("x", []);\n`,
  "spawn re-exported": `export { spawn } from "node:child_process";\n`,
  "child_process re-exported whole": `export * from "node:child_process";\n`,
  "child_process imported at run time": `const cp = await import("node:child_process");\nvoid cp;\n`,
  "child_process from require": `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nrequire("child_process");\n`,
  "child_process from getBuiltinModule": `process.getBuiltinModule("node:child_process");\n`,
};
// 막지 않는 모양: 상한을 둔 동기 실행, cross-spawn의 동기 실행, 타입만 가져오기, 공용 실행.
const keptLaunches = [
  `import { execFileSync, spawnSync } from "node:child_process";\nexecFileSync("x", [], { timeout: 1000, killSignal: "SIGKILL" });\nspawnSync("x", [], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  `import crossSpawn from "cross-spawn";\ncrossSpawn.sync("x", [], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  `import type { ChildProcess } from "node:child_process";\nexport type Child = ChildProcess;\n`,
  `import { launchTree } from "@babojubot/process";\nconst tree = launchTree({ command: ["x"], args: [], cwd: ".", env: {}, stdio: "pipe" });\nawait tree.stop();\n`,
];
const launchPlaces = [
  "apps/server/src/app.ts",
  "packages/db/src/client.ts",
  "packages/runtime/src/providers/claude.ts",
  // 프로세스 패키지 안에서도 실행 소유 파일 밖은 공용 실행으로 띄운다.
  "packages/process/src/lease.ts",
  ...scriptPlaces,
];

test("long-running children are launched only through the shared launch", async () => {
  for (const place of launchPlaces) {
    for (const [shape, code] of Object.entries(directLaunches)) {
      if (place.endsWith(".mjs") && shape.includes("type")) continue;
      const messages = await lint(code, place, launchRule);
      assert.ok(messages.length > 0, `${place}: ${shape} not reported`);
      // 이유와 대안(공용 실행과 그 끄기, 동기 실행, 실행 소유 목록)을 알려 준다.
      assert.match(messages[0].message, /launchTree/);
      assert.match(messages[0].message, /@babojubot\/process/);
      assert.match(messages[0].message, /stop\(\)/);
      assert.match(messages[0].message, /launchOwners/);
      assert.match(messages[0].message, /CODING_STANDARDS\.md#제품-코드/);
    }
    for (const code of keptLaunches) {
      if (place.endsWith(".mjs") && code.includes("import type")) continue;
      assert.deepEqual(
        await lint(code, place, launchRule),
        [],
        `${place}: ${code}`
      );
    }
  }
  // 실행 소유 파일(공용 실행과 그것이 서는 실행, 데몬을 띄우는 pg_ctl)과 시험 코드는 범위 밖이다.
  for (const place of [
    "packages/process/src/launch.ts",
    "packages/process/src/job-object.ts",
    "packages/process/src/bounded-command.ts",
    "packages/runtime/src/providers/container.ts",
    "packages/db/src/embedded.ts",
    ...chainTestPlaces,
  ])
    for (const code of Object.values(directLaunches).filter(
      (code) => !code.includes("getBuiltinModule")
    ))
      assert.deepEqual(
        await lint(code, place, launchRule),
        [],
        `${place}: ${code}`
      );
});

const halfRule = ["product/no-group-stop-import"];
// 프로세스 패키지 밖(runtime의 재시작 복구 제외)에서 그룹 끄기의 반쪽을 가져오는 모양. 어느 경로에서 가져와도 이름으로 본다.
const outsideHalves = {
  "stopProcessGroup from the package entry": [
    ".agents/scripts/run-worker.mjs",
    `import { stopProcessGroup } from "@babojubot/process";\nawait stopProcessGroup(1);\n`,
  ],
  "stopProcessGroup from the recovery entry": [
    "apps/server/src/app.ts",
    `import { stopProcessGroup } from "@babojubot/process/recovery";\nawait stopProcessGroup(1);\n`,
  ],
  "interruptProcessGroup in runtime": [
    "packages/runtime/src/providers/process.ts",
    `import { interruptProcessGroup } from "@babojubot/process/recovery";\ninterruptProcessGroup(1);\n`,
  ],
  "stopProcessGroup re-exported by runtime": [
    "packages/runtime/src/index.ts",
    `export { stopProcessGroup } from "@babojubot/process/recovery";\n`,
  ],
};
// 프로세스 패키지 안에서 공용 실행과 복구 입구 밖이 그룹 끄기를 가져오는 모양.
const insideHalves = {
  "stopProcessGroup in lease.ts": [
    "packages/process/src/lease.ts",
    `import { stopProcessGroup } from "./group.ts";\nexport const stop = (pid: number) => stopProcessGroup(pid);\n`,
  ],
  "interruptProcessGroup re-exported by the entry": [
    "packages/process/src/index.ts",
    `export { interruptProcessGroup } from "./group.ts";\n`,
  ],
  "everything from group.ts re-exported": [
    "packages/process/src/index.ts",
    `export * from "./group.ts";\n`,
  ],
};

test("the process group stop stays inside the shared launch and the restart recovery", async () => {
  for (const [shape, [place, code]] of Object.entries({
    ...outsideHalves,
    ...insideHalves,
  })) {
    const [message, ...rest] = await lint(code, place, halfRule);
    assert.ok(message, `${place}: ${shape} not reported`);
    assert.deepEqual(rest, [], `${place}: ${shape}`);
    // 이유와 대안(띄울 때 받은 끄기)을 알려 준다.
    assert.match(message.message, /launchTree/);
    assert.match(message.message, /stop\(\)/);
    assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
  }
  // 막지 않는 모양: 공용 실행과 복구 입구, runtime의 재시작 복구, 그룹 끄기가 아닌 함수, 시험 코드.
  const kept = [
    [
      "packages/process/src/launch.ts",
      `import { interruptProcessGroup, stopProcessGroup } from "./group.ts";\nvoid [interruptProcessGroup, stopProcessGroup];\n`,
    ],
    [
      "packages/process/src/recovery.ts",
      `export { groupAlive, stopProcessGroup } from "./group.ts";\n`,
    ],
    [
      "packages/process/src/index.ts",
      `export { launchTree, runTree } from "./launch.ts";\n`,
    ],
    [
      "packages/runtime/src/providers/recovery.ts",
      `import { groupAlive, stopProcessGroup } from "@babojubot/process/recovery";\nvoid [groupAlive, stopProcessGroup];\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { recoverProviderProcesses } from "@babojubot/runtime";\nawait recoverProviderProcesses(".");\n`,
    ],
    [
      ".agents/scripts/run-worker.mjs",
      `import { launchTree } from "@babojubot/process";\nvoid launchTree;\n`,
    ],
    [
      "packages/runtime/src/providers/recovery.test.ts",
      `import { stopProcessGroup } from "@babojubot/process/recovery";\nvoid stopProcessGroup;\n`,
    ],
  ];
  for (const [place, code] of kept)
    assert.deepEqual(
      await lint(code, place, halfRule),
      [],
      `${place}: ${code}`
    );
});

const boundedRule = ["product/bounded-command"];
// 실행 소유 파일에서 Node.js의 시한에 끝을 맡기는 비동기 실행(#262).
const softCommands = {
  "an async execFile": `import { execFile } from "node:child_process";\nexecFile("ps", [], { timeout: 1000 }, () => {});\n`,
  "an async exec": `import { exec } from "node:child_process";\nexec("ps", () => {});\n`,
  "execFile from a namespace": `import * as cp from "node:child_process";\ncp.execFile("ps", [], () => {});\n`,
  "a spawn with a timeout": `import { spawn } from "node:child_process";\nspawn("csc", [], { stdio: "ignore", timeout: 1000 });\n`,
  "a renamed spawn with a timeout": `import { spawn as run } from "node:child_process";\nrun("csc", [], { timeout: 1000 });\n`,
};
// 막지 않는 모양: timeout 없는 spawn(끝은 boundChild가 맡음), 시한에 강제 종료하는 동기 실행, 짧은 명령 실행 함수.
const boundedCommands = [
  `import { spawn } from "node:child_process";\nspawn("csc", [], { stdio: "ignore" });\n`,
  `import { execFileSync } from "node:child_process";\nexecFileSync("ps", [], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  `import { runCommand } from "./bounded-command.ts";\nawait runCommand("ps", [], { limitMs: 1000, maxOutputBytes: 1024 });\n`,
];

test("launch owners end short commands at their time limit", async () => {
  for (const place of [
    "packages/process/src/job-object.ts",
    "packages/runtime/src/providers/recovery.ts",
    "packages/db/src/embedded.ts",
  ]) {
    for (const [shape, code] of Object.entries(softCommands)) {
      const [message, ...rest] = await lint(code, place, boundedRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, /SIGKILL/);
      assert.match(message.message, /bounded-command/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
    for (const code of boundedCommands)
      assert.deepEqual(
        await lint(code, place, boundedRule),
        [],
        `${place}: ${code}`
      );
  }
  // 실행 소유 파일 밖은 직접 띄우기 규칙(product/no-direct-launch)이 막고, 시험 코드는 범위 밖이다.
  for (const place of ["apps/server/src/app.ts", ...chainTestPlaces])
    for (const code of Object.values(softCommands))
      assert.deepEqual(
        await lint(code, place, boundedRule),
        [],
        `${place}: ${code}`
      );
});

const scopeRule = ["product/package-import-scope"];

// 다른 영역은 runtime·프로세스 패키지의 안쪽 파일이나 목록에 없는 입구를 가져오지 않는다(#266). db는 runtime에 기대지 않고,
// 그룹 끄기·표식 정리 입구(@babojubot/process/recovery)는 runtime의 재시작 복구만 쓴다. 제품 코드는 시험 도움 입구를 가져오지 않는다.
test("other modules reach runtime and the process package only through their listed entry points", async () => {
  const refused = [
    [
      "packages/db/src/client.ts",
      `import { createConnection } from "@babojubot/runtime";\nvoid createConnection;\n`,
    ],
    // 옮기기 전의 runtime 하위 경로.
    [
      "packages/db/src/client.ts",
      `import { runCommand } from "@babojubot/runtime/bounded-command";\nvoid runCommand;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { recordProcess } from "../../runtime/src/providers/recovery.ts";\nvoid recordProcess;\n`,
    ],
    [
      "packages/db/src/client.test.ts",
      `import { removeFolder } from "@babojubot/runtime/remove-folder";\nvoid removeFolder;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { withCleanup } from "@babojubot/process/test-cleanup";\nvoid withCleanup;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { launchTree } from "../../process/src/launch.ts";\nvoid launchTree;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { stopLeaseHolders } from "@babojubot/process/recovery";\nvoid stopLeaseHolders;\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `import { sharedVariables } from "../../packages/runtime/src/providers/process.ts";\nvoid sharedVariables;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { openLifelines } from "@babojubot/runtime/lifelines";\nvoid openLifelines;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { launchTree } from "../packages/process/src/launch.ts";\nvoid launchTree;\n`,
    ],
    [
      ".agents/scripts/run-worker.mjs",
      `export { removeFolder } from "@babojubot/runtime/remove-folder";\n`,
    ],
    [
      ".agents/scripts/run-worker.mjs",
      `import { holdsLease } from "@babojubot/process/recovery";\nvoid holdsLease;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `const recovery = await import("@babojubot/process/recovery");\nvoid recovery;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { testFolders } from "@babojubot/process/testing";\nvoid testFolders;\n`,
    ],
    [
      "packages/runtime/src/providers/process.ts",
      `import { holdsLease } from "@babojubot/process/recovery";\nvoid holdsLease;\n`,
    ],
    [
      "packages/runtime/src/providers/process.ts",
      `import { stopLeaseHolders } from "../../../process/src/lease.ts";\nvoid stopLeaseHolders;\n`,
    ],
  ];
  for (const [place, code] of refused) {
    const [message, ...rest] = await lint(code, place, scopeRule);
    assert.ok(message, `${place}: ${code} not reported`);
    assert.deepEqual(rest, [], `${place}: ${code}`);
    // 이유와 대안(새 패키지의 입구), 구조 문서를 알려 준다.
    assert.match(message.message, /@babojubot\/process/);
    assert.match(message.message, /launchTree/);
    assert.match(message.message, /docs\/architecture\.md/);
  }
  const kept = [
    [
      "packages/db/src/embedded.ts",
      `import { runCommand } from "@babojubot/process";\nvoid runCommand;\n`,
    ],
    [
      "packages/db/src/client.test.ts",
      `import { removeFolder } from "@babojubot/process/remove-folder";\nimport { withCleanup } from "@babojubot/process/test-cleanup";\nimport { testFolders } from "@babojubot/process/testing";\nvoid [removeFolder, withCleanup, testFolders];\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `import { sharedVariables } from "@babojubot/runtime";\nimport { launchTree, runCommand } from "@babojubot/process";\nimport { withCleanup } from "@babojubot/process/test-cleanup";\nvoid [sharedVariables, launchTree, runCommand, withCleanup];\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { createConnection } from "../packages/runtime/src/index.ts";\nvoid createConnection;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { prepareJobObjectLauncher } from "@babojubot/process";\nimport { recoverProviderProcesses } from "@babojubot/runtime";\nvoid [prepareJobObjectLauncher, recoverProviderProcesses];\n`,
    ],
    [
      "packages/runtime/src/providers/attempt-folder.ts",
      `import { removeFolder } from "@babojubot/process/remove-folder";\nvoid removeFolder;\n`,
    ],
    [
      "packages/runtime/src/providers/recovery.ts",
      `import { holdsLease, stopProcessGroup } from "@babojubot/process/recovery";\nvoid [holdsLease, stopProcessGroup];\n`,
    ],
    // 프로세스 패키지 자신과 db 밖의 시험 코드는 범위 밖이다.
    [
      "packages/process/src/index.ts",
      `export { launchTree } from "./launch.ts";\n`,
    ],
    [
      "packages/runtime/src/providers/recovery.test.ts",
      `import { leaseVariable } from "@babojubot/process/recovery";\nvoid leaseVariable;\n`,
    ],
    [
      "scripts/gh-post.test.mjs",
      `import { openLifelines } from "@babojubot/process/lifelines";\nvoid openLifelines;\n`,
    ],
  ];
  for (const [place, code] of kept)
    assert.deepEqual(
      await lint(code, place, scopeRule),
      [],
      `${place}: ${code}`
    );
});

const collectingRule = ["product/no-failure-collecting"];

test("failures are collected only through attemptAll, attemptEach and combinedFailure", async () => {
  const collected = {
    "a loop that pushes caught errors": `export async function run(steps) {\n  const failures = [];\n  for (const step of steps)\n    try {\n      await step();\n    } catch (error) {\n      failures.push(error);\n    }\n  return failures;\n}\n`,
    "a helper that pushes a caught error": `const failures = [];\nexport const attempt = async (step) => {\n  try {\n    await step();\n  } catch (problem) {\n    failures.push(problem);\n  }\n};\n`,
    "a .catch handler that pushes": `const failures = [];\nexport const close = (db) => db.close().catch((closing) => failures.push(closing));\n`,
    "a .then rejection handler that pushes": `const failures = [];\nexport const close = (db) => db.close().then(() => true, (closing) => { failures.push(closing); return false; });\n`,
    // #263 외부 리뷰 2회차 S3: 감싼 오류와 다른 넣기 방법·별칭.
    "a wrapped error with the cause": `export async function remove(folder, failures) {\n  try {\n    await folder.remove();\n  } catch (error) {\n    failures.push(new Error(\`could not remove \${folder.path}\`, { cause: error }));\n  }\n}\n`,
    "the error inside an object": `export async function run(step, results) {\n  try {\n    await step();\n  } catch (error) {\n    results.push({ step: "x", error });\n  }\n}\n`,
    "the error inside an array": `export async function run(step, results) {\n  try {\n    await step();\n  } catch (error) {\n    results.push(["x", error]);\n  }\n}\n`,
    "the error inside a template": `export async function run(step, lines) {\n  try {\n    await step();\n  } catch (error) {\n    lines.push(\`step failed: \${error}\`);\n  }\n}\n`,
    unshift: `export async function run(step, failures) {\n  try {\n    await step();\n  } catch (error) {\n    failures.unshift(error);\n  }\n}\n`,
    splice: `export async function run(step, failures) {\n  try {\n    await step();\n  } catch (error) {\n    failures.splice(0, 0, error);\n  }\n}\n`,
    "an index assignment": `export async function run(step, failures) {\n  try {\n    await step();\n  } catch (error) {\n    failures[failures.length] = error;\n  }\n}\n`,
    "an alias of the error": `export async function run(step, failures) {\n  try {\n    await step();\n  } catch (error) {\n    const wrapped = new Error("step failed", { cause: error });\n    const again = wrapped;\n    failures.push(again);\n  }\n}\n`,
    "a .catch handler that pushes a wrapped error": `const failures = [];\nexport const close = (db) => db.close().catch((closing) => failures.push(new Error("close", { cause: closing })));\n`,
    // #263 3회차: 배열이 아닌 곳, 이름 붙은 처리기, continueAfterFailure의 처리기.
    "a Map of caught errors": `export function settle(pids, lookups, look) {\n  for (const pid of pids)\n    try {\n      look(pid);\n    } catch (error) {\n      lookups.set(pid, error);\n    }\n}\n`,
    "a Set of caught errors": `export async function run(steps, seen) {\n  for (const step of steps)\n    try {\n      await step();\n    } catch (error) {\n      seen.add(error);\n    }\n}\n`,
    "a named handler passed to .catch": `export async function close(server, db) {\n  const failures = [];\n  const keep = (error) => failures.push(error);\n  await server.close().catch(keep);\n  await db.close().catch(keep);\n  return failures;\n}\n`,
    "a named handler passed as a rejection": `export async function close(db) {\n  const failures = [];\n  function keep(error) {\n    failures.push(new Error("close", { cause: error }));\n  }\n  await db.close().then(undefined, keep);\n  return failures;\n}\n`,
    "a named handler called in catch": `const failures = [];\nconst keep = (problem) => {\n  failures.push(problem);\n};\nexport async function run(step) {\n  try {\n    await step();\n  } catch (error) {\n    keep(error);\n  }\n}\n`,
    "a continueAfterFailure report that pushes": `import { continueAfterFailure } from "@babojubot/contracts";\nexport function stop(pids, kill, failures) {\n  for (const pid of pids)\n    continueAfterFailure(\n      () => kill(pid),\n      (error) => failures.push(error)\n    );\n}\n`,
    // 실패 처리 자리 여럿에서 같은 바깥 변수를 바꿔 실패를 표시·셈·이어 붙이기(apps/server/test/clock-server.ts, apps/server/src/shutdown.ts,
    // packages/runtime/src/providers/process.ts, scripts/live/chaos-run.mjs).
    "a flag set by a named handler": `export function stop(startup) {\n  let failed = false;\n  const fail = (error) => {\n    failed = true;\n    console.error("shutdown failed", error);\n  };\n  return (async () => {\n    const started = await startup.catch(fail);\n    await started?.server.close().catch(fail);\n    await started?.db.close().catch(fail);\n    return failed;\n  })();\n}\n`,
    "a flag set by inline handlers": `export async function close(server, db, report) {\n  let failed = false;\n  await server.close().catch((error) => {\n    failed = true;\n    report(error);\n  });\n  await db.close().catch((error) => {\n    failed = true;\n    report(error);\n  });\n  return !failed;\n}\n`,
    "a flag set in catch clauses": `export async function finish(relay, tree) {\n  let broken = false;\n  try {\n    await relay.close();\n  } catch (error) {\n    broken = true;\n    console.error(error);\n  }\n  try {\n    await tree.stop();\n  } catch (error) {\n    broken = true;\n    console.error(error);\n  }\n  return broken;\n}\n`,
    "a counter of failures": `import { continueAfterFailure } from "@babojubot/contracts";\nexport async function clean(server, pids, kill) {\n  const cleanup = { problems: 0 };\n  try {\n    await server.dispose();\n  } catch (error) {\n    cleanup.problems++;\n    console.error(error);\n  }\n  for (const pid of pids)\n    continueAfterFailure(\n      () => kill(pid),\n      (error) => {\n        cleanup.problems += 1;\n        console.error(error);\n      }\n    );\n  return cleanup;\n}\n`,
    // 본문 실패와 정리 실패를 직접 묶기(packages/db/src/testing.ts, scripts/boot-check.test.mjs).
    "an AggregateError built by hand": `export async function open(start, stop) {\n  try {\n    return await start();\n  } catch (error) {\n    await stop().catch((stopping) => {\n      throw new AggregateError([error, stopping], "did not start and stopping failed");\n    });\n    throw error;\n  }\n}\n`,
    "an AggregateError of kept failures": `export async function run(body, cleanUp) {\n  let failure;\n  try {\n    await body();\n  } catch (error) {\n    failure = error;\n  }\n  const problems = await cleanUp();\n  if (problems.length > 0)\n    throw AggregateError(failure ? [failure, ...problems] : problems, "cleanup failed");\n  if (failure) throw failure;\n}\n`,
    "text joined from failures": `export function check(a, b) {\n  let report = "";\n  try {\n    a();\n  } catch (error) {\n    report += \`a: \${error}\`;\n  }\n  try {\n    b();\n  } catch (error) {\n    report += \`b: \${error}\`;\n  }\n  return report;\n}\n`,
  };
  const places = [
    "apps/server/src/app.ts",
    "packages/runtime/src/providers/claude.ts",
    "scripts/live/chaos-run.mjs",
    "packages/runtime/src/providers/process.test.ts",
    "apps/server/test/support.ts",
  ];
  for (const place of places)
    for (const [shape, code] of Object.entries(collected)) {
      const [message, ...rest] = await lint(code, place, collectingRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, /attemptAll/);
      assert.match(message.message, /combinedFailure/);
    }
  const kept = [
    // 공용 도구로 모으기.
    `import { attemptAll, attemptEach, combinedFailure } from "@babojubot/contracts";\nexport async function run(steps, error) {\n  await attemptAll(steps, "x");\n  const failures = await attemptEach(steps);\n  throw combinedFailure([error, ...failures], "y");\n}\n`,
    // 오류를 모으지 않는 catch, 오류가 아닌 값을 넣는 처리기.
    `export function read(text, seen) {\n  try {\n    return JSON.parse(text);\n  } catch (error) {\n    seen.push(text);\n    throw error;\n  }\n}\n`,
    `export const watch = (hub, events) => hub.subscribe((event) => events.push(event));\n`,
    // 문맥을 더한 오류를 그 단계 안에서 던지고, 모으기는 attemptEach가 한다.
    `import { attemptEach } from "@babojubot/contracts";\nexport const remove = (folder) => attemptEach([async () => {\n  try {\n    await folder.remove();\n  } catch (error) {\n    throw new Error("could not remove", { cause: error });\n  }\n}]);\n`,
    // 결과표는 성공과 실패를 같은 값으로 만들어 한 곳에서 기록한다.
    `export async function scene(body, results) {\n  results.push(await body().then((outcome) => outcome, (error) => ({ failed: String(error) })));\n}\n`,
    // 받은 오류와 상관없는 값을 넣는다.
    `export async function run(step, attempts) {\n  try {\n    await step();\n  } catch (error) {\n    attempts.push("failed");\n    throw error;\n  }\n}\n`,
    // 한 실패의 결과를 값으로 기록한다(한 자리에서 갈래마다 대입).
    `export async function scene(run) {\n  let outcome;\n  let reason;\n  try {\n    outcome = await run();\n  } catch (error) {\n    if (error instanceof RangeError) {\n      outcome = "not_run";\n      reason = error.message;\n    } else {\n      outcome = "failed";\n      reason = String(error);\n    }\n  }\n  return { outcome, reason };\n}\n`,
    // 기록하고 다시 던진다. 실패는 이어지지 않으므로 모으지 않는다.
    `export async function open(resume, start) {\n  let sessionError;\n  try {\n    await resume();\n  } catch (error) {\n    if (error instanceof RangeError) {\n      sessionError = error.message;\n      throw error;\n    }\n  }\n  try {\n    await start();\n  } catch (error) {\n    if (error instanceof RangeError) sessionError = error.message;\n    throw error;\n  }\n  return sessionError;\n}\n`,
    // 끝남(성공·실패 모두)을 표시하는 처리기. 실패 자리는 하나다.
    `export function watch(answer) {\n  let settled = false;\n  const done = () => {\n    settled = true;\n  };\n  answer.then(done, done);\n  return () => settled;\n}\n`,
    // 실패를 값 하나로 남기는 처리기를 여러 자리에 넘긴다(바깥 변수를 바꾸지 않는다).
    `export async function after(effects, report) {\n  const failed = (error) => report("effect failed", error);\n  for (const effect of effects) await effect().catch(failed);\n}\n`,
    // 정리 단계는 attemptEach로 돌리고 실패 목록으로 판단한다.
    `import { attemptEach } from "@babojubot/contracts";\nexport async function close(server, db, report) {\n  const failures = await attemptEach([() => server.close(), () => db.close()]);\n  for (const failure of failures) report(failure);\n  return failures.length === 0;\n}\n`,
  ];
  for (const place of places)
    for (const code of kept)
      assert.deepEqual(
        await lint(code, place, collectingRule),
        [],
        `${place}: ${code}`
      );
  // 공용 도구를 둔 파일은 범위 밖이다.
  assert.deepEqual(
    await lint(
      Object.values(collected)[0],
      "packages/contracts/src/failure.ts",
      collectingRule
    ),
    []
  );
});
