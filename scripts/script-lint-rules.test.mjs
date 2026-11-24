// 저장소 lint 설정(eslint.config.js)이 개발 스크립트에 제품 규칙을 걸고, 제품 코드·스크립트의 실패 경로에 정리 연쇄 규칙을 거는지 본다.
// 범위에 오타가 나면 아무것도 잡지 않은 채 lint가 통과하므로, 잡아야 할 모양과 잡지 말아야 할 모양을 짧은 코드로 넣어 확인한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { accessShapes } from "./lint-access-shapes.mjs";
import { ruleLinter } from "./lint-rule-testing.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
/** `filePath` 자리에 둔 `code`의 lint 결과 중 `rules`의 메시지. 파일은 만들지 않는다. */
const lint = ruleLinter(repository);

// 스크립트는 타입 정보로 검사하므로(scripts/tsconfig.json에 든 파일만) 있는 파일 자리를 빌린다.
const scriptPlaces = [
  "scripts/provider-live.mjs",
  "scripts/live/chaos-run.mjs",
  // agent가 직접 읽고 돌리는 도구 스크립트도 같은 규칙을 받는다.
  ".agents/scripts/run-worker.ts",
  ".agents/skills/reference-first/scripts/mock-llm.ts",
];
// 시험 파일, 시험이 부르는 가짜 프로그램, 일부러 실패하는 시험 묶음은 스크립트 규칙을 받지 않는다.
const scriptTestPlaces = [
  "scripts/gh-post.test.mjs",
  "scripts/test-fixtures/stuck-run.mjs",
  "scripts/fixtures/test-exit-code/broken-setup.mjs",
  ".agents/scripts/check-worker-change.test.ts",
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
  "product/no-silent-exit-status": {
    reported: `export const text = (result) => (result.status === 0 ? result.stdout.trim() : "");\n`,
    kept: `export const text = (result) => {\n  if (result.status !== 0) throw new Error(\`git failed (exit \${result.status}): \${result.stderr}\`);\n  return result.stdout.trim();\n};\n`,
  },
  "product/no-io-in-unreadable": {
    reported: `import { readFileSync } from "node:fs";\nimport { orIfUnreadable } from "@babojubot/contracts";\nexport const read = (file) => orIfUnreadable(() => JSON.parse(readFileSync(file, "utf8")), undefined);\n`,
    kept: `import { readFileSync } from "node:fs";\nimport { orIfUnreadable } from "@babojubot/contracts";\nexport const read = (file) => {\n  const text = readFileSync(file, "utf8");\n  return orIfUnreadable(() => JSON.parse(text), undefined);\n};\n`,
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
        testPromiseRules.has(rule) && /\.test\.[cm]?[jt]s$/.test(place) ? 1 : 0;
      assert.equal(
        (await lint(reported, place, [rule])).length,
        expected,
        `${place}: ${rule}`
      );
    }
});

// 개발 스크립트와 그 시험은 루트 package.json의 devDependencies까지 받는다(yaml). 선언하지 않은 패키지(left-pad)는 막는다.
test("development scripts and their tests import only declared packages", async () => {
  const reported = `import pad from "left-pad";\nexport const padded = pad("1", 3);\n`;
  const kept = `import { parse } from "yaml";\nexport const read = (text) => parse(text);\n`;
  const rule = ["product/no-undeclared-import"];
  for (const place of [
    ...scriptPlaces,
    ...scriptTestPlaces.filter((p) => !p.includes("fixtures")),
  ]) {
    const [message, ...rest] = await lint(reported, place, rule);
    assert.ok(message, `${place}: not reported`);
    assert.deepEqual(rest, [], place);
    assert.match(message.message, /package\.json/);
    assert.deepEqual(await lint(kept, place, rule), [], `${place}: ${kept}`);
  }
});

