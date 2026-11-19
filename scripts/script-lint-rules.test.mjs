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
  "packages/runtime/src/test-cleanup.ts",
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
      assert.match(message.message, /recovery\.ts/);
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
  for (const place of [
    "packages/runtime/src/providers/recovery.ts",
    ...chainTestPlaces,
  ])
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
  `import { launchTree } from "@babojubot/runtime/launch";\nconst tree = launchTree({ command: ["x"], args: [], cwd: ".", env: {}, stdio: "pipe" });\nawait tree.stop();\n`,
];
const launchPlaces = [
  "apps/server/src/app.ts",
  "packages/db/src/client.ts",
  "packages/runtime/src/providers/claude.ts",
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
    "packages/runtime/src/providers/launch.ts",
    "packages/runtime/src/providers/lease.ts",
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
// runtime 밖에서 그룹 끄기의 반쪽이나 recovery.ts를 가져오는 모양.
const outsideHalves = {
  "recovery.ts by a relative path": [
    "scripts/live/chaos-run.mjs",
    `import { recoverProviderProcesses } from "../../packages/runtime/src/providers/recovery.ts";\nawait recoverProviderProcesses(".");\n`,
  ],
  "stopProcessGroup from the runtime package": [
    ".agents/scripts/run-worker.mjs",
    `import { stopProcessGroup } from "@babojubot/runtime";\nawait stopProcessGroup(1);\n`,
  ],
  "a runtime subpath that opens recovery": [
    "apps/server/src/app.ts",
    `import { stopProcessGroup } from "@babojubot/runtime/recovery";\nawait stopProcessGroup(1);\n`,
  ],
  "recovery.ts imported at run time": [
    "scripts/live/chaos-run.mjs",
    `const recovery = await import("../../packages/runtime/src/providers/recovery.ts");\nvoid recovery;\n`,
  ],
};
// runtime 안에서 공용 실행·복구 밖이 그룹 끄기를 가져오는 모양.
const insideHalves = {
  "stopProcessGroup in process.ts": `import { stopProcessGroup } from "./recovery.ts";\nexport const stop = (pid: number) => stopProcessGroup(pid);\n`,
  "interruptProcessGroup re-exported": `export { interruptProcessGroup } from "./recovery.ts";\n`,
  "everything from recovery re-exported": `export * from "./recovery.ts";\n`,
};

test("the process group stop stays inside the shared launch and the restart recovery", async () => {
  for (const [shape, [place, code]] of Object.entries(outsideHalves)) {
    const [message, ...rest] = await lint(code, place, halfRule);
    assert.ok(message, `${place}: ${shape} not reported`);
    assert.deepEqual(rest, [], `${place}: ${shape}`);
    assert.match(message.message, /launchTree/);
    assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
  }
  for (const [shape, code] of Object.entries(insideHalves)) {
    const place = "packages/runtime/src/providers/process.ts";
    const [message, ...rest] = await lint(code, place, halfRule);
    assert.ok(message, `${place}: ${shape} not reported`);
    assert.deepEqual(rest, [], `${place}: ${shape}`);
    assert.match(message.message, /stop\(\)/);
  }
  // 막지 않는 모양: runtime 밖의 재시작 복구와 공용 실행, runtime 안의 다른 recovery 함수, 공용 실행·복구 자신과 시험 코드.
  const kept = [
    [
      "apps/server/src/app.ts",
      `import { recoverProviderProcesses } from "@babojubot/runtime";\nawait recoverProviderProcesses(".");\n`,
    ],
    [
      ".agents/scripts/run-worker.mjs",
      `import { launchTree } from "@babojubot/runtime/launch";\nvoid launchTree;\n`,
    ],
    [
      "packages/runtime/src/providers/process.ts",
      `import { recordProcess } from "./recovery.ts";\nvoid recordProcess;\n`,
    ],
    [
      "packages/runtime/src/index.ts",
      `export { recoverProviderProcesses } from "./providers/recovery.ts";\n`,
    ],
    [
      "packages/runtime/src/providers/launch.ts",
      insideHalves["stopProcessGroup in process.ts"],
    ],
    [
      "packages/runtime/src/providers/recovery.test.ts",
      insideHalves["stopProcessGroup in process.ts"],
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
    "packages/runtime/src/providers/lease.ts",
    "packages/runtime/src/providers/job-object.ts",
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

const scopeRule = ["product/runtime-import-scope"];

test("db and development scripts reach runtime only through the listed entry points", async () => {
  const refused = [
    // db는 pg_ctl 실행 말고는 runtime에 기대지 않는다.
    [
      "packages/db/src/client.ts",
      `import { launchTree } from "@babojubot/runtime/launch";\nvoid launchTree;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { createConnection } from "@babojubot/runtime";\nvoid createConnection;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { recordProcess } from "../../runtime/src/providers/recovery.ts";\nvoid recordProcess;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `const runtime = await import("@babojubot/runtime/testing");\nvoid runtime;\n`,
    ],
    // 스크립트는 runtime 내부 파일과 목록에 없는 하위 경로를 가져오지 않는다.
    [
      "scripts/live/chaos-run.mjs",
      `import { sharedVariables } from "../../packages/runtime/src/providers/process.ts";\nvoid sharedVariables;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { openLifelines } from "@babojubot/runtime/lifelines";\nvoid openLifelines;\n`,
    ],
    [
      ".agents/scripts/run-worker.mjs",
      `export { removeFolder } from "@babojubot/runtime/remove-folder";\n`,
    ],
  ];
  for (const [place, code] of refused) {
    const [message, ...rest] = await lint(code, place, scopeRule);
    assert.ok(message, `${place}: ${code} not reported`);
    assert.deepEqual(rest, [], `${place}: ${code}`);
    // 이유와 대안, 옮길 곳을 알려 준다.
    assert.match(message.message, /@babojubot\/runtime\/launch/);
    assert.match(message.message, /@babojubot\/process/);
  }
  const kept = [
    [
      "packages/db/src/embedded.ts",
      `import { runCommand } from "@babojubot/runtime/bounded-command";\nvoid runCommand;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { createConnection } from "../packages/runtime/src/index.ts";\nvoid createConnection;\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `import { sharedVariables } from "@babojubot/runtime";\nimport { launchTree } from "@babojubot/runtime/launch";\nimport { runCommand } from "@babojubot/runtime/bounded-command";\nimport { withCleanup } from "@babojubot/runtime/test-cleanup";\nvoid [sharedVariables, launchTree, runCommand, withCleanup];\n`,
    ],
    // 시험 코드와 runtime 자신은 범위 밖이다.
    [
      "scripts/gh-post.test.mjs",
      `import { openLifelines } from "@babojubot/runtime/lifelines";\nvoid openLifelines;\n`,
    ],
    [
      "packages/db/src/client.test.ts",
      `import { removeFolder } from "@babojubot/runtime/remove-folder";\nvoid removeFolder;\n`,
    ],
    [
      "packages/runtime/src/providers/claude.ts",
      `import { recordProcess } from "./recovery.ts";\nvoid recordProcess;\n`,
    ],
  ];
  for (const [place, code] of kept)
    assert.deepEqual(
      await lint(code, place, scopeRule),
      [],
      `${place}: ${code}`
    );
});
