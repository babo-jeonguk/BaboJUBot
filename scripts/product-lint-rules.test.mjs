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

// 실행 경계: 가져오기는 공용 가져오기 판정을 쓰는 product/launch-boundary가, 가져오기 검사를 피하는 문법(계산한 경로, getBuiltinModule,
// process의 계산한 이름)은 no-restricted-syntax가 본다.
const launchRules = ["product/launch-boundary", "no-restricted-syntax"];

const launches = {
  "a named import": `import { spawn } from "node:child_process";\nspawn("x");\n`,
  "a namespace import": `import * as cp from "child_process";\ncp.execFile("x");\n`,
  "a re-export": `export { execFile } from "node:child_process";\n`,
  "a dynamic import": `const cp = await import("node:child_process");\ncp.spawn("x");\n`,
  // runtime이 의존하는 cross-spawn도 같은 실행이다.
  "cross-spawn": `import spawn from "cross-spawn";\nspawn("x");\n`,
  "cross-spawn dynamically": `const { default: spawn } = await import("cross-spawn");\nspawn("x");\n`,
  // 공용 가져오기 판정: require와 TypeScript의 import-equals도 같다(#266 리뷰 SPEC-1).
  "a require": `const cp = require("node:child_process");\ncp.spawn("x");\n`,
  "an import-equals require": `import cp = require("child_process");\ncp.spawn("x");\n`,
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

test("runtime code launches programs only through the process owners", async () => {
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

// 프로세스 패키지 안에서도 공용 실행·짧은 명령·묶음 실행기 밖의 파일은 프로그램을 직접 띄우지 않는다(#266).
test("process package code launches programs only through its launch owners", async () => {
  for (const place of [
    "packages/process/src/lease.ts",
    "packages/process/src/clock.ts",
    "packages/process/src/remove-folder.ts",
  ])
    for (const [shape, code] of Object.entries(launches)) {
      const [message, ...rest] = await lint(code, place, launchRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 띄우기와 끄기를 한 쌍으로 두는 함수와 짧은 명령 함수, 예외를 올리는 곳을 알려 준다.
      assert.match(message.message, /launchTree/);
      assert.match(message.message, /runCommand/);
      assert.match(message.message, /processPackageOwners/);
    }
});

test("process owners, type imports and code outside runtime may use child_process", async () => {
  const named = `import { execFile } from "node:child_process";\nexecFile("x");\n`;
  for (const place of [
    "packages/process/src/launch.ts",
    "packages/process/src/bounded-command.ts",
    "packages/process/src/job-object.ts",
    "packages/runtime/src/providers/container.ts",
    "packages/runtime/src/providers/recovery.ts",
    "packages/runtime/src/providers/login.ts",
    // 시험 코드와 다른 패키지는 이 경계 밖이다.
    "packages/process/src/process-test-support.ts",
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
    "packages/process/src/launch.ts",
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
    // 출처로 본다: const 별칭·구조 분해로 받은 JSON.parse(#266 리뷰 SPEC-7).
    "a const alias of JSON.parse": `type Row = { id: number };\nconst parse = JSON.parse;\nexport const read = (text: string) => parse(text) as Row;\n`,
    "a destructured JSON.parse": `type Row = { id: number };\nconst { parse } = JSON;\nexport const read = (text: string) => parse(text) as Row;\n`,
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
  // JSON은 글자 이름이 아니라 출처로 본다(#266 리뷰 SPEC-4): 별칭은 같고, 같은 이름의 지역 값은 아니다.
  const [aliased] = await lint(
    `type Row = { id: number };\nconst Json = JSON;\nexport const read = (text: string) => Json.parse(text) as Row;\n`,
    productPlaces[0],
    parsedRule
  );
  assert.ok(aliased, "an alias of JSON not reported");
  checked["a local JSON"] =
    `type Row = { id: number };\nconst JSON = { parse: (text: string): Row => ({ id: text.length }) };\nexport const read = (text: string) => JSON.parse(text) as Row;\n`;
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
  // runtime의 실행 경계: 가져오기 검사를 피하는 문법은 no-restricted-syntax가, 가져오기는 product/launch-boundary가 본다.
  const [bypass] = await lint(
    `const name = ["node", "child_process"].join(":");\nconst cp = await import(name);\nvoid cp;\n`,
    "packages/runtime/src/providers/claude.ts",
    ["no-restricted-syntax"]
  );
  assert.ok(bypass, "the runtime's launch bypass ban is gone");
  const [launch] = await lint(
    `const cp = await import("node:child_process");\ncp.spawn("x");\n`,
    "packages/runtime/src/providers/claude.ts",
    ["product/launch-boundary"]
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
    // 공용 가져오기 판정: dynamic import·getBuiltinModule에서 구조 분해한 이름도 같다(#266 리뷰 SPEC-1).
    "a name taken from a dynamic import": `const { execFileSync } = await import("node:child_process");\nexport const out = () => execFileSync("ps", []);\n`,
    "a name taken from getBuiltinModule": `const { spawnSync: run } = process.getBuiltinModule("node:child_process");\nexport const out = () => run("ps", []);\n`,
    // 출처로 본다: const 별칭과 모듈 객체의 별칭(#266 리뷰 SPEC-4).
    "a const alias": `import { execFileSync } from "node:child_process";\nconst run = execFileSync;\nexport const out = () => run("ps", []);\n`,
    "an alias of the module object": `import * as cp from "node:child_process";\nconst tools = cp;\nexport const out = () => tools.spawnSync("ps", []);\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(unbounded)) {
      const [message, ...rest] = await lint(code, place, syncCommandRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 비동기 실행(공용 실행)과 상한·강제 종료 옵션을 안내한다.
      assert.match(message.message, /runTree/);
      assert.match(message.message, /timeout/);
      assert.match(message.message, /killSignal/);
    }
  // 시한은 있지만 시한에 신호(기본 SIGTERM)만 보내 끝을 보장하지 않는다(#262).
  const soft = {
    "a timeout without a kill signal": `import { execFileSync } from "node:child_process";\nexport const out = () => execFileSync("ps", [], { timeout: 5000 });\n`,
    "a timeout with SIGTERM": `import { spawnSync } from "node:child_process";\nexport const out = () => spawnSync("ps", [], { timeout: 5000, killSignal: "SIGTERM" });\n`,
    "a kill signal in a variable": `import { execSync } from "node:child_process";\nconst killSignal = "SIGKILL";\nexport const out = () => execSync("ps", { timeout: 5000, killSignal });\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(soft)) {
      const [message, ...rest] = await lint(code, place, syncCommandRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, /killSignal: "SIGKILL"/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
  const bounded = [
    `import { execFileSync } from "node:child_process";\nexport const out = () => execFileSync("ps", [], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });\n`,
    `import { spawnSync } from "node:child_process";\nconst timeout = 5000;\nexport const out = () => spawnSync("ps", ["-p", "1"], { timeout, killSignal: "SIGKILL" });\n`,
    `import { execSync } from "node:child_process";\nexport const out = () => execSync("ps", { timeout: 5000, "killSignal": "SIGKILL" });\n`,
    // child_process가 아닌 같은 이름의 함수는 대상이 아니다.
    `const execFileSync = (name: string) => name;\nexport const out = () => execFileSync("ps");\n`,
    // 가져온 이름을 지역 매개변수가 가리거나, 지역 객체의 같은 이름 메서드는 그 함수가 아니다(#266 리뷰 SPEC-4).
    `import { execFileSync } from "node:child_process";\nvoid execFileSync;\nexport const out = (execFileSync: (name: string) => string) => execFileSync("ps");\n`,
    `const fake = { spawnSync: (name: string) => name };\nexport const out = () => fake.spawnSync("ps");\n`,
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

const unreadableRule = ["product/no-io-in-unreadable"];
const unreadableImport = `import { orIfUnreadable } from "@babojubot/contracts";\n`;

/** orIfUnreadable 콜백 안의 입출력. 제품 코드와 개발 스크립트가 같은 모양을 받는다(scripts/script-lint-rules.test.mjs). */
const unreadableIo = {
  "a file read": `import { readFileSync } from "node:fs";\n${unreadableImport}export const read = (file) => orIfUnreadable(() => JSON.parse(readFileSync(file, "utf8")), undefined);\n`,
  "a file read on the module": `import fs from "node:fs";\n${unreadableImport}export const read = (file) => orIfUnreadable(() => fs.readFileSync(file, "utf8").split(" ")[19], undefined);\n`,
  "a nested sync call": `import fs from "node:fs";\n${unreadableImport}export const same = (a, b) => orIfUnreadable(() => fs.realpathSync.native(a) === b, false);\n`,
  "a file status": `import { statSync } from "node:fs";\n${unreadableImport}export const big = (file) => orIfUnreadable(() => statSync(file).size > 10, false);\n`,
  "a command": `import { execFileSync } from "node:child_process";\n${unreadableImport}export const start = (pid) => orIfUnreadable(() => execFileSync("ps", ["-p", String(pid)], { timeout: 1000 }), undefined);\n`,
  "a spawned command": `import { spawnSync } from "node:child_process";\n${unreadableImport}export const start = () => orIfUnreadable(() => spawnSync("ps", [], { timeout: 1000 }).stdout, undefined);\n`,
  "a child_process exec": `import { exec } from "node:child_process";\n${unreadableImport}export const run = () => orIfUnreadable(() => exec("ps"), undefined);\n`,
  "a database opened": `import { DatabaseSync } from "node:sqlite";\n${unreadableImport}export const open = (file) => orIfUnreadable(() => new DatabaseSync(file), undefined);\n`,
  "a connection": `${unreadableImport}export const check = (client) => orIfUnreadable(() => client.connect(), false);\n`,
  "a request": `${unreadableImport}export const check = (connection) => orIfUnreadable(() => connection.request("thread/read", {}), false);\n`,
  "a fetch": `${unreadableImport}export const check = (url) => orIfUnreadable(() => fetch(url), undefined);\n`,
  "a name lookup": `import { lookup } from "node:dns/promises";\n${unreadableImport}export const check = (host) => orIfUnreadable(() => lookup(host), undefined);\n`,
  "a response body": `${unreadableImport}export const body = (res) => orIfUnreadable(() => res.json(), undefined);\n`,
  "a file write": `import { writeFileSync } from "node:fs";\n${unreadableImport}export const save = (file) => orIfUnreadable(() => writeFileSync(file, "x"), undefined);\n`,
  "an async callback": `${unreadableImport}export const check = (work) => orIfUnreadable(async () => work, false);\n`,
  "an await": `import { readFile } from "node:fs/promises";\n${unreadableImport}export const read = async (file) => orIfUnreadable(async () => JSON.parse(await readFile(file, "utf8")), undefined);\n`,
  "a renamed import": `import { readFileSync } from "node:fs";\nimport { orIfUnreadable as parsed } from "@babojubot/contracts";\nexport const read = (file) => parsed(() => readFileSync(file, "utf8"), undefined);\n`,
  "a namespace import": `import { readFileSync } from "node:fs";\nimport * as failure from "@babojubot/contracts";\nexport const read = (file) => failure.orIfUnreadable(() => readFileSync(file, "utf8"), undefined);\n`,
  "a callback passed by name": `${unreadableImport}const parse = () => JSON.parse("1");\nexport const read = () => orIfUnreadable(parse, undefined);\n`,
  // 출처로 본다: const 별칭(#266 리뷰 SPEC-4).
  "a const alias": `import { readFileSync } from "node:fs";\n${unreadableImport}const parsed = orIfUnreadable;\nexport const read = (file) => parsed(() => readFileSync(file, "utf8"), undefined);\n`,
  // 공용 가져오기 판정: dynamic import에서 구조 분해한 이름도 같다(#266 리뷰 SPEC-1).
  "a name taken from a dynamic import": `import { readFileSync } from "node:fs";\nconst { orIfUnreadable: parsed } = await import("@babojubot/contracts");\nexport const read = (file) => parsed(() => readFileSync(file, "utf8"), undefined);\n`,
};

/** 이미 손에 든 값의 동기 해석·확인 한 단계. 정규식의 exec는 명령이 아니다. */
const unreadableKept = [
  // 가져온 이름을 지역 매개변수가 가리거나, 지역 객체의 같은 이름 메서드는 그 함수가 아니다(#266 리뷰 SPEC-4).
  `import { readFileSync } from "node:fs";\n${unreadableImport}void orIfUnreadable;\nexport const read = (orIfUnreadable, file) => orIfUnreadable(() => readFileSync(file, "utf8"), undefined);\n`,
  `import { readFileSync } from "node:fs";\nconst tools = { orIfUnreadable: (read) => read() };\nexport const read = (file) => tools.orIfUnreadable(() => readFileSync(file, "utf8"));\n`,
  `${unreadableImport}export const read = (text) => orIfUnreadable(() => JSON.parse(text), undefined);\n`,
  `${unreadableImport}export const host = (origin) => orIfUnreadable(() => new URL(origin).host, false);\n`,
  `${unreadableImport}export const decode = (bytes) => orIfUnreadable(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes), undefined);\n`,
  `${unreadableImport}export const claims = (token) => orIfUnreadable(() => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")), undefined);\n`,
  `${unreadableImport}export const uid = (status) => orIfUnreadable(() => Number(/^Uid:\\s+(\\d+)/m.exec(status)[1]), undefined);\n`,
  `${unreadableImport}export const valid = (schema, text) => orIfUnreadable(() => schema.safeParse(JSON.parse(text)), undefined);\n`,
  // 입출력은 콜백 밖에서 하고, 확인 호출은 원인을 남기는 함수로 감싼다.
  `import { readFileSync } from "node:fs";\nimport { hasErrorCode, orIfMissing, orIfProbeFailed, orIfUnreadable } from "@babojubot/contracts";\nexport const read = (file, report) => {\n  const text = orIfMissing(() => readFileSync(file, "utf8"), hasErrorCode("ENOENT"), undefined);\n  const start = orIfProbeFailed(() => readFileSync("/proc/1/stat", "utf8"), undefined, report);\n  return [text === undefined ? undefined : orIfUnreadable(() => JSON.parse(text), undefined), start];\n};\n`,
];

test("orIfUnreadable callbacks do no I/O in product code", async () => {
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(unreadableIo)) {
      const messages = await lint(code, place, unreadableRule);
      assert.ok(messages.length > 0, `${place}: ${shape} not reported`);
      // 이유와 쓸 함수, 작성 기준을 안내한다.
      for (const { message } of messages) {
        assert.match(message, /orIfProbeFailed/);
        assert.match(message, /orIfMissing/);
        assert.match(message, /CODING_STANDARDS\.md#제품-코드/);
      }
    }
  for (const place of productPlaces)
    for (const code of unreadableKept)
      assert.deepEqual(
        await lint(code, place, unreadableRule),
        [],
        `${place}: ${code}`
      );
  for (const place of testPlaces)
    for (const code of Object.values(unreadableIo))
      assert.deepEqual(
        await lint(code, place, unreadableRule),
        [],
        `${place}: ${code}`
      );
});

// orIfUnreadable은 경로 철자가 아니라 대상 파일로 본다(공용 판정의 targetOf, #266 리뷰 SPEC-5): contracts의 failure.ts를 패키지
// 이름·하위 입구·상대 경로 어느 것으로 가리켜도 같고, 다른 파일의 같은 이름 함수는 아니다(그 파일 이름이 failure.ts여도).
test("orIfUnreadable is told by the file it comes from, not by how the path is spelled", async () => {
  const body = `export const read = (file) => orIfUnreadable(() => readFileSync(file, "utf8"), undefined);\n`;
  const read = `import { readFileSync } from "node:fs";\n`;
  const reported = [
    ["apps/server/src/app.ts", "../../../packages/contracts/src/failure.ts"],
    ["packages/core/src/harness.ts", "../../contracts/src/failure.ts"],
    ["packages/contracts/src/index.ts", "./failure.ts"],
    ["packages/contracts/src/index.ts", "./failure"],
    ["packages/core/src/harness.ts", "@babojubot/contracts/failure"],
  ];
  for (const [place, source] of reported)
    assert.ok(
      (
        await lint(
          `${read}import { orIfUnreadable } from "${source}";\n${body}`,
          place,
          unreadableRule
        )
      ).length > 0,
      `${place}: ${source} not reported`
    );
  const kept = [
    ["apps/server/src/app.ts", "./failure.ts"],
    ["packages/core/src/harness.ts", "./failure"],
    ["packages/runtime/src/providers/claude.ts", "../failure.ts"],
  ];
  for (const [place, source] of kept)
    assert.deepEqual(
      await lint(
        `${read}import { orIfUnreadable } from "${source}";\n${body}`,
        place,
        unreadableRule
      ),
      [],
      `${place}: ${source}`
    );
});

test("product code does not drop the error an error listener or an error-first callback receives", async () => {
  const dropped = {
    "an error listener without a parameter": `export const watch = (socket) => socket.on("error", () => socket.destroy());\n`,
    "an empty once error listener": `export const watch = (socket) => socket.once("error", () => {});\n`,
    "an error listener that names the error and does not use it": `export const watch = (socket) => socket.on("error", (error) => {\n  socket.destroy();\n});\n`,
    "an underscored error listener": `export const watch = (socket) => socket.addListener("error", (_error) => socket.destroy());\n`,
    "a prepended error listener": `export const watch = (socket) => socket.prependListener("error", function () {\n  socket.destroy();\n});\n`,
    "an execFile callback without a parameter": `import { execFile } from "node:child_process";\nexport const stop = (pid) => execFile("taskkill", ["/PID", String(pid)], { timeout: 1000 }, () => {});\n`,
    "an execFile callback that ignores the error": `import { execFile } from "node:child_process";\nexport const ask = (resolve) => execFile("ps", [], { timeout: 1000 }, (error, stdout) => resolve(stdout));\n`,
    "a server close callback without a parameter": `export const stop = (server) => new Promise((resolve) => server.close(() => resolve()));\n`,
    "a pipeline callback without a parameter": `import { pipeline } from "node:stream";\nexport const copy = (from, to, done) => pipeline(from, to, () => done());\n`,
    "a stream end callback without a parameter": `export const finish = (log, code) => log.end(() => process.exit(code));\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(dropped)) {
      const [message, ...rest] = await lint(code, place, ignoredErrorRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 끊김을 고르는 함수와 작성 기준을 안내한다.
      assert.match(message.message, /isDisconnect/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
  const kept = [
    // 상대가 끊은 것만 넘기고 그 밖의 오류는 원인을 남긴다.
    `import { failureCode, isDisconnect } from "@babojubot/contracts";\nexport const watch = (socket) =>\n  socket.on("error", (error) => {\n    if (!isDisconnect(error)) console.warn(\`socket failed (\${failureCode(error)})\`);\n    socket.destroy();\n  });\n`,
    `export const listen = (server, reject) => server.once("error", reject);\n`,
    `export const stop = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));\n`,
    `import { execFile } from "node:child_process";\nexport const ask = (resolve, reject) => execFile("ps", [], { timeout: 1000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));\n`,
    // 다른 오류를 던지는 한 문장뿐인 처리, 오류가 아닌 이벤트, 오류를 넘기지 않는 콜백은 보지 않는다.
    `export const watch = (socket) => socket.on("error", () => {\n  throw new Error("socket failed");\n});\n`,
    `export const watch = (socket, done) => socket.on("close", () => done());\n`,
    `export const start = (server, ready) => server.listen(0, "127.0.0.1", () => ready());\n`,
    `export const close = (db) => db.close();\n`,
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

const exitRule = ["product/no-silent-exit-status"];

test("product code does not fold a non-zero exit of an outside command into an empty result", async () => {
  const folded = {
    "an empty string on failure": `import { spawnSync } from "node:child_process";\nexport const start = (pid) => {\n  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 1000, encoding: "utf8" });\n  return result.status === 0 ? result.stdout.trim() : "";\n};\n`,
    "undefined on failure": `export const text = (result) => (result.status !== 0 ? undefined : result.stdout);\n`,
    "an early return on failure": `export const list = (listed) => {\n  if (listed.code !== 0) return;\n  return listed.stdout.split("\\n");\n};\n`,
    "an empty list on failure": `export const list = (listed) => {\n  if (listed.code !== 0) {\n    return [];\n  }\n  return listed.stdout.split("\\n");\n};\n`,
    "false in the else branch": `export const running = (result) => {\n  if (result.status === 0) return true;\n  else return false;\n};\n`,
  };
  for (const place of productPlaces)
    for (const [shape, code] of Object.entries(folded)) {
      const [message, ...rest] = await lint(code, place, exitRule);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, /없음/);
      assert.match(message.message, /CODING_STANDARDS\.md#제품-코드/);
    }
  const kept = [
    // 그 명령의 "없음" 계약만 그 코드로 고르고, 나머지는 원인과 함께 던진다.
    `export const pids = (result) => {\n  if (result.status === 1) return [];\n  if (result.status !== 0) throw new Error(\`pgrep failed (exit \${result.status}): \${result.stderr}\`);\n  return result.stdout.split("\\n");\n};\n`,
    `const gone = (result) => result.status === 1 && !result.stdout && !result.stderr;\nexport const field = (result) => {\n  if (gone(result)) return undefined;\n  if (result.status !== 0) throw new Error(\`ps failed (exit \${result.status})\`);\n  return result.stdout.trim();\n};\n`,
    // 성공 쪽이 빈 값인 것은 접는 것이 아니다.
    `export const problem = (code, output) => (code === 0 ? undefined : \`compiler ended with code \${code}: \${output}\`);\n`,
    `export const text = (result) => (result.status === 0 ? result.stdout : \`unknown (\${result.stderr})\`);\n`,
    // HTTP 상태처럼 0과 견주지 않는 비교는 보지 않는다.
    `export const ok = (res) => (res.status === 200 ? res.body : undefined);\n`,
  ];
  for (const place of productPlaces)
    for (const code of kept)
      assert.deepEqual(
        await lint(code, place, exitRule),
        [],
        `${place}: ${code}`
      );
  for (const place of testPlaces)
    for (const code of Object.values(folded))
      assert.deepEqual(
        await lint(code, place, exitRule),
        [],
        `${place}: ${code}`
      );
});

const importRule = ["product/no-undeclared-import"];

test("product code imports only the packages its package.json declares, as runtime dependencies", async () => {
  // packages/runtime: zod는 dependencies, vitest는 devDependencies, left-pad는 선언되지 않았다.
  const place = "packages/runtime/src/providers/claude.ts";
  const reported = {
    "a dev-only package": [
      `import { expect } from "vitest";\nexport const check = () => expect(1).toBe(1);\n`,
      /devDependencies/,
    ],
    "a dev-only package re-exported": [
      `export { expect } from "vitest";\n`,
      /devDependencies/,
    ],
    "an undeclared package": [
      `import pad from "left-pad";\nexport const padded = pad("1", 3);\n`,
      /선언하지 않고/,
    ],
    "an undeclared package by a deep path": [
      `import { pad } from "left-pad/lib/pad.js";\nexport const padded = pad("1", 3);\n`,
      /선언하지 않고/,
    ],
    "an undeclared scoped package": [
      `export * from "@scope/missing";\n`,
      /선언하지 않고/,
    ],
    "an undeclared dynamic import": [
      `export const load = () => import("left-pad");\n`,
      /선언하지 않고/,
    ],
    // 공용 가져오기 판정: require·require.resolve로 불러오거나 찾는 패키지도 같다(#266 리뷰 SPEC-1).
    "an undeclared package taken by require": [
      `export const pad = require("left-pad");\n`,
      /선언하지 않고/,
    ],
    "a dev-only package resolved": [
      `export const where = require.resolve("vitest");\n`,
      /devDependencies/,
    ],
  };
  for (const [shape, [code, kind]] of Object.entries(reported)) {
    const [message, ...rest] = await lint(code, place, importRule);
    assert.ok(message, `${shape} not reported`);
    assert.deepEqual(rest, [], shape);
    assert.match(message.message, kind, shape);
    assert.match(message.message, /packages\/runtime\/package\.json/, shape);
  }
  const kept = [
    `import { z } from "zod";\nexport const schema = z.string();\n`,
    // 타입만 가져오면 실행에 남지 않는다.
    `import type { Mock } from "vitest";\nexport type M = Mock;\n`,
    `import { type Mock } from "vitest";\nexport type M = Mock;\n`,
    // Node 기본 모듈, 상대 경로, 자기 패키지, 선언한 workspace 패키지.
    `import { readFileSync } from "node:fs";\nimport path from "path";\nimport { record } from "./record.ts";\nexport const read = (p: string) => record(readFileSync(path.join(p), "utf8"));\n`,
    `export { removeFolder } from "@babojubot/process/remove-folder";\n`,
    `import { failureCode } from "@babojubot/contracts";\nexport const code = failureCode;\n`,
  ];
  for (const code of kept)
    assert.deepEqual(await lint(code, place, importRule), [], code);
  // 시험 코드는 devDependencies까지 받는다. 선언하지 않은 패키지만 막는다.
  for (const test of testPlaces) {
    assert.deepEqual(
      await lint(
        `import { expect } from "vitest";\nexport const check = () => expect(1).toBe(1);\n`,
        test,
        importRule
      ),
      [],
      test
    );
    const [message] = await lint(
      `import pad from "left-pad";\nexport const padded = pad("1", 3);\n`,
      test,
      importRule
    );
    assert.ok(message, `${test}: undeclared package not reported`);
  }
});
