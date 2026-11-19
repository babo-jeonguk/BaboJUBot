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
    // 실행 경계 검사를 거치지 않고 모듈을 불러오는 길도 막는다. 계산한 경로·template literal의 import는 무엇을 가져오는지 lint가 볼 수 없다.
    "a computed dynamic import": `const name = ["node", "child_process"].join(":");\nconst cp = await import(name);\n`,
    "a template literal dynamic import":
      "const cp = await import(`node:child_process`);\n",
    createRequire: `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("child_process");\n`,
    "createRequire renamed": `import { createRequire as make } from "module";\nmake(import.meta.url)("child_process");\n`,
    "createRequire on the module": `import nodeModule from "node:module";\nnodeModule.createRequire(import.meta.url)("child_process");\n`,
    "createRequire from a dynamic import": `const { createRequire } = await import("node:module");\ncreateRequire(import.meta.url)("child_process");\n`,
    "createRequire re-exported": `export { createRequire } from "node:module";\n`,
    "createRequire by a string key": `import * as nodeModule from "node:module";\nnodeModule["createRequire"](import.meta.url)("child_process");\n`,
    // node:module은 createRequire 말고도 Module._load처럼 import 검사를 거치지 않는 길이 있어 모듈째 막는다.
    "Module._load": `import { Module } from "node:module";\nModule._load("child_process");\n`,
    "process.getBuiltinModule": `process.getBuiltinModule("node:child_process").spawn("x");\n`,
    "getBuiltinModule from node:process": `import { getBuiltinModule } from "node:process";\ngetBuiltinModule("child_process");\n`,
    "getBuiltinModule destructured": `const { getBuiltinModule } = process;\ngetBuiltinModule("child_process");\n`,
    "a computed name on process": `const name = ["getBuiltin", "Module"].join("");\nprocess[name]("child_process");\n`,
    "a computed name on globalThis.process": `const name = ["getBuiltin", "Module"].join("");\nglobalThis.process[name]("child_process");\n`,
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
  // 실행 경계 밖의 모듈 불러오기는 막지 않는다: 문자열 경로의 import, node:module의 다른 함수.
  for (const [shape, code] of Object.entries({
    "a string dynamic import": `const claude = await import("./claude.ts");\nvoid claude;\n`,
    "a type from node:module": `import type { Module } from "node:module";\nexport type Loader = Module;\n`,
    // 계산한 이름은 process 자신에만 막는다. process.env 같은 그 안의 값은 그대로 읽는다.
    "a computed name under process": `const name = String(Date.now());\nvoid process.env[name];\nvoid process.argv[Number(name)];\nvoid process["pid"];\n`,
  }))
    assert.deepEqual(
      await lint(code, "packages/runtime/src/providers/claude.ts", launchRules),
      [],
      shape
    );
  // 실행 소유 파일과 runtime 밖은 node:module·계산한 경로의 import·process의 계산한 이름을 쓸 수 있다.
  const bypasses = `import { createRequire } from "node:module";\nconst name = String(Date.now());\nawait import(name);\ncreateRequire(import.meta.url)(name);\nvoid process[name as keyof typeof process];\n`;
  for (const place of [
    "packages/runtime/src/providers/process.ts",
    "packages/runtime/src/providers/process.test.ts",
    "packages/db/src/embedded.ts",
    "apps/server/src/workspace.ts",
  ])
    assert.deepEqual(await lint(bypasses, place, launchRules), [], place);
  assert.deepEqual(
    await lint(
      `import type { ChildProcess } from "node:child_process";\nexport type Child = ChildProcess;\n`,
      "packages/runtime/src/providers/claude.ts",
      launchRules
    ),
    []
  );
});

