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
    kept: `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"], { timeout: 10_000 });\n`,
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
    reported: `import { readFileSync } from "node:fs";\nimport { orIfUnreadable } from "../packages/contracts/src/failure.ts";\nexport const read = (file) => orIfUnreadable(() => JSON.parse(readFileSync(file, "utf8")), undefined);\n`,
    kept: `import { readFileSync } from "node:fs";\nimport { orIfUnreadable } from "../packages/contracts/src/failure.ts";\nexport const read = (file) => {\n  const text = readFileSync(file, "utf8");\n  return orIfUnreadable(() => JSON.parse(text), undefined);\n};\n`,
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
  const kept = `import { isDisconnect } from "../packages/contracts/src/failure.ts";\nexport const watch = (child, record) =>\n  child.stdin.on("error", (error) => {\n    if (!isDisconnect(error)) record("stdin-error", { code: error.code });\n  });\n`;
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
  // 그룹 끄기는 제품 함수로.
  `export async function stop(stopProcessGroup, child) {\n  await stopProcessGroup(child.pid);\n}\n`,
];

test("signalling a process group is left to the product's process group stop", async () => {
  for (const place of chainPlaces) {
    for (const [shape, code] of Object.entries(groupSignals)) {
      const [message, ...rest] = await lint(code, place, groupRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 이유와 대안을 알려 준다.
      assert.match(message.message, /stopProcessGroup/);
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
