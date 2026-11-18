// 저장소 lint 설정(eslint.config.js)이 제품 코드 규칙을 실제로 거는지 본다. 규칙의 범위에 오타가 나면
// 아무것도 잡지 않은 채 lint가 통과하므로, 잡아야 할 모양과 잡지 말아야 할 모양을 짧은 코드로 넣어 확인한다.
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

// src 안은 타입 정보로 검사하므로(TypeScript 프로젝트에 든 파일만) 있는 파일 자리를 빌린다.
const productPlaces = [
  "apps/server/src/app.ts",
  "apps/web/src/api.ts",
  "packages/db/src/approvals.ts",
  "packages/runtime/src/providers/claude.ts",
];
const testPlaces = [
  "packages/db/src/client.test.ts",
  "packages/runtime/src/providers/test-support.ts",
];

const launchRules = ["no-restricted-imports", "no-restricted-syntax"];

test("runtime code launches programs only through the process owners", async () => {
  const launches = {
    "a named import": `import { spawn } from "node:child_process";\nspawn("x");\n`,
    "a namespace import": `import * as cp from "child_process";\ncp.execFile("x");\n`,
    "a re-export": `export { execFile } from "node:child_process";\n`,
    "a dynamic import": `const cp = await import("node:child_process");\ncp.spawn("x");\n`,
    // runtime이 의존하는 cross-spawn도 같은 실행이다.
    "cross-spawn": `import spawn from "cross-spawn";\nspawn("x");\n`,
    "cross-spawn dynamically": `const { default: spawn } = await import("cross-spawn");\nspawn("x");\n`,
  };
  for (const place of [
    "packages/runtime/src/providers/claude.ts",
    "packages/runtime/src/providers/codex-connection.ts",
    "packages/runtime/src/index.ts",
  ])
    for (const [shape, code] of Object.entries(launches)) {
      const [message, ...rest] = await lint(code, place, launchRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 가야 할 실행 함수와 그 함수가 맡는 일을 알려 준다.
      assert.match(message.message, /startProcess/);
      assert.match(message.message, /runProbe/);
      assert.match(message.message, /providerEnvironment/);
    }
});

test("process owners, type imports and code outside runtime may use child_process", async () => {
  const named = `import { execFile } from "node:child_process";\nexecFile("x");\n`;
  for (const place of [
    "packages/runtime/src/providers/process.ts",
    "packages/runtime/src/providers/container.ts",
    "packages/runtime/src/providers/job-object.ts",
    "packages/runtime/src/providers/recovery.ts",
    "packages/runtime/src/providers/lease.ts",
    "packages/runtime/src/providers/antigravity-config.ts",
    "packages/runtime/src/providers/login.ts",
    // 시험 코드와 다른 패키지는 이 경계 밖이다.
    "packages/runtime/src/providers/process-test-support.ts",
    "packages/runtime/src/providers/process.test.ts",
    "packages/db/src/embedded.ts",
    "apps/server/src/workspace.ts",
  ])
    assert.deepEqual(await lint(named, place, launchRules), [], place);
  assert.deepEqual(
    await lint(
      `import type { ChildProcess } from "node:child_process";\nexport type Child = ChildProcess;\n`,
      "packages/runtime/src/providers/claude.ts",
      launchRules
    ),
    []
  );
});

const unsafeRules = [
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-call",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-argument",
];

test("product code may not use outside data before checking its shape", async () => {
  const unchecked = {
    assignment: `export function read(text: string) {\n  const row = JSON.parse(text);\n  return typeof row;\n}\n`,
    "member access": `export function read(text: string): unknown {\n  return JSON.parse(text).id;\n}\n`,
    call: `export function read(text: string): void {\n  JSON.parse(text)();\n}\n`,
    return: `export function read(text: string): number {\n  return JSON.parse(text);\n}\n`,
    argument: `const use = (n: number) => n;\nexport function read(text: string) {\n  return use(JSON.parse(text));\n}\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(unchecked))
      assert.notDeepEqual(
        await lint(code, place, unsafeRules),
        [],
        `${place}: ${shape} not reported`
      );
});

test("product code may read outside data as unknown and check it, and tests are left alone", async () => {
  const checked = `export function read(text: string): number | undefined {\n  const row: unknown = JSON.parse(text);\n  return typeof row === "object" && row !== null && "id" in row && typeof row.id === "number"\n    ? row.id\n    : undefined;\n}\n`;
  for (const place of productPlaces)
    assert.deepEqual(await lint(checked, place, unsafeRules), [], place);
  const unchecked = `export function read(text: string): number {\n  return JSON.parse(text).id;\n}\n`;
  for (const place of testPlaces)
    assert.deepEqual(await lint(unchecked, place, unsafeRules), [], place);
});

const assertionRule = ["@typescript-eslint/consistent-type-assertions"];

test("product code declares the type of an object literal instead of asserting it", async () => {
  const asserted = [
    `type Row = { id: number };\nexport const row = { id: 1 } as Row;\n`,
    `type Row = { id: number };\nexport const rows = [1].map((id) => ({ id }) as Row);\n`,
  ];
  for (const place of productPlaces)
    for (const code of asserted)
      assert.equal(
        (await lint(code, place, assertionRule)).length,
        1,
        `${place}: ${code}`
      );
  const allowed = [
    `type Row = { id: number };\nexport const row: Row = { id: 1 };\n`,
    `type Row = { id: number };\nexport const row = { id: 1 } satisfies Row;\n`,
    `export const row = { id: 1 } as const;\n`,
    // 객체 리터럴이 아닌 값의 단언은 이 규칙의 대상이 아니다.
    `export const text = (value: unknown) => value as string;\n`,
  ];
  for (const place of productPlaces)
    for (const code of allowed)
      assert.deepEqual(
        await lint(code, place, assertionRule),
        [],
        `${place}: ${code}`
      );
  for (const place of testPlaces)
    assert.deepEqual(await lint(asserted[0], place, assertionRule), [], place);
});

const equalityRule = ["eqeqeq"];

test("product code compares strictly except for the null check", async () => {
  for (const place of productPlaces) {
    for (const code of [
      `export const same = (a: unknown, b: unknown) => a == b;\n`,
      `export const other = (a: unknown) => a != 0;\n`,
    ])
      assert.equal(
        (await lint(code, place, equalityRule)).length,
        1,
        `${place}: ${code}`
      );
    // `== null`은 null과 undefined를 함께 보는 관용 표현이다.
    assert.deepEqual(
      await lint(
        `export const missing = (a: unknown) => a == null || a != null;\n`,
        place,
        equalityRule
      ),
      [],
      place
    );
  }
  for (const place of testPlaces)
    assert.deepEqual(
      await lint(
        `export const same = (a: unknown, b: unknown) => a == b;\n`,
        place,
        equalityRule
      ),
      [],
      place
    );
});

const syncCommandRule = ["product/sync-command-timeout"];

test("product code runs a program synchronously only with a timeout", async () => {
  const unbounded = {
    "an execFileSync without options": `import { execFileSync } from "node:child_process";\nexport const out = () => execFileSync("ps", ["-o", "lstart="]);\n`,
    "an execFileSync without a timeout": `import { execFileSync } from "node:child_process";\nexport const out = () => execFileSync("ps", [], { encoding: "utf8" });\n`,
    "a spawnSync without a timeout": `import { spawnSync } from "child_process";\nexport const out = () => spawnSync("taskkill", ["/F"], { stdio: "ignore" });\n`,
    "an execSync without a timeout": `import { execSync } from "node:child_process";\nexport const out = () => execSync("ps");\n`,
    "a renamed import": `import { execFileSync as run } from "node:child_process";\nexport const out = () => run("ps", []);\n`,
    "a namespace call": `import * as cp from "node:child_process";\nexport const out = () => cp.spawnSync("ps", [], { encoding: "utf8" });\n`,
    // 옵션을 변수로 넘기면 상한이 있는지 확인할 수 없다.
    "options in a variable": `import { execFileSync } from "node:child_process";\nconst options = { timeout: 1000 };\nexport const out = () => execFileSync("ps", [], options);\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(unbounded)) {
      const [message, ...rest] = await lint(code, place, syncCommandRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 비동기 실행과 상한 옵션을 안내한다.
      assert.match(message.message, /execFile/);
      assert.match(message.message, /timeout/);
    }
  const bounded = [
    `import { execFileSync } from "node:child_process";\nexport const out = () => execFileSync("ps", [], { encoding: "utf8", timeout: 5000 });\n`,
    `import { spawnSync } from "node:child_process";\nconst timeout = 5000;\nexport const out = () => spawnSync("ps", ["-p", "1"], { timeout });\n`,
    `import { execSync } from "node:child_process";\nexport const out = () => execSync("ps", { timeout: 5000 });\n`,
    // 비동기 실행은 서버를 멈추지 않는다.
    `import { execFile } from "node:child_process";\nexport const out = () => execFile("ps", [], () => {});\n`,
    // child_process가 아닌 같은 이름의 함수는 대상이 아니다.
    `const execFileSync = (name: string) => name;\nexport const out = () => execFileSync("ps");\n`,
  ];
  for (const place of productPlaces)
    for (const code of bounded)
      assert.deepEqual(
        await lint(code, place, syncCommandRule),
        [],
        `${place}: ${code}`
      );
  for (const place of testPlaces)
    assert.deepEqual(
      await lint(Object.values(unbounded)[0], place, syncCommandRule),
      [],
      place
    );
});