// 화면 파일(.tsx)도 같은 제품 규칙을 받는다. 확장자만 바꿔 규칙을 피하지 못한다. packages의 src에는 아직 .tsx가 없어
// 파일 자리를 빌릴 수 없으므로, 그 자리에 걸리는 설정을 본다.
test("product rules reach .tsx files in packages as they reach .ts files", async () => {
  const productRuleNames = [
    "product/no-ignored-error",
    "@typescript-eslint/no-floating-promises",
    "@typescript-eslint/switch-exhaustiveness-check",
  ];
  const typed = (config) =>
    Boolean(config.languageOptions?.parserOptions?.projectService);
  for (const place of [
    "packages/db/src/view.tsx",
    "packages/runtime/src/providers/view.tsx",
    "apps/server/src/view.tsx",
  ]) {
    const ts = await eslint.calculateConfigForFile(place.replace(/x$/, ""));
    const tsx = await eslint.calculateConfigForFile(place);
    for (const rule of productRuleNames) {
      assert.ok(ts.rules[rule], `${place}: ${rule} is not on .ts`);
      assert.deepEqual(tsx.rules[rule], ts.rules[rule], `${place}: ${rule}`);
    }
    assert.ok(typed(tsx), `${place}: no type information`);
    // 서버·runtime의 경계 금지도 같은 모양이다.
    assert.deepEqual(
      tsx.rules["no-restricted-syntax"],
      ts.rules["no-restricted-syntax"],
      `${place}: no-restricted-syntax`
    );
    assert.deepEqual(
      tsx.rules["no-restricted-imports"],
      ts.rules["no-restricted-imports"],
      `${place}: no-restricted-imports`
    );
  }
  // 시험 파일은 .tsx여도 제품 규칙 밖이다.
  const testTsx = await eslint.calculateConfigForFile(
    "packages/db/src/view.test.tsx"
  );
  assert.equal(testTsx.rules["product/no-ignored-error"], undefined);
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

const asyncWork = `const work = async () => 1;\n`;
const floatingRule = ["@typescript-eslint/no-floating-promises"];

test("product code handles the failure of every promise it starts", async () => {
  const floating = {
    "a bare call": `${asyncWork}export function run() {\n  work();\n}\n`,
    "then without a rejection handler": `${asyncWork}export function run() {\n  work().then(() => 1);\n}\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(floating))
      assert.equal(
        (await lint(code, place, floatingRule)).length,
        1,
        `${place}: ${shape}`
      );
  const handled = {
    awaited: `${asyncWork}export async function run() {\n  await work();\n}\n`,
    "marked with void": `${asyncWork}export function run() {\n  void work();\n}\n`,
    caught: `${asyncWork}export function run() {\n  work().catch((error: unknown) => console.warn(error));\n}\n`,
    returned: `${asyncWork}export function run() {\n  return work();\n}\n`,
  };
  for (const [shape, code] of Object.entries(handled))
    assert.deepEqual(
      await lint(code, productPlaces[0], floatingRule),
      [],
      shape
    );
  // 시험 코드도 같은 규칙을 받는다(시험 규칙은 `void`로 버리는 것까지 짚는다, scripts/lint-rules.test.mjs).
  for (const place of testPlaces)
    assert.equal(
      (await lint(floating["a bare call"], place, floatingRule)).length,
      1,
      place
    );
});

const misusedRule = ["@typescript-eslint/no-misused-promises"];

test("product code does not pass an async function where the result is dropped", async () => {
  const misused = {
    "a callback": `${asyncWork}export const run = (items: number[]) => items.forEach(work);\n`,
    "a handler property": `const on = (handlers: { onError: () => void }) => handlers;\nexport const run = () => on({ onError: async () => {} });\n`,
    "a condition": `${asyncWork}export const run = () => (work() ? 1 : 2);\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(misused))
      assert.equal(
        (await lint(code, place, misusedRule)).length,
        1,
        `${place}: ${shape}`
      );
  // 화면 이벤트 처리기도 같은 자리다.
  assert.equal(
    (
      await lint(
        `export const view = <button onClick={async () => {}} />;\n`,
        "apps/web/src/shell.tsx",
        misusedRule
      )
    ).length,
    1
  );
  assert.deepEqual(
    await lint(
      `${asyncWork}export const view = <button onClick={() => void work()} />;\n`,
      "apps/web/src/shell.tsx",
      misusedRule
    ),
    []
  );
  // 시험 코드도 같은 규칙을 받는다(scripts/lint-rules.test.mjs).
  for (const place of testPlaces)
    assert.equal(
      (await lint(misused["a callback"], place, misusedRule)).length,
      1,
      place
    );
});

const deprecatedRule = ["@typescript-eslint/no-deprecated"];

test("product code does not use what is marked deprecated", async () => {
  const uses = (tag) =>
    `${tag}const old = () => 1;\nexport const value = old();\n`;
  const deprecated = uses(`/** @deprecated 새 함수를 씁니다. */\n`);
  for (const place of productPlaces)
    assert.equal(
      (await lint(deprecated, place, deprecatedRule)).length,
      1,
      place
    );
  assert.deepEqual(await lint(uses(""), productPlaces[0], deprecatedRule), []);
  for (const place of testPlaces)
    assert.deepEqual(await lint(deprecated, place, deprecatedRule), [], place);
});

const parsedRule = ["product/no-assertion-on-parsed-data"];

test("product code does not assert a type on data it has just read", async () => {
  const asserted = {
    "parsed text": `type Row = { id: number };\nexport const read = (text: string) => JSON.parse(text) as Row;\n`,
    "parsed text or null": `type Row = { id: number };\nexport const read = (text: string) => JSON.parse(text) as Row | null;\n`,
    "through unknown": `type Row = { id: number };\nexport const read = (text: string) => JSON.parse(text) as unknown as Row;\n`,
    "a response body": `type Row = { id: number };\nexport const read = async (res: Response) => (await res.json()) as Row;\n`,
    "a body promise": `type Row = { id: number };\nexport const read = (res: Response) => res.json() as Promise<Row>;\n`,
    "parsed text with a default": `type Row = { id: number };\nexport const read = (text: string) => (JSON.parse(text) ?? {}) as Row;\n`,
    "a body with a default": `type Row = { id: number };\nexport const read = async (res: Response) => ((await res.json()) ?? {}) as Row;\n`,
    "a body read in then": `type Row = { id: number };\nexport const read = (url: string) => fetch(url).then((res) => res.json()) as Promise<Row>;\n`,
    "a body with a fallback": `type Row = { id: number };\nexport const read = async (res: Response) =>\n  (await res.json().catch(() => undefined)) as Row | undefined;\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(asserted)) {
      const [message, ...rest] = await lint(code, place, parsedRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 가야 할 모양을 알려 준다.
      assert.match(message.message, /unknown/);
      assert.match(message.message, /safeParse/);
    }
  const checked = {
    "received as unknown": `export const read = (text: string) => {\n  const row: unknown = JSON.parse(text);\n  return typeof row === "number" ? row : undefined;\n};\n`,
    "asserted as unknown": `export const read = (text: string) => JSON.parse(text) as unknown;\n`,
    "a body as unknown": `export const read = async (res: Response): Promise<unknown> => res.json();\n`,
    "another value": `export const read = (value: unknown) => value as string;\n`,
    "another then": `export const read = (work: Promise<unknown>) => work.then((value) => String(value)) as Promise<string>;\n`,
  };
  for (const [shape, code] of Object.entries(checked))
    assert.deepEqual(await lint(code, productPlaces[0], parsedRule), [], shape);
  for (const place of testPlaces)
    assert.deepEqual(
      await lint(asserted["parsed text"], place, parsedRule),
      [],
      place
    );
});

test("the read-assertion rule does not replace the bans already on server and runtime code", async () => {
  // 같은 규칙 이름을 뒤 블록이 덮어쓰면 기존 금지가 조용히 사라진다.
  const [hub] = await lint(
    `declare const hub: { publish(): void };\nhub.publish();\n`,
    "apps/server/src/app.ts",
    ["no-restricted-syntax"]
  );
  assert.ok(hub, "the server's commit-effect ban is gone");
  const [launch] = await lint(
    `const cp = await import("node:child_process");\ncp.spawn("x");\n`,
    "packages/runtime/src/providers/claude.ts",
    ["no-restricted-syntax"]
  );
  assert.ok(launch, "the runtime's launch ban is gone");
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
    // Node는 timeout이 0이거나 undefined면 기다림에 끝을 두지 않는다.
    "a zero timeout": `import { execFileSync } from "node:child_process";\nexport const out = () => execFileSync("ps", [], { timeout: 0 });\n`,
    "an undefined timeout": `import { spawnSync } from "node:child_process";\nexport const out = () => spawnSync("ps", [], { timeout: undefined });\n`,
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

const ignoredErrorRule = ["product/no-ignored-error"];

test("product code does not drop an error without naming it", async () => {
  const dropped = {
    "a catch without an error variable": `export function read(text: string) {\n  try {\n    return JSON.parse(text) as unknown;\n  } catch {\n    return undefined;\n  }\n}\n`,
    "an empty catch without an error variable": `export function run(work: () => void) {\n  try {\n    work();\n  } catch {\n    // 실패해도 괜찮다.\n  }\n}\n`,
    "a .catch handler without a parameter": `export const read = (work: Promise<string>) => work.catch(() => "");\n`,
    "a .catch function expression without a parameter": `export const read = (work: Promise<string>) => work.catch(function () {\n  return "";\n});\n`,
    "a .then rejection handler without a parameter": `export const read = (work: Promise<string>) => work.then((text) => text, () => "");\n`,
    "an underscored catch variable": `export function read(text: string) {\n  try {\n    return JSON.parse(text) as unknown;\n  } catch (_error) {\n    return undefined;\n  }\n}\n`,
    "an underscored .catch parameter": `export const read = (work: Promise<string>) => work.catch((_error: unknown) => "");\n`,
    "an underscored .then rejection parameter": `export const read = (work: Promise<string>) => work.then(undefined, (_error: unknown) => "");\n`,
    "a bracketed .catch handler without a parameter": `export const read = (work: Promise<string>) => work["catch"](() => "");\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(dropped)) {
      const [message, ...rest] = await lint(code, place, ignoredErrorRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 쓸 이름 붙은 함수와 작성 기준을 안내한다.
      assert.match(message.message, /orIfMissing/);
      assert.match(message.message, /continueAfterFailure/);
      assert.match(message.message, /orIfUnreadable/);
      assert.match(message.message, /settled/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
  const kept = [
    // 오류를 받아 검사한다.
    `export function read(text: string) {\n  try {\n    return JSON.parse(text) as unknown;\n  } catch (error) {\n    if (error instanceof SyntaxError) return undefined;\n    throw error;\n  }\n}\n`,
    `export const read = (work: Promise<string>) =>\n  work.catch((error: unknown) => {\n    console.warn("read failed", error);\n    return "";\n  });\n`,
    `export const read = (work: Promise<string>) =>\n  work.then(\n    (text) => text,\n    (error: unknown) => {\n      throw new Error("read failed", { cause: error });\n    }\n  );\n`,
    // 다른 오류를 던지는 한 문장뿐인 처리는 버리는 것이 아니다.
    `export function read(text: string) {\n  try {\n    return JSON.parse(text) as unknown;\n  } catch {\n    throw new Error("unreadable");\n  }\n}\n`,
    `export const read = (work: Promise<string>) =>\n  work.catch(() => {\n    throw new Error("unreadable");\n  });\n`,
    // `_`를 붙였어도 쓰는 오류는 버리는 것이 아니다.
    `export function read(text: string) {\n  try {\n    return JSON.parse(text) as unknown;\n  } catch (_error) {\n    throw new Error("unreadable", { cause: _error });\n  }\n}\n`,
    // 이름 붙은 함수와 성공 처리만 있는 then.
    `import { orIfUnreadable, settled } from "@babojubot/contracts";\nexport const read = (text: string) => orIfUnreadable((): unknown => JSON.parse(text), undefined);\nexport const wait = (work: Promise<string>) => settled(work.then((text) => text.trim()));\n`,
  ];
  for (const place of productPlaces)
    for (const code of kept)
      assert.deepEqual(
        await lint(code, place, ignoredErrorRule),
        [],
        `${place}: ${code}`
      );
  for (const place of testPlaces)
    for (const code of Object.values(dropped))
      assert.deepEqual(
        await lint(code, place, ignoredErrorRule),
        [],
        `${place}: ${code}`
      );
});