// 오류 이벤트 처리기도 오류를 받아 확인한다. 상대가 끊은 것만 넘기고 나머지는 남긴다.
test("development scripts do not drop the error an error listener receives", async () => {
  const reported = `export const watch = (child) => child.stdin.on("error", () => {});\n`;
  const kept = `import { isDisconnect } from "@babojubot/contracts";\nexport const watch = (child, record) =>\n  child.stdin.on("error", (error) => {\n    if (!isDisconnect(error)) record("stdin-error", { code: error.code });\n  });\n`;
  const rule = ["product/no-ignored-error"];
  for (const place of scriptPlaces) {
    const [message, ...rest] = await lint(reported, place, rule);
    assert.ok(message, `${place}: not reported`);
    assert.deepEqual(rest, [], place);
    assert.deepEqual(await lint(kept, place, rule), [], `${place}: ${kept}`);
  }
  for (const place of scriptTestPlaces)
    assert.deepEqual(await lint(reported, place, rule), [], place);
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
  // 프로그램을 끈 뒤 그 폴더를 지운다(앞 단계가 끝나야 안전한 단계). 폴더 지우기는 출처(공용 removeFolder)로 알아본다(#266 리뷰
  // SPEC-7: 같은 이름의 매개변수는 그 도구가 아니다).
  `import { removeFolder } from "@babojubot/process/remove-folder";\nexport async function run(child, dir, killProgram) {\n  try {\n    await child.done;\n  } finally {\n    await killProgram(child);\n    await removeFolder(dir);\n  }\n}\n`,
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
        Object.hasOwn(caughtChains, shape)
          ? /한 try…catch/
          : /차례로 기다리거나/
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
  // 불러오는 함수는 출처로 알아본다: 이름을 바꿔 가져온 createRequire(#266 리뷰 SPEC-2).
  "child_process from a renamed createRequire": `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\nconst { spawn } = load("node:child_process");\nspawn("x", []);\n`,
  "child_process from getBuiltinModule": `process.getBuiltinModule("node:child_process");\n`,
  // 출처로 본다: 모듈 객체의 별칭, cross-spawn 기본 함수의 별칭(#266 리뷰 SPEC-4).
  "an alias of the module object": `import * as cp from "node:child_process";\nconst tools = cp;\ntools.spawn("x", []);\n`,
  "an alias of the cross-spawn function": `import crossSpawn from "cross-spawn";\nconst run = crossSpawn;\nrun("x", []);\n`,
};
// 막지 않는 모양: 상한을 둔 동기 실행, cross-spawn의 동기 실행, 타입만 가져오기, 공용 실행.
const keptLaunches = [
  `import { execFileSync, spawnSync } from "node:child_process";\nexecFileSync("x", [], { timeout: 1000, killSignal: "SIGKILL" });\nspawnSync("x", [], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  `import crossSpawn from "cross-spawn";\ncrossSpawn.sync("x", [], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  `import type { ChildProcess } from "node:child_process";\nexport type Child = ChildProcess;\n`,
  `import { launchTree } from "@babojubot/process";\nconst tree = launchTree({ command: ["x"], args: [], cwd: ".", env: {}, stdio: "pipe" });\nawait tree.stop();\n`,
  // 모듈 객체를 지역 매개변수가 가리면 그 모듈이 아니다(#266 리뷰 SPEC-4).
  `import * as cp from "node:child_process";\nvoid cp;\nexport function run(cp) {\n  cp.spawn("x", []);\n}\n`,
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
    "packages/process/src/supervised.ts",
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

const numberRule = ["product/no-number-signal"];
// 번호로 신호를 보내는 모양: process.kill(번호, 신호)·신호를 뺀 process.kill, 번호로 끄는 명령을 띄우는 호출.
const numberSignals = {
  "process.kill with a signal": `export function stop(pid) {\n  process.kill(pid, "SIGTERM");\n}\n`,
  "process.kill without a signal": `export function stop(pid) {\n  process.kill(pid);\n}\n`,
  "process.kill with a computed signal": `export function stop(pid, signal) {\n  process.kill(pid, signal);\n}\n`,
  "process.kill through a computed name": `export function stop(pid) {\n  process["kill"](pid, "SIGKILL");\n}\n`,
  "taskkill by execFileSync": `import { execFileSync } from "node:child_process";\nexecFileSync("taskkill", ["/F", "/PID", "42"], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  "kill by spawnSync": `import { spawnSync } from "node:child_process";\nspawnSync("kill", ["-9", "42"], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  "pkill by runCommand": `import { runCommand } from "@babojubot/process";\nawait runCommand("pkill", ["-f", "x"], { limitMs: 1000, maxOutputBytes: 10 });\n`,
  "kill in a command line": `import { execSync } from "node:child_process";\nexecSync("kill -9 42", { timeout: 1000, killSignal: "SIGKILL" });\n`,
  // #283 외부 리뷰 1회차 STD-1: 실행 입구는 이름 목록이 아니라 출처로, 명령은 경로를 뗀 이름으로 본다.
  "kill through runTree": `import { runTree } from "@babojubot/process";\nawait runTree({ command: ["kill", "-9", "42"], args: [], cwd: ".", env: {}, limitMs: 1000, maxOutputBytes: 10, overflow: "stop" });\n`,
  "taskkill through launchTree": `import { launchTree } from "@babojubot/process";\nconst tree = launchTree({ command: ["taskkill", "/F", "/PID", "42"], args: [], cwd: ".", env: {}, stdio: "pipe" });\nawait tree.stop();\n`,
  "kill by an absolute path": `import { execFileSync } from "node:child_process";\nexecFileSync("/bin/kill", ["-9", "42"], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  "taskkill.exe by a Windows path": `import { execFileSync } from "node:child_process";\nexecFileSync("C:\\\\Windows\\\\System32\\\\taskkill.exe", ["/F", "/PID", "42"], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  "an absolute kill in a command line": `import { execSync } from "node:child_process";\nexecSync("/usr/bin/pkill -f x", { timeout: 1000, killSignal: "SIGKILL" });\n`,
  "pkill through a renamed runCommand": `import { runCommand as run } from "@babojubot/process";\nawait run("pkill", ["-f", "x"], { limitMs: 1000, maxOutputBytes: 10 });\n`,
  "process.kill through an alias": `const proc = process;\nexport function stop(pid) {\n  proc.kill(pid, "SIGTERM");\n}\n`,
};
// 막지 않는 모양: 신호 0(생존 확인), 자식 핸들의 kill, 띄운 트리의 끄기, 실행기에 청하는 정리, 번호로 끄지 않는 명령.
const keptNumberCalls = [
  `export function alive(pid) {\n  process.kill(pid, 0);\n}\n`,
  `export function stop(child) {\n  child.kill("SIGTERM");\n}\n`,
  `export async function stop(tree) {\n  await tree.stop();\n}\n`,
  `import { cleanThroughSupervisor } from "@babojubot/process/recovery";\nawait cleanThroughSupervisor({ lease: "x" });\n`,
  `import { execFileSync } from "node:child_process";\nexecFileSync("ps", ["-o", "lstart=", "-p", "42"], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  `import { runTree } from "@babojubot/process";\nawait runTree({ command: ["/usr/bin/ps", "-A"], args: [], cwd: ".", env: {}, limitMs: 1000, maxOutputBytes: 10, overflow: "stop" });\n`,
  `import { launchTree } from "@babojubot/process";\nconst tree = launchTree({ command: [process.execPath, "-e", "1"], args: [], cwd: ".", env: {}, stdio: "pipe" });\nawait tree.stop();\n`,
  // 이름이 kill이어도 실행 입구가 아니면 아니다.
  `export function run(spawn) {\n  spawn("kill", ["-9", "42"]);\n}\n`,
];

/**
 * 프로세스 패키지(@babojubot/process)의 모든 입구(package.json `exports`)가 실제로 내보내는 함수·클래스 이름. lint의 `launcherKind`는
 * 패키지의 어느 입구에서 가져온 이름이든 실행 입구 후보로 보므로 모든 입구를 본다. 글자를 정규식으로 읽지 않고 TypeScript 검사기가
 * 푼 내보내기(`export function`·`export { … } from`·`export *`·이름 바꾸기 모두)를 쓴다. 모듈을 실제로 불러오지 않는 까닭: 시험 준비
 * 입구(`./launcher-setup`)는 불러오는 순간 vitest 훅을 걸고 `./testing`은 vitest 안에서만 쓰는 도움이라 node:test에서는 불러올 수 없다.
 */
function processPackageFunctions() {
  const packageFolder = path.join(repository, "packages/process");
  const { exports } = JSON.parse(
    readFileSync(path.join(packageFolder, "package.json"), "utf8")
  );
  const entries = Object.entries(exports).map(([entry, file]) => ({
    entry,
    file: path.join(packageFolder, file),
  }));
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(packageFolder, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  );
  assert.ok(config, "packages/process/tsconfig.json could not be read");
  const program = ts.createProgram(
    entries.map(({ file }) => file),
    config.options
  );
  const checker = program.getTypeChecker();
  /** @type {Map<string, string>} 이름 → 그것을 내보내는 입구 */
  const functions = new Map();
  for (const { entry, file } of entries) {
    const source = program.getSourceFile(file);
    assert.ok(source, `the entry ${entry} (${file}) was not found`);
    const module = checker.getSymbolAtLocation(source);
    for (const symbol of module ? checker.getExportsOfModule(module) : []) {
      const target =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      if (!(target.flags & ts.SymbolFlags.Value)) continue;
      const type = checker.getTypeOfSymbol(target);
      if (
        type.getCallSignatures().length + type.getConstructSignatures().length
      )
        functions.set(symbol.name, entry);
    }
  }
  return functions;
}

// 실행 입구 표가 프로세스 패키지의 모든 입구가 내보내는 함수를 빠짐없이 가르고, 표에는 실제로 내보내는 함수만 있다: 새 실행 입구가
// 생기면 분류하기 전까지, 내보내기가 사라지면 표를 고치기 전까지 이 시험이 실패한다.
test("every function the process package exports is classified as a launcher or not", async () => {
  const { processLaunchers, processNonLaunchers } =
    await import("./eslint-product-rules.mjs");
  const functions = processPackageFunctions();
  assert.ok(
    functions.size > 0,
    "no function exported by @babojubot/process was found; the look itself is broken"
  );
  for (const [name, entry] of functions)
    assert.ok(
      processLaunchers.has(name) || processNonLaunchers.includes(name),
      `${name} is exported by @babojubot/process (${entry}) but not classified for product/no-number-signal`
    );
  for (const name of [...processLaunchers.keys(), ...processNonLaunchers])
    assert.ok(
      functions.has(name),
      `${name} is classified for product/no-number-signal but no entry of @babojubot/process exports it as a function`
    );
  for (const name of processNonLaunchers)
    assert.ok(
      !processLaunchers.has(name),
      `${name} is classified both as a launcher and not`
    );
});

test("signalling a process by its number is left to the supervisor", async () => {
  for (const place of [
    "apps/server/src/app.ts",
    "packages/runtime/src/providers/recovery.ts",
    "packages/process/src/group.ts",
  ]) {
    for (const [shape, code] of Object.entries(numberSignals)) {
      const [message, ...rest] = await lint(code, place, numberRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 이유와 대안을 알려 준다.
      assert.match(message.message, /감독 실행기/);
      assert.match(message.message, /launchTree/);
      assert.match(message.message, /cleanThroughSupervisor/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
    for (const code of keptNumberCalls)
      assert.deepEqual(
        await lint(code, place, numberRule),
        [],
        `${place}: ${code}`
      );
  }
  // 시험 코드와 개발 스크립트(실사용 시험 도구 포함)는 범위 밖이다.
  for (const place of [
    ...chainTestPlaces,
    ...scriptPlaces,
    "scripts/live/chaos-run.mjs",
  ])
    for (const code of Object.values(numberSignals))
      assert.deepEqual(
        await lint(code, place, numberRule),
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
  // 공용 가져오기 판정: require·dynamic import에서 구조 분해한 이름도 같다(#266 리뷰 SPEC-1).
  "execFile taken from a dynamic import": `const { execFile } = await import("node:child_process");\nexecFile("ps", [], () => {});\n`,
  "spawn taken from getBuiltinModule": `const { spawn } = process.getBuiltinModule("node:child_process");\nspawn("csc", [], { timeout: 1000 });\n`,
  "a const alias of execFile": `import { execFile } from "node:child_process";\nconst run = execFile;\nrun("ps", [], () => {});\n`,
};
// 막지 않는 모양: timeout 없는 spawn(끝은 boundChild가 맡음), 시한에 강제 종료하는 동기 실행, 짧은 명령 실행 함수.
const boundedCommands = [
  `import { spawn } from "node:child_process";\nspawn("csc", [], { stdio: "ignore" });\n`,
  `import { execFileSync } from "node:child_process";\nexecFileSync("ps", [], { timeout: 1000, killSignal: "SIGKILL" });\n`,
  `import { runCommand } from "./bounded-command.ts";\nawait runCommand("ps", [], { limitMs: 1000, maxOutputBytes: 1024 });\n`,
  // 가져온 이름을 지역 매개변수가 가리면 그 함수가 아니다(#266 리뷰 SPEC-4).
  `import { execFile } from "node:child_process";\nvoid execFile;\nexport function run(execFile) {\n  execFile("ps", [], () => {});\n}\n`,
];

test("launch owners end short commands at their time limit", async () => {
  for (const place of [
    "packages/process/src/supervised.ts",
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

// 다른 영역은 runtime·프로세스 패키지에서 목록에 없는 입구를 가져오지 않는다(#266). 안쪽 파일을 상대 경로로 가리키는 것은
// product/package-entry-only가 본다(아래 시험). db는 runtime에 기대지 않고,
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
      "packages/db/src/client.test.ts",
      `import { removeFolder } from "@babojubot/runtime/remove-folder";\nvoid removeFolder;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { withCleanup } from "@babojubot/process/test-cleanup";\nvoid withCleanup;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { cleanThroughSupervisor } from "@babojubot/process/recovery";\nvoid cleanThroughSupervisor;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { openLifelines } from "@babojubot/runtime/lifelines";\nvoid openLifelines;\n`,
    ],
    [
      ".agents/scripts/run-worker.ts",
      `export { removeFolder } from "@babojubot/runtime/remove-folder";\n`,
    ],
    [
      ".agents/scripts/run-worker.ts",
      `import { holdsLease } from "@babojubot/process/recovery";\nvoid holdsLease;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `const recovery = await import("@babojubot/process/recovery");\nvoid recovery;\n`,
    ],
    // 제품 코드도 runtime은 패키지 입구만 가져온다. 프로세스 바탕은 runtime에서 옮겼다.
    [
      "apps/server/src/dispatcher.ts",
      `import { TreeLaunchRefused } from "@babojubot/runtime/launch";\nvoid TreeLaunchRefused;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { testFolders } from "@babojubot/process/testing";\nvoid testFolders;\n`,
    ],
    // 제품 코드는 db의 시험·개발 도구 입구를 가져오지 않는다.
    [
      "apps/server/src/app.ts",
      `import { createTestDatabase } from "@babojubot/db/testing";\nvoid createTestDatabase;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { withClient } from "@babojubot/db/admin";\nvoid withClient;\n`,
    ],
    // 공용 가져오기 판정: require·createRequire로 불러오거나 찾는 입구도 같다(#266 리뷰 SPEC-1).
    [
      "apps/server/src/app.ts",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nvoid load("@babojubot/db/admin");\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst { identity } = load("@babojubot/process/recovery");\nvoid identity;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { createRequire } from "node:module";\nvoid createRequire(import.meta.url).resolve("@babojubot/process/recovery");\n`,
    ],
    // 불러오는 함수는 출처로 알아본다: 이름을 바꿔 가져온 createRequire, 모듈 객체의 createRequire(#266 리뷰 SPEC-2).
    [
      "apps/server/src/app.ts",
      `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\nconst { identity } = load("@babojubot/process/recovery");\nvoid identity;\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import * as nodeModule from "node:module";\nvoid nodeModule.createRequire(import.meta.url)("@babojubot/db/admin");\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `void require("@babojubot/runtime/testing");\n`,
    ],
    [
      "packages/runtime/src/providers/process.ts",
      `import { holdsLease } from "@babojubot/process/recovery";\nvoid holdsLease;\n`,
    ],
    // 입구 제한은 경로 철자가 아니라 대상(입구 파일)으로 본다(#266 리뷰 SPEC-6): 자기 패키지 안에서도 자기 이름이나 상대 경로로
    // 그 입구 파일을 가져오면 다른 영역과 같은 판정이다.
    [
      "packages/process/src/clock.ts",
      `import { identity } from "@babojubot/process/recovery";\nvoid identity;\n`,
    ],
    [
      "packages/process/src/clock.ts",
      `import { identity } from "./recovery.ts";\nvoid identity;\n`,
    ],
    [
      "packages/process/src/clock.ts",
      `import { withCleanup } from "./test-cleanup";\nvoid withCleanup;\n`,
    ],
    [
      "packages/runtime/src/providers/claude.ts",
      `import { createGate } from "../testing.ts";\nvoid createGate;\n`,
    ],
    [
      "packages/runtime/src/providers/claude.ts",
      `import { createGate } from "@babojubot/runtime/testing";\nvoid createGate;\n`,
    ],
    [
      "packages/db/src/approvals.ts",
      `import { withClient } from "./admin.ts";\nvoid withClient;\n`,
    ],
    [
      "packages/db/src/approvals.ts",
      `import startTestCluster from "@babojubot/db/test-cluster";\nvoid startTestCluster;\n`,
    ],
    // 다른 패키지의 입구 파일을 상대 경로로 가리켜도 그 입구다.
    [
      "packages/runtime/src/providers/claude.ts",
      `import { identity } from "../../../process/src/recovery.ts";\nvoid identity;\n`,
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
      "apps/server/src/app.ts",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst { launchTree } = load("@babojubot/process");\nvoid launchTree;\n`,
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
      "apps/server/src/app.ts",
      `import { prepareJobObjectLauncher } from "@babojubot/process";\nimport { recoverProviderProcesses } from "@babojubot/runtime";\nvoid [prepareJobObjectLauncher, recoverProviderProcesses];\n`,
    ],
    [
      "packages/runtime/src/providers/attempt-folder.ts",
      `import { removeFolder } from "@babojubot/process/remove-folder";\nvoid removeFolder;\n`,
    ],
    [
      "packages/runtime/src/providers/recovery.ts",
      `import { holdsLease, identity } from "@babojubot/process/recovery";\nvoid [holdsLease, identity];\n`,
    ],
    // 자기 패키지 안의 입구가 아닌 파일(입구가 다시 내보내는 안쪽 모듈 포함)과 받는 입구는 그대로다. db 밖의 시험 코드는 범위 밖이다.
    [
      "packages/process/src/index.ts",
      `export { launchTree } from "./launch.ts";\n`,
    ],
    [
      "packages/process/src/clock.ts",
      `import { holdsLease } from "./lease.ts";\nimport { identity } from "./group.ts";\nvoid [holdsLease, identity];\n`,
    ],
    [
      "packages/process/src/clock.ts",
      `import { launchTree } from "@babojubot/process";\nimport { removeFolder } from "./remove-folder.ts";\nvoid [launchTree, removeFolder];\n`,
    ],
    [
      "packages/db/src/approvals.ts",
      `import * as db from "./index.ts";\nvoid db;\n`,
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

const entryRule = ["product/package-entry-only"];

// 다른 workspace 패키지는 그 package.json의 exports가 내보낸 입구로만, 패키지 이름으로 가져온다(#266). 상대 경로로 다른 패키지
// 폴더 안을 가리키거나(입구 파일 포함) 내보내지 않은 하위 경로를 가져오지 않는다. 제품 코드·개발 스크립트·시험 모두 같다.
// 선례: import-x의 no-relative-packages(다른 패키지를 상대 경로로 가져오기)·no-internal-modules(안쪽 모듈 가져오기), Node.js의 exports.
test("other workspace packages are imported only through their exported entries", async () => {
  const refused = [
    [
      "scripts/live/chaos-run.mjs",
      `import { attemptAll } from "../../packages/contracts/src/failure.ts";\nvoid attemptAll;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { startServer } from "../apps/server/src/index.ts";\nvoid startServer;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { createConnection } from "../packages/runtime/src/index.ts";\nvoid createConnection;\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `const { withClient } = await import("../../packages/db/src/client.ts");\nvoid withClient;\n`,
    ],
    [
      ".agents/scripts/run-worker.ts",
      `export { attemptAll } from "../../packages/contracts/src/failure.ts";\n`,
    ],
    [
      "apps/server/src/app.ts",
      `import { openDatabase } from "../../../packages/db/src/client.ts";\nvoid openDatabase;\n`,
    ],
    [
      "packages/runtime/src/providers/process.ts",
      `import { holdsLease } from "../../../process/src/lease.ts";\nvoid holdsLease;\n`,
    ],
    [
      "packages/db/src/client.ts",
      `import { recordProcess } from "../../runtime/src/providers/recovery.ts";\nvoid recordProcess;\n`,
    ],
    // 시험 코드도 같다.
    [
      "apps/server/test/support.ts",
      `import { createTestDatabase } from "../../../packages/db/src/testing.ts";\nvoid createTestDatabase;\n`,
    ],
    [
      "packages/db/src/client.test.ts",
      `import { planRunStart } from "../../core/src/run.ts";\nvoid planRunStart;\n`,
    ],
    // require·require.resolve·createRequire로 문자열 경로를 불러오거나 찾는 것도 같다.
    [
      "scripts/provider-live.mjs",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("../packages/db/src/client.ts");\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nvoid load.resolve("@babojubot/db/src/schema.ts");\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `import { createRequire } from "node:module";\nvoid createRequire(import.meta.url)("../../apps/server/src/index.ts");\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `import nodeModule from "node:module";\nvoid nodeModule.createRequire(import.meta.url).resolve("../../packages/contracts/src/failure.ts");\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `void require("../../packages/db/src/client.ts");\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `void require.resolve("../../packages/db/package.json");\n`,
    ],
    // 내보내지 않은 하위 경로.
    [
      "apps/web/src/api.ts",
      `import { attemptAll } from "@babojubot/contracts/src/failure.ts";\nvoid attemptAll;\n`,
    ],
    [
      "apps/server/test/support.ts",
      `import { createTestDatabase } from "@babojubot/db/src/testing.ts";\nvoid createTestDatabase;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { launchTree } from "@babojubot/runtime/launch";\nvoid launchTree;\n`,
    ],
    // 자기 패키지도 이름으로 적으면 exports에 있는 입구만 닿는다(Node.js self-reference, #266 리뷰 SPEC-3).
    [
      "packages/process/src/lease.ts",
      `import { identity } from "@babojubot/process/src/group.ts";\nvoid identity;\n`,
    ],
  ];
  for (const [place, code] of refused) {
    const [message, ...rest] = await lint(code, place, entryRule);
    assert.ok(message, `${place}: ${code} not reported`);
    assert.deepEqual(rest, [], `${place}: ${code}`);
    // 이유와 대안(패키지 이름과 그 exports의 입구, 입구가 없으면 더하기)을 알려 준다.
    assert.match(message.message, /@babojubot\//);
    assert.match(message.message, /exports/);
    assert.match(message.message, /docs\/architecture\.md/);
  }
  const kept = [
    // 다른 패키지는 이름과 내보낸 입구로.
    [
      "scripts/live/chaos-run.mjs",
      `import { attemptAll } from "@babojubot/contracts";\nimport { removeFolder } from "@babojubot/process/remove-folder";\nvoid [attemptAll, removeFolder];\n`,
    ],
    [
      "apps/server/test/support.ts",
      `import { createTestDatabase } from "@babojubot/db/testing";\nvoid createTestDatabase;\n`,
    ],
    [
      "scripts/live/chaos-run.mjs",
      `import { withClient } from "@babojubot/db/admin";\nvoid withClient;\n`,
    ],
    // 저장소 밖 라이브러리와 패키지 입구는 require로도 그대로다.
    [
      "scripts/provider-live.mjs",
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nvoid load.resolve("drizzle-orm");\nvoid load("@babojubot/db");\nvoid require("./live/check-server.mjs");\n`,
    ],
    // 같은 패키지 안의 상대 경로와 패키지 밖 라이브러리.
    [
      "packages/db/src/client.test.ts",
      `import { openDatabase } from "./client.ts";\nimport { eq } from "drizzle-orm";\nvoid [openDatabase, eq];\n`,
    ],
    [
      "packages/runtime/src/providers/claude.ts",
      `import { createConnection } from "../index.ts";\nvoid createConnection;\n`,
    ],
    [
      "scripts/provider-live.mjs",
      `import { withCheckServer } from "./live/check-server.mjs";\nvoid withCheckServer;\n`,
    ],
  ];
  for (const [place, code] of kept)
    assert.deepEqual(
      await lint(code, place, entryRule),
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

// 출처로 판정하는 제품·스크립트 규칙은 모두 같은 두 가지를 지킨다(#266 리뷰 SPEC-7·8·9): 같은 값에 닿는 접근 모양이 달라도 같은 판정,
// 같은 이름의 지역 값에는 반대 판정. 사례는 정식 이름으로 하나만 적고 모양은 scripts/lint-access-shapes.mjs가 만든다. `kept`면 정식
// 사례가 통과하는 사례다. 가져오는 자리를 보는 규칙(package-entry-only·package-import-scope·launch-boundary·
// no-undeclared-import)은 값이 아니라 가져오는 경로로 판정해 여기에 넣지 않는다(불러오는 함수의 모양은 scripts/eslint-imports.test.mjs).
const product = "apps/server/src/app.ts";
const productOriginCases = [
  {
    rule: "product/sync-command-timeout",
    value: { module: "node:child_process", path: ["execFileSync"] },
    use: (r) => `export const out = () => ${r}("ps", []);\n`,
  },
  {
    rule: "product/no-io-in-unreadable",
    value: { module: "@babojubot/contracts", path: ["orIfUnreadable"] },
    head: `import { readFileSync } from "node:fs";\n`,
    use: (r) =>
      `export const read = (file) => ${r}(() => readFileSync(file, "utf8"), undefined);\n`,
  },
  ...[
    { module: "node:child_process", path: ["spawn"] },
    { module: "cross-spawn", path: ["default"] },
  ].map((value) => ({
    rule: "product/no-direct-launch",
    value,
    use: (r) => `${r}("x", []);\n`,
  })),
  {
    rule: "product/bounded-command",
    place: "packages/process/src/supervised.ts",
    value: { module: "node:child_process", path: ["execFile"] },
    use: (r) => `${r}("ps", [], () => {});\n`,
  },
  {
    rule: "product/no-assertion-on-parsed-data",
    value: { global: "JSON", path: ["parse"] },
    use: (r) =>
      `type Row = { id: number };\nexport const read = (text: string) => ${r}(text) as Row;\n`,
  },
  {
    rule: "product/no-failure-collecting",
    value: { global: "AggregateError", path: [] },
    use: (r) =>
      `export function fail(errors) {\n  throw new ${r}(errors, "failed");\n}\n`,
  },
  {
    rule: "product/no-failure-collecting",
    value: { module: "@babojubot/contracts", path: ["continueAfterFailure"] },
    use: (r) =>
      `export function stop(pids, kill, failures) {\n  for (const pid of pids)\n    ${r}(\n      () => kill(pid),\n      (error) => failures.push(error)\n    );\n}\n`,
  },
  {
    rule: "product/no-cleanup-chain",
    value: { global: "process", path: ["kill"] },
    use: (r) =>
      `export async function run(work, pids) {\n  try {\n    await work();\n  } finally {\n    for (const pid of pids) ${r}(pid, "SIGKILL");\n  }\n}\n`,
  },
  // 경로로 확인한 뒤 같은 경로를 다시 열기(#242): 확인 쪽과 사용 쪽 모두 출처로 본다.
  ...[
    { module: "node:fs/promises", path: ["lstat"] },
    { module: "node:fs", path: ["promises", "stat"] },
    { module: "node:fs", path: ["accessSync"] },
  ].map((value) => ({
    rule: "product/no-check-then-reopen",
    value,
    head: `import { readFileSync as reopen } from "node:fs";\n`,
    use: (r) =>
      `export async function read(file: string) {\n  await ${r}(file);\n  return reopen(file, "utf8");\n}\n`,
  })),
  ...[
    { module: "node:fs/promises", path: ["readFile"] },
    { module: "node:fs", path: ["promises", "open"] },
    { module: "node:fs", path: ["writeFileSync"] },
  ].map((value) => ({
    rule: "product/no-check-then-reopen",
    value,
    head: `import { lstatSync as look } from "node:fs";\n`,
    use: (r) =>
      `export async function read(file: string) {\n  look(file);\n  return ${r}(file, "utf8");\n}\n`,
  })),
  // 공용 폴더 지우기: 끈 뒤 지우기만 이어지면 통과하고, 첫 정리로 지우면 뒤 정리를 건너뛸 수 있다.
  {
    rule: "product/no-cleanup-chain",
    value: {
      module: "@babojubot/process/remove-folder",
      path: ["removeFolder"],
    },
    use: (r) =>
      `export async function run(child, dir, killProgram) {\n  try {\n    await child.done;\n  } finally {\n    await killProgram(child);\n    await ${r}(dir);\n  }\n}\n`,
    kept: true,
  },
  {
    rule: "product/no-cleanup-chain",
    value: {
      module: "@babojubot/process/remove-folder",
      path: ["removeFolder"],
    },
    use: (r) =>
      `export async function run(dir, db) {\n  try {\n    await db.query();\n  } finally {\n    await ${r}(dir);\n    await db.close();\n  }\n}\n`,
    local: false,
    localSkipped:
      "정리 동사 이름(remove…)으로 알아보는 휴리스틱이 같은 이름의 지역 함수도 정리로 본다(출처 판정은 그 위에 덧붙인다).",
  },
];

test("every product rule that judges by origin sees its value through every access shape and passes a same-named local", async () => {
  // 어긋난 사례를 모두 모아 한 번에 보인다.
  const wrong = [];
  for (const { rule, place = product, kept, ...spec } of productOriginCases)
    for (const { shape, code, same } of accessShapes(spec)) {
      const found = (await lint(code, place, [rule])).length > 0;
      if (found !== (kept ? !same : same))
        wrong.push(
          `${rule} ${shape} (${found ? "reported" : "kept"}): ${code}`
        );
    }
  assert.deepEqual(wrong, []);
});

// git이 경로 목록을 줄 단위로 내면 줄바꿈·따옴표·탭·ASCII 밖 글자가 든 이름을 따옴표로 감싸 이스케이프한다(core.quotePath). 그 출력을
// 줄로 나누면 그런 이름을 다른 경로로 읽는다(#285 외부 리뷰의 자동 검사 후보, #286 항목 31). 경로 목록을 내는 하위 명령은 -z로
// NUL 구분 목록을 받는다. 글자가 아니라 구문 트리로 본다: child_process에서 온 실행(이름을 바꿔 가져오거나 모듈 객체로 불러도), git
// 인수를 그대로 넘기는 같은 파일의 감싸기 함수(나머지 인자·배열 인자, 감싸기를 다시 감싼 함수), 셸 명령 글.
const gitListRule = ["product/git-path-list-nul"];
const gitListPlaces = [
  "scripts/provider-live.mjs",
  ".agents/scripts/run-worker.ts",
  "scripts/gh-post.test.mjs",
  ".agents/scripts/worker-permissions.test.ts",
  "packages/process/src/ps.ts",
];
const childProcess = `import { execFileSync, execSync, spawnSync } from "node:child_process";\n`;
/** 경로 목록을 -z 없이 읽는 모양과, 같은 모양에 -z를 둔 것. */
const gitLists = [
  [
    'execFileSync("git", ["ls-files"]);',
    'execFileSync("git", ["ls-files", "-z"]);',
  ],
  // 옵션 끝(--) 뒤의 -z는 경로다(#291 외부 리뷰 2회차 SPEC-4).
  [
    'execFileSync("git", ["ls-files", "--", "-z"]);',
    'execFileSync("git", ["ls-files", "-z", "--", "-z"]);',
  ],
  [
    'spawnSync("git", ["diff", "--name-only", "origin/main"]);',
    'spawnSync("git", ["diff", "-z", "--name-only", "origin/main"]);',
  ],
  [
    'execFileSync("git", ["-c", "core.quotePath=false", "diff", "--name-status", "HEAD"]);',
    'execFileSync("git", ["-c", "core.quotePath=false", "diff", "--name-status", "-z", "HEAD"]);',
  ],
  [
    'execFileSync("git", ["-C", "repo", "status", "--porcelain"]);',
    'execFileSync("git", ["-C", "repo", "status", "--porcelain", "-z"]);',
  ],
  [
    'execFileSync("git", ["status", "--porcelain=v2"]);',
    'execFileSync("git", ["status", "--porcelain=v2", "-z"]);',
  ],
  // 짧은 옵션 묶음은 왼쪽부터 읽는다: 값을 받지 않는 옵션만 넘고 z에 닿으면 -z다(#291 외부 리뷰 3회차 SPEC-4).
  [
    'execFileSync("git", ["status", "-bs"]);',
    'execFileSync("git", ["status", "-bsz"]);',
  ],
  // 값을 붙여서만 받는 선택 값 옵션(status의 -u[<mode>])은 묶음의 나머지를 값으로 받는다. 같은 글자도 명령마다 다르다(ls-files -u는
  // 값이 없다).
  [
    'execFileSync("git", ["status", "--porcelain", "-uz"]);',
    'execFileSync("git", ["status", "--porcelain", "-uz", "-z"]);',
  ],
  [
    'execFileSync("git", ["ls-files", "-x", "*.tmp"]);',
    'execFileSync("git", ["ls-files", "-uz"]);',
  ],
  [
    'execFileSync("git", ["status", "--porcelain"]);',
    'execFileSync("git", ["status", "--porcelain", "--null"]);',
  ],
  [
    'execFileSync("git", ["ls-files", "-x", "*.tmp"]);',
    'execFileSync("git", ["ls-files", "-zx", "*.tmp"]);',
  ],
  // 옵션은 있는지가 아니라 왼쪽부터 읽은 마지막 상태로 본다: 부정형(`git <명령> -h`의 `--[no-]…`)이나 같은 출력 형식을 정하는 뒤
  // 옵션이 앞 옵션을 덮는다(#291 외부 리뷰 4회차 SPEC-4).
  [
    'execFileSync("git", ["status", "--porcelain", "-z", "--no-null"]);',
    'execFileSync("git", ["status", "--porcelain", "--no-null", "-z"]);',
  ],
  [
    'execFileSync("git", ["status", "--porcelain", "--null", "--no-null"]);',
    'execFileSync("git", ["status", "--porcelain", "--no-null", "--null"]);',
  ],
  [
    'execFileSync("git", ["status", "--no-porcelain", "--porcelain"]);',
    'execFileSync("git", ["status", "--porcelain", "--no-porcelain"]);',
  ],
  [
    'execFileSync("git", ["status", "--no-short", "--short"]);',
    'execFileSync("git", ["status", "--short", "--no-short"]);',
  ],
  [
    'execFileSync("git", ["status", "--long", "-s"]);',
    'execFileSync("git", ["status", "-s", "--long"]);',
  ],
  [
    'execFileSync("git", ["log", "--name-status"]);',
    'execFileSync("git", ["log", "--name-status", "-s"]);',
  ],
  [
    'execFileSync("git", ["ls-tree", "--name-only", "-r", "HEAD"]);',
    'execFileSync("git", ["ls-tree", "--name-only", "-r", "-z", "HEAD"]);',
  ],
  [
    'execSync("git ls-files --others");',
    'execSync("git ls-files --others -z");',
  ],
  [
    'const git = (...args) => execFileSync("git", args);\ngit("ls-files", "--others");',
    'const git = (...args) => execFileSync("git", args);\ngit("ls-files", "--others", "-z");',
  ],
  [
    'function git(root, ...args) {\n  return execFileSync("git", ["-C", root, ...args]);\n}\nconst list = (...args) => git(".", ...args);\nlist("diff", "--name-only");',
    'function git(root, ...args) {\n  return execFileSync("git", ["-C", root, ...args]);\n}\nconst list = (...args) => git(".", ...args);\nlist("diff", "--name-only", "-z");',
  ],
  [
    'function output(root, args) {\n  return spawnSync("git", args, { cwd: root });\n}\noutput(".", ["ls-files"]);',
    'function output(root, args) {\n  return spawnSync("git", args, { cwd: root });\n}\noutput(".", ["ls-files", "-z"]);',
  ],
];

test("git path lists are read with -z, judged by the syntax tree of the call", async () => {
  for (const place of gitListPlaces)
    for (const [reported, kept] of gitLists) {
      const found = await lint(childProcess + reported, place, gitListRule);
      assert.equal(found.length, 1, `${place}: ${reported}`);
      assert.match(found[0]?.message ?? "", /-z/);
      assert.deepEqual(
        await lint(childProcess + kept, place, gitListRule),
        [],
        `${place}: ${kept}`
      );
    }
});

// 하위 명령을 읽지 못한 git 호출은 "경로 목록 아님"으로 접지 않고 판정할 수 없다고 보고한다(#291 parent 점검: 풀지 못함을 건너뜀으로
// 접지 않는다). 하위 명령이 글자가 아닌 것, 인수를 넘기는 감싸기를 내보내거나 값으로 넘기거나 이름 없이 넘겨 부르는 자리를 따라갈 수 없는 것.
test("a git call whose subcommand the rule cannot read is reported, not passed as no path list", async () => {
  const place = "scripts/provider-live.mjs";
  for (const code of [
    'const command = "ls-files";\nexecFileSync("git", [command, "--others"]);\n',
    'const command = "ls-files";\nexecSync(`git ${command} --others`);\n',
    'execFileSync("git", process.argv.slice(2));\n',
    'export function git(...args) {\n  return execFileSync("git", args);\n}\n',
    'const git = (...args) => execFileSync("git", args);\nexport { git };\n',
    'const git = (...args) => execFileSync("git", args);\nuse(git);\n',
    'use((...args) => execFileSync("git", args));\n',
    'const git = (...args) => execFileSync("git", args);\nconst words = ["ls-files"];\ngit(...words);\n',
    // 값을 받을 수 있는 옵션 바로 뒤의 -z는 그 옵션의 값일 수 있다(#291 외부 리뷰 2회차 SPEC-4).
    'execFileSync("git", ["ls-files", "-x", "-z"]);\n',
    'execFileSync("git", ["ls-files", "--exclude", "-z"]);\n',
    'execFileSync("git", ["log", "--name-only", "--author", "-z"]);\n',
    // 짧은 옵션 묶음에서 값을 받는 옵션이나 모르는 글자 뒤는 그 옵션의 값이다(git parse-options, #291 외부 리뷰 3회차 SPEC-4):
    // `-xz`의 z는 -x의 값이다. 값을 받지 않는 옵션 목록에 없는 글자 뒤는 판정할 수 없다.
    'execFileSync("git", ["ls-files", "-xz"]);\n',
    'execFileSync("git", ["ls-files", "-sxz"]);\n',
    // git은 긴 옵션의 앞부분만 써도 받는다(parse-options의 줄여 쓰기). 경로 목록·-z를 정하는 옵션의 앞부분이면 판정할 수 없다.
    'execFileSync("git", ["diff", "--name-o", "HEAD"]);\n',
    'execFileSync("git", ["status", "--porc"]);\n',
    'execFileSync("git", ["status", "--porcelain", "--nu"]);\n',
    // 부정형도 줄여 쓸 수 있다. 끄는 옵션의 앞부분이면 마지막 상태가 정해지지 않는다(#291 외부 리뷰 4회차 SPEC-4).
    'execFileSync("git", ["status", "--porcelain", "-z", "--no-nu"]);\n',
    'execFileSync("git", ["status", "--porcelain", "--no-porc"]);\n',
  ]) {
    const found = await lint(childProcess + code, place, gitListRule);
    assert.equal(found.length, 1, code);
    assert.match(found[0]?.message ?? "", /판정할 수 없습니다/, code);
  }
  // 부르는 자리가 모두 같은 파일에 있고 글자로 하위 명령을 넘기면 판정한다. 아무도 부르지 않는 감싸기는 실행되지 않는다.
  for (const code of [
    'const git = (...args) => execFileSync("git", args);\ngit("rev-parse", "HEAD");\n',
    'const git = (...args) => execFileSync("git", args);\n',
    'execFileSync("git", ["-C", process.cwd(), "rev-parse", "HEAD"]);\n',
    // status의 -u는 값을 붙여 받으므로 `-us`의 s는 짧은 형식(-s)이 아니라 그 값이다. 경로 목록이 아니다.
    'execFileSync("git", ["status", "-us"]);\n',
  ])
    assert.deepEqual(
      await lint(childProcess + code, place, gitListRule),
      [],
      code
    );
});

test("git calls are found by where the launch comes from, not by its name", async () => {
  const place = "scripts/provider-live.mjs";
  for (const code of [
    'import { execFileSync as run } from "node:child_process";\nrun("git", ["ls-files"]);\n',
    'import cp from "node:child_process";\ncp.spawnSync("git", ["status", "--short"]);\n',
    'import * as cp from "child_process";\ncp.execFileSync("git", ["log", "--name-only"]);\n',
  ])
    assert.equal((await lint(code, place, gitListRule)).length, 1, code);
  for (const code of [
    // 경로 목록이 아닌 하위 명령.
    `${childProcess}execFileSync("git", ["rev-parse", "--show-toplevel"]);\n`,
    `${childProcess}execFileSync("git", ["merge-base", "HEAD", "origin/main"]);\n`,
    `${childProcess}execFileSync("git", ["status"]);\n`,
    // child_process에서 오지 않은 같은 이름의 함수, git이 아닌 프로그램.
    `const execFileSync = (...args) => args;\nexecFileSync("git", ["ls-files"]);\n`,
    `${childProcess}execFileSync("ls", ["ls-files"]);\n`,
  ])
    assert.deepEqual(await lint(code, place, gitListRule), [], code);
});
