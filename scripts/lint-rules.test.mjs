// 저장소 lint 설정(eslint.config.js)이 시험 코드 규칙과 예외 주석 규칙을 실제로 거는지 본다. 규칙의 조건에 오타가 나면
// 아무것도 잡지 않은 채 lint가 통과하므로, 잡아야 할 모양과 잡지 말아야 할 모양을 짧은 코드로 넣어 확인한다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { accessShapes } from "./lint-access-shapes.mjs";
import { ruleLinter } from "./lint-rule-testing.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
/** `filePath` 자리에 둔 `code`의 lint 결과 중 `rules`의 메시지(빼면 모든 메시지). 파일은 만들지 않는다. */
const lint = ruleLinter(repository);

/** 시험 코드로 보는 자리들. 규칙은 이 모든 자리에 걸려야 한다. */
const testPlaces = [
  "apps/server/test/lint-sample.test.ts",
  "apps/server/test/lint-sample-support.ts",
  // src 안과 E2E는 타입 정보로 검사하므로(TypeScript 프로젝트에 든 파일만) 있는 파일 자리를 빌린다.
  "apps/web/e2e/support/organization.ts",
  "packages/db/src/client.test.ts",
  "scripts/lint-sample.test.mjs",
];

const folderRemovals = {
  "rm with recursive": `import { rm } from "node:fs/promises";\nawait rm("dir", { recursive: true, force: true });\n`,
  "rmSync with recursive": `import { rmSync } from "node:fs";\nrmSync("dir", { recursive: true });\n`,
  "rmdir with recursive": `import { rmdir } from "node:fs/promises";\nawait rmdir("dir", { recursive: true });\n`,
  "fs.rmSync": `import fs from "node:fs";\nfs.rmSync("dir", { force: true, recursive: true });\n`,
  "fsp.rm": `import fsp from "node:fs/promises";\nawait fsp.rm("dir", { recursive: true, force: true });\n`,
  "fs.promises.rm": `import fs from "node:fs";\nawait fs.promises.rm("dir", { recursive: true });\n`,
  // rmdir은 recursive 없이도 빈 폴더를 지운다.
  "rmdir without options": `import { rmdir } from "node:fs/promises";\nawait rmdir("dir");\n`,
  "rmdirSync without options": `import { rmdirSync } from "node:fs";\nrmdirSync("dir");\n`,
  "fs.rmdirSync": `import fs from "node:fs";\nfs.rmdirSync("dir");\n`,
  "fs.rmdir with a callback": `import fs from "node:fs";\nfs.rmdir("dir", () => {});\n`,
  "fsp.rmdir": `import fsp from "node:fs/promises";\nawait fsp.rmdir("dir");\n`,
};

/** 폴더 지우기 규칙의 메시지만. */
const removalRules = ["no-restricted-syntax"];

for (const [shape, code] of Object.entries(folderRemovals))
  test(`test code may not remove a folder by ${shape}`, async () => {
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, removalRules);
      assert.ok(message, `${place}: not reported`);
      assert.deepEqual(rest, [], place);
      // 메시지가 대안과 기준 문서의 절을 알려 준다.
      assert.match(
        message.message,
        /removeFolder\(@babojubot\/process\/remove-folder\)/
      );
      assert.match(message.message, /CODING_STANDARDS\.md#정리/);
    }
  });

test("test code may not import a remover from fs under another name", async () => {
  for (const code of [
    `import { rm as remove } from "node:fs/promises";\nawait remove("dir", { recursive: true });\n`,
    `import { rmSync as wipe } from "fs";\nwipe("dir", { recursive: true });\n`,
    `import { rmdir as drop } from "node:fs";\ndrop("dir", () => {});\n`,
  ]) {
    const messages = await lint(
      code,
      "apps/server/test/lint-sample.test.ts",
      removalRules
    );
    assert.equal(messages.length, 1, code);
    assert.match(messages[0].message, /이름 그대로 가져오세요/);
    assert.match(messages[0].message, /CODING_STANDARDS\.md#정리/);
  }
});

test("test code may remove files, use recursive elsewhere and call removeFolder", async () => {
  const allowed = [
    // 파일 하나 지우기는 폴더 잠김과 다른 일이다.
    `import { rm } from "node:fs/promises";\nawait rm("file");\nawait rm("file", { force: true });\n`,
    `import fs from "node:fs";\nfs.rmSync("file", { force: true });\n`,
    // 같은 recursive를 쓰는 다른 함수.
    `import { cp, mkdir, readdir } from "node:fs/promises";\nawait mkdir("dir", { recursive: true });\nawait cp("a", "b", { recursive: true });\nawait readdir("dir", { recursive: true });\n`,
    // 이름 그대로 가져오기, fs가 아닌 곳의 같은 이름.
    `import { rm } from "node:fs/promises";\nimport { rm as other } from "./elsewhere.mjs";\nawait rm("file");\nawait other("x");\n`,
    `import { removeFolder } from "@babojubot/process/remove-folder";\nawait removeFolder("dir");\nawait removeFolder("dir", { retries: 10, retryDelayMs: 200 });\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(await lint(code, place, removalRules), [], code);
});

test("a fake program outside tests may remove a folder directly", async () => {
  // 외부 프로그램을 흉내 내는 가짜 CLI는 시험 코드 규칙도 스크립트 규칙도 받지 않는다.
  assert.deepEqual(
    await lint(
      folderRemovals["rm with recursive"],
      "packages/runtime/test-fixtures/lint-sample.mjs",
      removalRules
    ),
    []
  );
});

/** 손으로 돌리는 스크립트 자리들. 시험이 아닌 스크립트도 폴더를 상한 안에서 지운다(#286 PR 3b-3b-1). */
const scriptPlaces = [
  "scripts/lint-sample.mjs",
  "scripts/live/lint-sample.mjs",
  ".agents/scripts/lint-sample.mjs",
];

// 이 시험이 바꾼 것: 예전에는 scripts의 recursive 지우기를 허용한다고 단언했다(위 시험의 scripts 두 자리). 스크립트의 지우기도
// 상한 없이 매달리거나 끝을 확인하지 않은 폴더를 지우는 모양이 되므로(chaos-live·chaos-run·chaos-server·boot-check), 스크립트에도
// 같은 규칙을 걸고 그 단언을 이 시험으로 옮겼다.
for (const [shape, code] of Object.entries(folderRemovals))
  test(`a script may not remove a folder by ${shape}`, async () => {
    for (const place of scriptPlaces) {
      const [message, ...rest] = await lint(code, place, removalRules);
      assert.ok(message, `${place}: not reported`);
      assert.deepEqual(rest, [], place);
      assert.match(
        message.message,
        /removeFolderWithin\(@babojubot\/process\/test-cleanup\)/
      );
      assert.match(message.message, /CODING_STANDARDS\.md#정리/);
    }
  });

test("a script may not import a remover from fs under another name", async () => {
  for (const place of scriptPlaces) {
    const messages = await lint(
      `import { rm as remove } from "node:fs/promises";\nawait remove("dir", { recursive: true });\n`,
      place,
      removalRules
    );
    assert.equal(messages.length, 1, place);
    assert.match(messages[0].message, /이름 그대로 가져오세요/);
  }
});

test("a script may remove files and call removeFolderWithin", async () => {
  for (const place of scriptPlaces)
    assert.deepEqual(
      await lint(
        `import { rm } from "node:fs/promises";\nimport { removeFolderWithin } from "@babojubot/process/test-cleanup";\nawait rm("file", { force: true });\nawait removeFolderWithin("dir", { retries: 5 });\n`,
        place,
        removalRules
      ),
      [],
      place
    );
});

// 주석은 lint 규칙을 바꾸지 못한다(#270). 주석 한 줄로 파일 전체·구간·줄에서 규칙을 끄거나 경고로 낮추면 그 위반이 사라지고, 주석의 설정은
// 설정 파일보다 우선해 막는 규칙까지 같은 주석으로 끌 수 있다. 예외는 eslint.config.js에 파일·규칙을 좁혀 이유와 함께 둔다.
// 시험 코드는 시험 규칙(`tests/no-fixed-time-wait`)으로, 제품 코드·스크립트는 모든 코드가 받는 규칙(`no-empty-pattern`)으로 본다.
const sleep = "await new Promise((resolve) => setTimeout(resolve, 50));\n";
const commentedAreas = [
  { places: testPlaces, rule: "tests/no-fixed-time-wait", violation: sleep },
  {
    places: [
      "scripts/lint-sample.mjs",
      "packages/core/src/lint-sample.ts",
      "apps/web/src/lint-sample.tsx",
    ],
    rule: "no-empty-pattern",
    violation: "const {} = {};\n",
  },
];
const directive = "@eslint-community/eslint-comments/no-use";
const liftingComments = {
  "lowers a rule to a warning": (rule, code) =>
    `/* eslint ${rule}: "warn" -- 이유 */\n${code}`,
  "turns a rule off": (rule, code) =>
    `/* eslint ${rule}: "off" -- 이유 */\n${code}`,
  "turns off the rule that bans such comments first": (rule, code) =>
    `/* eslint ${directive}: "off", ${rule}: "off" -- 이유 */\n${code}`,
  "disables a rule to the end of the file": (rule, code) =>
    `/* eslint-disable ${rule} -- 이유 */\n${code}`,
  "disables every rule to the end of the file": (rule, code) =>
    `/* eslint-disable */\n${code}`,
  "disables a rule over a range": (rule, code) =>
    `/* eslint-disable ${rule} -- 이유 */\n${code}/* eslint-enable ${rule} -- 이유 */\n`,
  "disables a rule on the next line": (rule, code) =>
    `// eslint-disable-next-line ${rule} -- 이유\n${code}`,
  "disables a rule on its line": (rule, code) =>
    `${code.trimEnd()} // eslint-disable-line ${rule} -- 이유\n`,
};

for (const [shape, comment] of Object.entries(liftingComments))
  test(`a comment that ${shape} does not lift the rule`, async () => {
    for (const { places, rule, violation } of commentedAreas)
      for (const place of places) {
        const code = comment(rule, violation);
        const messages = await lint(code, place, [rule, directive]);
        assert.deepEqual(
          messages.filter((m) => m.ruleId === rule).map((m) => m.severity),
          [2],
          `${place}: ${code}`
        );
        // 효과 없는 주석도 남지 않게 오류로 짚는다(본보기로 베껴지지 않게).
        assert.ok(
          messages.some((m) => m.ruleId === directive && m.severity === 2),
          `${place}: the comment is not reported`
        );
      }
  });

// no-use가 알아보는 지시 주석 종류 전부(@eslint-community/eslint-plugin-eslint-comments 4.8.1 `lib/internal/utils.js`의
// DIRECTIVE_PATTERN, https://eslint-community.github.io/eslint-plugin-eslint-comments/rules/no-use.html). 블록 주석이면 모두, 줄 주석이면
// 두 `-line` 종류만 지시 주석이다(같은 파일의 LINE_COMMENT_PATTERN). ESLint가 지시 주석으로 읽는 것(주석 설정을 읽지 않을 때 "has no
// effect"로 알림)과 no-use가 짚는 것이 모양마다 같아야, ESLint가 새로 읽는 모양이 생겨도 효과 없는 주석이 오류 없이 남지 않는다.
const directiveKinds = {
  eslint: 'eslint no-empty-pattern: "off"',
  "eslint-env": "eslint-env browser",
  "eslint-enable": "eslint-enable no-empty-pattern",
  "eslint-disable": "eslint-disable no-empty-pattern",
  "eslint-disable-line": "eslint-disable-line no-empty-pattern",
  "eslint-disable-next-line": "eslint-disable-next-line no-empty-pattern",
  exported: "exported answer",
  global: "global answer",
  globals: "globals answer",
};

test("every directive comment ESLint reads is reported in every code area, and only those", async () => {
  const eslint = new ESLint({
    cwd: repository,
    ruleFilter: ({ ruleId }) => ruleId === directive,
    overrideConfig: [
      {
        languageOptions: {
          parserOptions: { projectService: false, project: null },
        },
      },
    ],
  });
  const places = [
    ...testPlaces,
    "scripts/lint-sample.mjs",
    "packages/core/src/lint-sample.ts",
    "apps/web/src/lint-sample.tsx",
  ];
  const wrong = [];
  let read = 0;
  for (const place of places)
    for (const [kind, text] of Object.entries(directiveKinds))
      for (const comment of [`/* ${text} -- 이유 */`, `// ${text} -- 이유`]) {
        const [result] = await eslint.lintText(
          `${comment}\nexport const a = 1;\n`,
          { filePath: place }
        );
        assert.ok(result, `${place}: no lint result`);
        const reported = result.messages.some((m) => m.ruleId === directive);
        const eslintReads = result.messages.some(
          (m) => m.ruleId === null && /has no effect/.test(m.message)
        );
        if (eslintReads) read += 1;
        if (reported !== eslintReads)
          wrong.push(
            `${place} ${kind} ${comment}: no-use ${reported}, ESLint reads ${eslintReads}`
          );
      }
  assert.deepEqual(wrong, []);
  // 아홉 종류의 블록 주석과 두 `-line` 종류의 줄 주석: 자리마다 11개.
  assert.equal(read, places.length * 11);
});

test("a comment does not declare a global", async () => {
  const code = "/* global answer -- 이유 */\nexport const a = answer;\n";
  const messages = await lint(code, "scripts/lint-sample.mjs", [
    "no-undef",
    directive,
  ]);
  assert.deepEqual(messages.map((m) => m.ruleId).sort(), [
    directive,
    "no-undef",
  ]);
});

test("a Playwright fixture may take its dependencies as an empty pattern in test code without an exception", async () => {
  const fixture = `export const fixtures = { baseURL: async ({}, use) => {\n  await use("http://127.0.0.1");\n} };\n`;
  for (const place of testPlaces)
    assert.deepEqual(
      await lint(fixture, place, ["no-empty-pattern"]),
      [],
      place
    );
  // 매개변수가 아닌 빈 분해는 그대로 짚는다.
  for (const place of testPlaces)
    assert.equal(
      (await lint("const {} = {};\n", place, ["no-empty-pattern"])).length,
      1,
      place
    );
});

// NUL을 일부러 담는 정규식은 도구 정의의 pattern으로 나가는 nulFree 하나다. 그 파일 전체에서 no-control-regex를 끄면 같은 파일에 더한
// 다른 제어 문자 정규식도 짚지 않는다(#286 항목 25). 그 파일은 그 선언 하나만 담을 수 있어 예외가 그 정규식 하나만 덮는다.
const controlRegexRules = ["no-control-regex", "product/nul-free-file-shape"];
const nulFreeDeclaration = "export const nulFree = /^[^\\x00]*$/;\n";

test("a regex may hold a control character only as the NUL-free pattern itself", async () => {
  assert.deepEqual(
    await lint(
      nulFreeDeclaration,
      "packages/contracts/src/nul-free.ts",
      controlRegexRules
    ),
    []
  );
  for (const place of [
    "packages/contracts/src/task.ts",
    "scripts/lint-sample.mjs",
    ...testPlaces,
  ])
    assert.equal(
      (await lint(nulFreeDeclaration, place, controlRegexRules)).length,
      1,
      place
    );
});

test("the file of the NUL-free pattern reports anything beside the pattern, any other control-character regex included", async () => {
  for (const extra of [
    "export const plain = /a/;\n",
    "export const unitSeparator = /\\x1f/;\n",
    "const nulFree2 = /^[^\\x00]*$/;\n",
    'export const fromText = new RegExp("\\\\x00");\n',
    "export const flagged = /^[^\\x00]*$/u;\n",
  ])
    assert.equal(
      (
        await lint(
          nulFreeDeclaration + extra,
          "packages/contracts/src/nul-free.ts",
          controlRegexRules
        )
      ).length,
      1,
      extra
    );
});

/** 경과 시간 단언 규칙의 메시지만. */
const elapsedRules = ["tests/no-elapsed-time-assertion"];

test("test code may not assert real elapsed time", async () => {
  const asserted = {
    "expect on the difference": `expect(Date.now() - started).toBeLessThan(5000);\n`,
    "performance.now": `expect(performance.now() - started).toBeLessThan(5000);\n`,
    "assert.ok on a comparison": `assert.ok(Date.now() - started < 5000);\n`,
    "assert on a comparison": `assert(Date.now() - started < 5000);\n`,
    "the expected side": `expect(5000).toBeGreaterThan(Date.now() - started);\n`,
    "a rounded value": `expect(Math.round((Date.now() - started) / 1000)).toBe(0);\n`,
    // 변수에 담았다 비교하는 우회.
    "a variable": `const elapsed = Date.now() - started;\nexpect(elapsed).toBeLessThan(5000);\n`,
    "a reassigned variable": `let elapsed = 0;\nelapsed = Date.now() - started;\nassert.ok(elapsed < 5000);\n`,
    "a value computed from a variable": `const ms = Date.now() - started;\nconst seconds = ms / 1000;\nexpect(seconds).toBeLessThan(5);\n`,
    // 두 시각을 따로 담아 빼는 우회(외부 리뷰 SPEC-A).
    "two stored times": `const started = Date.now();\nconst finished = Date.now();\nexpect(finished - started).toBeLessThan(500);\n`,
    "a reassigned stored time": `let started = 0;\nlet finished = 0;\nstarted = performance.now();\nfinished = performance.now();\nassert.ok(finished - started < 500);\n`,
    // 시계는 이름이 아니라 출처로 본다: 이름을 바꿔 가져온 node:perf_hooks의 performance(#266 리뷰 SPEC-2).
    "performance from perf_hooks under another name": `import { performance as perf } from "node:perf_hooks";\nconst started = perf.now();\nexpect(perf.now() - started).toBeLessThan(500);\n`,
  };
  for (const [shape, code] of Object.entries(asserted))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, elapsedRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 대안과 기준 문서의 절을 알려 준다.
      assert.match(message.message, /manualClock/);
      assert.match(message.message, /순서·상태/);
      assert.match(message.message, /CODING_STANDARDS\.md#시간/);
    }
});

test("test code may make past times, log or record durations, wait to a deadline and assert a fake clock", async () => {
  const allowed = [
    // 지난 시각을 데이터로 만든다.
    `expect(isExpired({ expiry: new Date(Date.now() - 60_000).toISOString() })).toBe(true);\n`,
    `expect(judge({ deadlineAt: Date.now() - 1 })).toBe("expired");\n`,
    `const serverNow = () => new Date(Date.now() - 5 * 60_000);\nexpect(serverNow()).toBeDefined();\n`,
    // 걸린 시간을 로그로 남기거나 측정값으로 기록한다(성능 측정).
    "console.log(`prepared in ${Date.now() - started} ms`);\n",
    `const openMs = Date.now() - opened;\nconsole.log(JSON.stringify({ openMs }));\n`,
    `const fps = () => Math.round((frames * 1000) / (Date.now() - t0));\nconsole.log(fps());\n`,
    // 시각 변수를 로그·데이터에만 쓰거나, 그 시각에서 상수를 빼 지난 시각을 만든다.
    "const finished = Date.now();\nconsole.log(`took ${finished - started} ms`);\nexpect(new Date(finished)).toBeDefined();\n",
    `const finished = Date.now();\nexpect(isExpired({ expiry: finished - 60_000 })).toBe(true);\nexpect(finished - 60_000).toBeLessThan(finished);\n`,
    // 대기의 상한과 남은 시간.
    `const deadline = Date.now() + 5000;\nwhile (Date.now() < deadline) await tick();\nawait wait(deadline - Date.now());\nexpect(done).toBe(true);\n`,
    // 가짜 시계의 시간은 시험이 정한다.
    `expect(clock.now() - begin).toBe(1000);\n`,
    // 같은 이름의 지역 값(가짜 시계)은 실제 시계가 아니다.
    `const performance = fakeClock;\nconst started = performance.now();\nexpect(performance.now() - started).toBe(1000);\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(await lint(code, place, elapsedRules), [], code);
});

test("code outside tests may assert elapsed time", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
  ])
    assert.deepEqual(
      await lint(
        `assert.ok(Date.now() - started < 5000);\n`,
        place,
        elapsedRules
      ),
      [],
      place
    );
});

/** 대역의 hoisted 칸 규칙의 메시지만. */
const hoistedRules = ["tests/hoisted-state-at-call"];
const hoistedHead = `import { vi } from "vitest";\nconst state = vi.hoisted(() => ({ seen: [], fails: undefined, release: undefined }));\n`;
/** `double`을 값으로 내보내는 모듈 대역(`vi.mock`의 factory). */
const mocked = (double) =>
  `${hoistedHead}vi.mock("node:fs/promises", async (importOriginal) => {\n  const real = await importOriginal();\n  ${double}\n  return { ...real, open: double };\n});\n`;

test("a module double may not look up state the tests swap after an await or in a callback that runs later", async () => {
  // 모양마다 걸리는 칸 참조의 수(다른 경로로 통과하지 않게 정확히 센다).
  const late = {
    "a read after an await": [
      `const double = async (file) => {\n  const handle = await real.open(file);\n  if (state.fails) throw state.fails;\n  return handle;\n};`,
      2,
    ],
    "a write after an await": [
      `const double = async (file) => {\n  const handle = await real.open(file);\n  state.seen.push(file);\n  return handle;\n};`,
      1,
    ],
    "a string property after an await": [
      `const double = async (file) => {\n  const handle = await real.open(file);\n  state["seen"].push(file);\n  return handle;\n};`,
      1,
    ],
    // 실행 순서로는 그 분기가 던지고 끝나도 글의 차례로 본다: 맞는 모양은 첫 await 전에 모두 잡기 하나다.
    "a read after an await in a branch that throws": [
      `const double = async (file) => {\n  if (file === "x") {\n    await real.open(file);\n    throw new Error("x");\n  }\n  state.seen.push(file);\n  return real.open(file);\n};`,
      1,
    ],
    "a read in a loop that awaits": [
      `const double = async (files) => {\n  for (const file of files) {\n    state.seen.push(file);\n    await real.open(file);\n  }\n};`,
      1,
    ],
    "a read after for await": [
      `const double = async (files) => {\n  for await (const file of files) void file;\n  return state.fails;\n};`,
      1,
    ],
    "a close callback": [
      `const double = (server, done) => server.close((error) => done(state.fails ?? error));`,
      1,
    ],
    "a then callback": [
      `const double = (file) => real.open(file).then((handle) => {\n  state.seen.push(file);\n  return handle;\n});`,
      1,
    ],
    "a Promise executor": [
      `const double = (file) => new Promise((resolve) => {\n  state.release = resolve;\n});`,
      1,
    ],
    "an array callback": [
      `const double = (files) => files.filter((file) => state.seen.includes(file));`,
      1,
    ],
    // 그릇 칸을 그대로 담은 별칭도 같은 칸이다(선언 별칭, 대입 별칭, 대역 안의 별칭).
    "an alias of the state": [
      `const kept = state;\n  const double = async (file) => {\n  const handle = await real.open(file);\n  kept.seen.push(file);\n  return handle;\n};`,
      1,
    ],
    "an alias assigned later": [
      `let kept;\n  kept = state;\n  const double = async (file) => {\n  const handle = await real.open(file);\n  kept.seen.push(file);\n  return handle;\n};`,
      1,
    ],
    "an alias taken inside the double": [
      `const double = async (file) => {\n  let kept;\n  kept = state;\n  const handle = await real.open(file);\n  kept.seen.push(file);\n  return handle;\n};`,
      1,
    ],
    // 칸을 읽는 도움을 await 뒤에 부르거나 콜백으로 넘긴다(#286 PR 3b-3b-2 설계 점검 1회차 [2]).
    "a helper called after an await": [
      `const fault = () => state.fails;\n  const double = async (file) => {\n  const handle = await real.open(file);\n  if (fault()) throw new Error("x");\n  return handle;\n};`,
      1,
    ],
    "a helper defined and called after an await": [
      `const double = async (file) => {\n  const handle = await real.open(file);\n  const later = () => state.seen.push(file);\n  later();\n  return handle;\n};`,
      1,
    ],
    "a helper passed by name as a callback": [
      `const record = (handle) => {\n    state.seen.push(handle);\n    return handle;\n  };\n  const double = (file) => real.open(file).then(record);`,
      1,
    ],
    // 가짜 함수 호출은 투명하다: 인수 자리에 둔 가짜 함수의 구현은 콜백이다(#286 PR 3b-3b-2 설계 점검 2회차 [3]).
    "a callback wrapped in vi.fn": [
      `const double = (file) => real.open(file).then(vi.fn((handle) => {\n  state.seen.push(handle);\n  return handle;\n}));`,
      1,
    ],
    "a named vi.fn passed as a callback": [
      `const record = vi.fn((handle) => state.seen.push(handle));\n  const double = (file) => real.open(file).then(record);`,
      1,
    ],
    // 아는 모양만 통과한다(외부 리뷰 1회차, 설계 점검): 아래는 모두 짚는다.
    "a read inside the awaited call": [
      `const double = async (file) => {\n  const handle = await real.open(state.seen.at(-1) ?? file);\n  return handle;\n};`,
      1,
    ],
    "a double returned by a double": [
      `const double = (file) => {\n  const handle = { read: async () => {\n    state.seen.push(file);\n    return real.readFile(file);\n  } };\n  return handle;\n};`,
      1,
    ],
    "a double wrapped in vi.fn": [
      `const double = vi.fn(async (file) => {\n  const { seen } = state;\n  const handle = await real.open(file);\n  seen.push(file);\n  return handle;\n});`,
      1,
    ],
    "a double given to mockImplementation": [
      `const double = vi.fn().mockImplementation(async (file) => {\n  const { fails } = state;\n  await real.open(file);\n  if (fails) throw fails;\n});`,
      1,
    ],
    // 만드는 함수(factory 몸에서 부르고 결과를 건넴)가 돌려준 안쪽 함수는 대역으로 판정받는다: await 뒤에 읽으면 짚는다.
    "an inner function a maker returns, reading after its await": [
      `const wrap = (call) => async (...args) => {\n  const result = await call(...args);\n  if (state.fails) throw state.fails;\n  return result;\n};\n  const double = wrap(real.open);`,
      2,
    ],
    // 만드는 함수를 대역 안에서 부르면(결과를 건네지 않음) 그 안쪽 함수는 대역이 아니다.
    "an inner function a maker returns inside a double": [
      `const wrap = (call) => async (...args) => {\n  const { fails } = state;\n  const result = await call(...args);\n  if (fails) throw fails;\n  return result;\n};\n  const double = async (file) => wrap(real.open)(file);`,
      1,
    ],
    "a method of an object passed as an argument": [
      `const double = () => new Proxy({}, { get() {\n  const { fails } = state;\n  return fails;\n} });`,
      1,
    ],
    "a method of a named object passed as an argument": [
      `const sink = { write(chunk) {\n  state.seen.push(chunk);\n} };\n  const double = () => new Proxy({}, sink);`,
      1,
    ],
    "a helper called before the first await": [
      `const fault = () => state.fails;\n  const double = async (file) => {\n  const failure = fault();\n  const handle = await real.open(file);\n  if (failure) throw failure;\n  return handle;\n};`,
      1,
    ],
    "an alias of a helper": [
      `const fault = () => state.fails;\n  const later = fault;\n  const double = async (file) => {\n  await real.open(file);\n  return later();\n};`,
      1,
    ],
    "a helper in an object property": [
      `const helpers = { fault: () => state.fails };\n  const double = async (file) => {\n  await real.open(file);\n  return helpers.fault();\n};`,
      1,
    ],
    "a class method another method calls": [
      `class Server {\n  async close() {\n    await work();\n    return this.check();\n  }\n  check() {\n    return state.fails;\n  }\n}\n  const double = () => new Server();`,
      1,
    ],
    "a helper wrapped in vi.fn": [
      `const fault = vi.fn(() => state.fails);\n  const double = async (file) => {\n  await real.open(file);\n  return fault();\n};`,
      1,
    ],
    "the state handed on as a value": [
      `const pick = (source) => () => source.fails;\n  const double = async (file) => {\n  const fail = pick(state);\n  await real.open(file);\n  return fail();\n};`,
      1,
    ],
    "a generator double": [
      `const double = async function* (folder) {\n  const { seen } = state;\n  seen.push(folder);\n  yield folder;\n};`,
      1,
    ],
  };
  for (const [shape, [double, count]] of Object.entries(late))
    for (const place of testPlaces) {
      const messages = await lint(mocked(double), place, hoistedRules);
      assert.equal(messages.length, count, `${place}: ${shape}`);
      // 메시지가 맞는 모양과 기준 문서의 절을 알려 준다.
      assert.match(messages[0].message, /첫 await 전에 칸을 지역 값으로 잡고/);
      assert.match(messages[0].message, /CODING_STANDARDS\.md#정리/);
    }
  // 칸은 hoisted 값만이 아니다(#286 PR 3b-3b-2 설계 점검 1회차 [1]·[2], 2회차 [4]·[5]·[6]): 구조 분해로 선언한 hoisted 값, 모듈 범위의
  // let(바인딩), 그릇으로 만든 let·const, 가짜 함수 const. await 뒤의 참조가 걸린다.
  const fs = `vi.mock("node:fs/promises", async (importOriginal) => {\n  const real = await importOriginal();\n`;
  const otherState = {
    "a destructured hoisted declaration": [
      `import { vi } from "vitest";\nconst { faults } = vi.hoisted(() => ({ faults: { open: undefined } }));\n${fs}  const open = async (file) => {\n    const handle = await real.open(file);\n    if (faults.open) throw faults.open;\n    return handle;\n  };\n  return { ...real, open };\n});\n`,
      2,
    ],
    "a module let binding": [
      `import { vi } from "vitest";\nlet race;\n${fs}  const rename = async (from, to) => {\n    await real.rename(from, to);\n    await race?.afterRename?.(from, to);\n  };\n  return { ...real, rename };\n});\n`,
      1,
    ],
    "a module let container": [
      `import { vi } from "vitest";\nlet faults = { open: undefined };\n${fs}  const open = async (file) => {\n    const handle = await real.open(file);\n    if (faults.open) throw faults.open;\n    return handle;\n  };\n  return { ...real, open };\n});\n`,
      2,
    ],
    "a module const container": [
      `import { vi } from "vitest";\nconst faults = { open: undefined };\n${fs}  const open = async (file) => {\n    const handle = await real.open(file);\n    if (faults.open) throw faults.open;\n    return handle;\n  };\n  return { ...real, open };\n});\n`,
      2,
    ],
    "a module mock function": [
      `import { vi } from "vitest";\nconst hook = vi.fn();\n${fs}  const open = async (file) => {\n    const handle = await real.open(file);\n    hook(file);\n    return handle;\n  };\n  return { ...real, open };\n});\n`,
      1,
    ],
    "a helper at module scope": [
      `import { vi } from "vitest";\nconst state = vi.hoisted(() => ({ fails: undefined }));\nfunction fault() {\n  return state.fails;\n}\n${fs}  const open = async (file) => {\n    const handle = await real.open(file);\n    if (fault()) throw new Error("x");\n    return handle;\n  };\n  return { ...real, open };\n});\n`,
      1,
    ],
    // 모듈 범위 도움이 자기 안에서 await 뒤나 콜백에서 칸을 읽으면, 대역이 첫 await 전에 불러도 늦다(변경분 점검 1회차 [1]).
    "a module helper reading after its own await": [
      `import { vi } from "vitest";\nconst state = vi.hoisted(() => ({ seen: [] }));\nasync function record(file) {\n  await work();\n  state.seen.push(file);\n}\n${fs}  const open = async (file) => {\n    await record(file);\n    return real.open(file);\n  };\n  return { ...real, open };\n});\n`,
      1,
    ],
    "a module helper reading in its own callback": [
      `import { vi } from "vitest";\nconst state = vi.hoisted(() => ({ fails: undefined }));\nfunction closeWith(server, done) {\n  server.close((error) => done(state.fails ?? error));\n}\n${fs}  const createServer = (...args) => {\n    const server = real.createServer(...args);\n    return { close: (done) => closeWith(server, done) };\n  };\n  return { ...real, createServer };\n});\n`,
      1,
    ],
    // 모듈 범위 도움 안의 이름 붙은 지역 함수도 도움 기준으로 본다(변경분 점검 2회차 [1]).
    "a named callback inside a module helper": [
      `import { vi } from "vitest";\nconst state = vi.hoisted(() => ({ fails: undefined }));\nfunction closeWith(server, done) {\n  const onClose = (error) => done(state.fails ?? error);\n  server.close(onClose);\n}\n${fs}  const createServer = (...args) => {\n    const server = real.createServer(...args);\n    return { close: (done) => closeWith(server, done) };\n  };\n  return { ...real, createServer };\n});\n`,
      1,
    ],
    "a local function called after a module helper's await": [
      `import { vi } from "vitest";\nconst state = vi.hoisted(() => ({ seen: [] }));\nasync function record(file) {\n  const push = () => state.seen.push(file);\n  await work();\n  push();\n}\n${fs}  const open = async (file) => {\n    await record(file);\n    return real.open(file);\n  };\n  return { ...real, open };\n});\n`,
      1,
    ],
    // 외부 리뷰 1회차가 든 놓친 모양: 모듈 함수를 factory가 바로 돌려줌·반환 객체에 넣음·다른 변수에 담아 돌려줌, 밖에서 선언한 factory.
    "a module function the factory returns": [
      `${hoistedHead}async function open(file) {\n  await work();\n  state.seen.push(file);\n}\nvi.mock("node:fs/promises", () => open);\n`,
      1,
    ],
    "a module function in the returned object": [
      `${hoistedHead}async function open(file) {\n  await work();\n  state.seen.push(file);\n}\nvi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal()), open }));\n`,
      1,
    ],
    "a module function returned through another variable": [
      `${hoistedHead}async function open(file) {\n  await work();\n  state.seen.push(file);\n}\nvi.mock("node:fs/promises", async (importOriginal) => {\n  const real = await importOriginal();\n  const doubled = open;\n  return { ...real, open: doubled };\n});\n`,
      1,
    ],
    "a factory declared outside the call": [
      `${hoistedHead}const factory = async (importOriginal) => {\n  const real = await importOriginal();\n  return { ...real, open: async (file) => {\n    await real.open(file);\n    state.seen.push(file);\n  } };\n};\nvi.mock("node:fs/promises", factory);\n`,
      1,
    ],
    // 모듈 값이 다른 모듈 값을 거쳐도(간접·별칭) 대역 쪽 자리다.
    "a module helper reached through a module function": [
      `${hoistedHead}async function helper(file) {\n  await work();\n  state.seen.push(file);\n}\nasync function open(file) {\n  return helper(file);\n}\nvi.mock("node:fs/promises", () => ({ open }));\n`,
      1,
    ],
    "a module alias of a module function": [
      `${hoistedHead}async function open(file) {\n  await work();\n  state.seen.push(file);\n}\nconst impl = open;\nvi.mock("node:fs/promises", () => ({ open: impl }));\n`,
      1,
    ],
    "vi.doMock": [
      `${hoistedHead}vi.doMock("node:fs/promises", async (importOriginal) => {\n  const real = await importOriginal();\n  const open = async (file) => {\n    const handle = await real.open(file);\n    state.seen.push(file);\n    return handle;\n  };\n  return { ...real, open };\n});\n`,
      1,
    ],
  };
  for (const [shape, [code, count]] of Object.entries(otherState))
    for (const place of testPlaces)
      assert.equal(
        (await lint(code, place, hoistedRules)).length,
        count,
        `${place}: ${shape}`
      );
  // 공용 대역 파일: factory가 다른 저장소 파일의 내보낸 함수로 대역을 만들면 그 파일을 읽어 같은 판정을 하고, 부른 자리에 단다(감독 결정
  // 2026-11-26). 저장소 모듈인데 찾지 못하면 판정할 수 없어 짚는다.
  const shared = (place) => {
    const relative = path
      .relative(
        path.dirname(path.join(repository, place)),
        path.join(
          repository,
          "scripts/fixtures/hoisted-state/shared-double.mjs"
        )
      )
      .replaceAll(path.sep, "/");
    return relative.startsWith(".") ? relative : `./${relative}`;
  };
  for (const place of testPlaces) {
    const from = shared(place);
    const dynamic = (maker) =>
      `import { vi } from "vitest";\nvi.mock("node:fs/promises", async (importOriginal) => (await import("${from}")).${maker}(await importOriginal()));\n`;
    const late = await lint(dynamic("lateDouble"), place, hoistedRules);
    assert.equal(
      late.length,
      2,
      `${place}: a shared double reading after its await`
    );
    assert.match(late[0].message, /shared-double\.mjs:\d+/);
    assert.deepEqual(
      await lint(dynamic("takingDouble"), place, hoistedRules),
      [],
      `${place}: a shared double taking first`
    );
    const imported = `import { vi } from "vitest";\nimport { lateDouble } from "${from}";\nvi.mock("node:fs/promises", async (importOriginal) => lateDouble(await importOriginal()));\n`;
    assert.equal(
      (await lint(imported, place, hoistedRules)).length,
      2,
      `${place}: a shared double imported by name`
    );
    const missing = `import { vi } from "vitest";\nvi.mock("node:fs/promises", async (importOriginal) => (await import("./no-such-support.ts")).makeDouble(await importOriginal()));\n`;
    const [unresolved, ...rest] = await lint(missing, place, hoistedRules);
    assert.deepEqual(rest, [], `${place}: a missing shared double`);
    assert.match(unresolved?.message ?? "", /판정할 수 없습니다/);
  }
  // 대역 쪽 자리가 쓰는 hoisted 콜백의 지역 칸: 콜백 안의 함수(대역이 부르는 도움)가 읽거나 쓰면 짚는다(감독 결정 2026-11-26).
  const hoistedLocal = `import { vi } from "vitest";\nconst queries = vi.hoisted(() => {\n  let held = false;\n  return {\n    hold: () => {\n      held = true;\n    },\n    query: async () => {\n      if (!held) return;\n      held = false;\n    },\n  };\n});\nvi.mock("m", async () => ({ run: async () => {\n  const { query } = queries;\n  await query();\n} }));\n`;
  for (const place of testPlaces)
    assert.equal(
      (await lint(hoistedLocal, place, hoistedRules)).length,
      3,
      `${place}: hoisted locals read in its functions`
    );
  // TS로 감싼 그릇·비동기 hoisted도 칸이다(TS 자리만).
  const wrapped = {
    "a container under as": `import { vi } from "vitest";\nconst made = [] as string[];\n${fs}  const mkdtemp = async (prefix: string) => {\n    const folder = await real.mkdtemp(prefix);\n    made.push(folder);\n    return folder;\n  };\n  return { ...real, mkdtemp };\n});\n`,
    "an awaited hoisted value": `import { vi } from "vitest";\nconst state = await vi.hoisted(async () => ({ made: [] as string[] }));\n${fs}  const mkdtemp = async (prefix: string) => {\n    const folder = await real.mkdtemp(prefix);\n    state.made.push(folder);\n    return folder;\n  };\n  return { ...real, mkdtemp };\n});\n`,
  };
  for (const [shape, code] of Object.entries(wrapped))
    for (const place of testPlaces.filter((place) => place.endsWith(".ts")))
      assert.equal(
        (await lint(code, place, hoistedRules)).length,
        1,
        `${place}: ${shape}`
      );
});

test("a module double may take the state the tests swap before its first await and use only what it took", async () => {
  const allowed = {
    "taking before the first await": `const double = async (file) => {\n  const { seen, fails } = state;\n  const handle = await real.open(file);\n  seen.push(file);\n  if (fails) throw fails;\n  return handle;\n};`,
    "a synchronous double": `const double = (file) => {\n  state.seen.push(file);\n  if (state.fails) throw state.fails;\n  return real.open(file);\n};`,
    "a callback that uses what was taken": `const double = (server, done) => {\n  const failure = state.fails;\n  return server.close((error) => done(failure ?? error));\n};`,
    "Promise.withResolvers instead of an executor": `const double = (file) => {\n  const { promise, resolve } = Promise.withResolvers();\n  state.release = resolve;\n  return promise.then(() => real.open(file));\n};`,
    // 건네는 const 객체의 속성에 담은 대역, factory 안 클래스의 메서드(대역이 만든 서버처럼)도 대역이다.
    // 만드는 함수가 돌려준 안쪽 함수가 첫 await 전에 잡으면 맞다(공용 `swapAfter`·`failingNet`과 같은 모양).
    "an inner function a maker returns, taking first": `const wrap = (call) => async (...args) => {\n  const { fails } = state;\n  const result = await call(...args);\n  if (fails) throw fails;\n  return result;\n};\n  const double = wrap(real.open);`,
    "a method of a class the factory hands over": `class Server {\n  close(done) {\n    const failure = state.fails;\n    return done(failure);\n  }\n}\n  const double = () => new Server();`,
  };
  for (const [shape, double] of Object.entries(allowed))
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(mocked(double), place, hoistedRules),
        [],
        `${place}: ${shape}`
      );
  // 시험 본문·hook은 대역이 아니다(본문의 늦은 일은 본문이 기다린다).
  const outside = `${hoistedHead}afterEach(async () => {\n  await settle();\n  state.seen = [];\n});\nit("reads", async () => {\n  await work();\n  expect(state.seen).toEqual([]);\n});\n`;
  // 건네는 const 객체의 속성에 담은 대역(`watched[name] = 대역`)과, 모듈 범위 함수를 factory가 돌려주는 객체에 넣은 대역.
  const handedOverShapes = [
    `${hoistedHead}vi.mock("node:fs/promises", async (importOriginal) => {\n  const real = await importOriginal();\n  const watched = {};\n  for (const name of ["open", "stat"])\n    watched[name] = async (file) => {\n      const { seen } = state;\n      const result = await real[name](file);\n      seen.push(file);\n      return result;\n    };\n  return { ...real, ...watched };\n});\n`,
    `${hoistedHead}async function open(file) {\n  const { seen } = state;\n  await work();\n  seen.push(file);\n}\nvi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal()), open }));\n`,
  ];
  for (const place of testPlaces)
    for (const code of handedOverShapes)
      assert.deepEqual(
        await lint(code, place, hoistedRules),
        [],
        `${place}: ${code}`
      );
  // hoisted 콜백의 지역 칸은 대역 쪽 자리가 그 hoisted 값을 쓸 때만 본다(시험만 쓰면 대역이 아니다). 콜백 몸에서 처음 한 번 쓰는 것은 받는다.
  const hoistedForTests = `import { vi } from "vitest";\nconst counter = vi.hoisted(() => {\n  let count = 0;\n  count += 1;\n  return { next: () => ++count };\n});\nvi.mock("m", async () => ({ run: () => 1 }));\nit("counts", () => {\n  expect(counter.next()).toBe(2);\n});\n`;
  for (const place of testPlaces)
    assert.deepEqual(
      await lint(hoistedForTests, place, hoistedRules),
      [],
      `${place}: hoisted locals used only by tests`
    );
  // 바인딩을 바꿔 끼우는 let 칸은 지역 값으로 담으면 그 값을 잡은 것이다. 그릇 칸을 지역 별칭으로 담는 것은 같은 그릇이라 걸린다.
  const takenLet = `import { vi } from "vitest";\nlet race;\nvi.mock("node:fs/promises", async (importOriginal) => {\n  const real = await importOriginal();\n  const rename = async (from, to) => {\n    const current = race;\n    await real.rename(from, to);\n    await current?.afterRename?.(from, to);\n  };\n  return { ...real, rename };\n});\n`;
  const aliasedContainer = mocked(
    `const double = async (file) => {\n  const kept = state;\n  const handle = await real.open(file);\n  kept.seen.push(file);\n  return handle;\n};`
  );
  for (const place of testPlaces) {
    assert.deepEqual(
      await lint(takenLet, place, hoistedRules),
      [],
      `${place}: a let taken as a local value`
    );
    assert.equal(
      (await lint(aliasedContainer, place, hoistedRules)).length,
      1,
      `${place}: a container aliased inside the double`
    );
  }
  // 칸을 늦게 읽는 모듈 범위 도움이라도 시험 본문에서만 부르면 대역이 아니다.
  const helperInBody = `import { vi } from "vitest";\nconst state = vi.hoisted(() => ({ seen: [] }));\nasync function record(file) {\n  await work();\n  state.seen.push(file);\n}\nvi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal()) }));\nit("records", async () => {\n  await record("a");\n});\n`;
  for (const place of testPlaces)
    assert.deepEqual(
      await lint(helperInBody, place, hoistedRules),
      [],
      `${place}: a late helper called only from a test body`
    );
  // 모듈 범위의 const 값(그릇이 아닌 것: 글자·함수)은 시험이 바꿔 끼우지 않는다.
  const constants = `import { vi } from "vitest";\nconst prefix = "babojubot-";\nconst label = (file) => prefix + file;\nvi.mock("node:fs/promises", async (importOriginal) => {\n  const real = await importOriginal();\n  const open = async (file) => {\n    const handle = await real.open(file);\n    return label(prefix + file) ? handle : handle;\n  };\n  return { ...real, open };\n});\n`;
  for (const place of testPlaces)
    assert.deepEqual(
      await lint(constants, place, hoistedRules),
      [],
      `${place}: constants`
    );
  // 같은 이름의 지역 값은 hoisted 칸이 아니다.
  const local = mocked(
    `const double = async (file) => {\n  const state = { seen: [] };\n  await real.open(file);\n  state.seen.push(file);\n};`
  );
  for (const place of testPlaces)
    for (const code of [outside, local])
      assert.deepEqual(
        await lint(code, place, hoistedRules),
        [],
        `${place}: ${code}`
      );
});

/** 고정 시간 기다림 규칙의 메시지만. */
const waitRules = ["tests/no-fixed-time-wait"];

test("test code may not wait a fixed time", async () => {
  const waits = {
    "an awaited sleep": `await new Promise((resolve) => setTimeout(resolve, 50));\n`,
    "a timer that only calls resolve": `await new Promise((r) => setTimeout(() => r(), 50));\n`,
    "a timer block that only calls resolve": `await new Promise((r) => {\n  setTimeout(() => {\n    r();\n  }, 50);\n});\n`,
    "a sleep chained with then": `const sent = new Promise((r) => setTimeout(r, 1000)).then(() => send());\nawait sent;\n`,
    // 도움 함수로 감싸는 우회: 정의에서 짚는다.
    "a sleep helper": `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(50);\n`,
    "a sleep between checks": `while (!done()) await new Promise((r) => setTimeout(r, 10));\n`,
    "timers/promises": `import { setTimeout } from "node:timers/promises";\nawait setTimeout(50);\n`,
    "timers/promises under another name": `import { setTimeout as sleep } from "timers/promises";\nawait sleep(50);\n`,
    "the timers/promises scheduler": `import { scheduler } from "node:timers/promises";\nawait scheduler.wait(50);\n`,
    // 공용 가져오기 판정: dynamic import·require에서 구조 분해한 이름도 같다(#266 리뷰 SPEC-1).
    "timers/promises from a dynamic import": `const { setTimeout: sleep } = await import("node:timers/promises");\nawait sleep(50);\n`,
    "timers/promises from require": `const { setTimeout: sleep } = require("node:timers/promises");\nawait sleep(50);\n`,
    // 출처로 본다: const 별칭, 구조 분해한 scheduler.wait, 지연마다 값을 내는 setInterval(Node 문서: 지연을 기다리는 함수, #266 리뷰 SPEC-4).
    "a const alias of timers/promises setTimeout": `import { setTimeout as original } from "node:timers/promises";\nconst wait = original;\nawait wait(50);\n`,
    "scheduler.wait taken apart": `import { scheduler } from "node:timers/promises";\nconst { wait } = scheduler;\nawait wait(50);\n`,
    "a timers/promises interval": `import { setInterval } from "node:timers/promises";\nfor await (const _ of setInterval(50)) break;\n`,
    // 타이머는 이름이 아니라 출처로 본다: 이름을 바꿔 가져온 node:timers의 setTimeout(#266 리뷰 SPEC-2).
    "setTimeout from node:timers under another name": `import { setTimeout as later } from "node:timers";\nawait new Promise((resolve) => later(resolve, 50));\n`,
    waitForTimeout: `await page.waitForTimeout(300);\n`,
  };
  for (const [shape, code] of Object.entries(waits))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, waitRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 대안과 기준 문서의 절을 알려 준다.
      assert.match(message.message, /vi\.waitFor·expect\.poll/);
      assert.match(message.message, /manualClock/);
      assert.match(message.message, /CODING_STANDARDS\.md#시간/);
    }
});

test("test code may use timers that bound a wait, answer late, check again or come from a clock", async () => {
  const allowed = [
    // 시계를 주입한 타이머는 시험이 시간을 정한다.
    `await new Promise((resolve) => clock.setTimeout(resolve, 1000));\n`,
    `const { setTimeout } = clock;\nawait new Promise((resolve) => setTimeout(resolve, 1000));\n`,
    // 실패를 알리는 상한과 경주의 상한.
    `await Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 5000))]);\n`,
    `await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);\n`,
    `const deadline = setTimeout(() => child.kill(), 20_000);\nclearTimeout(deadline);\n`,
    // 값을 넘기는 타이머: 가짜의 늦은 응답, 상한의 표지.
    `const check = () => new Promise((resolve) => setTimeout(() => resolve(unavailable), 100));\nawait check();\n`,
    `const timedOut = new Promise((resolve) => setTimeout(() => resolve(undefined), 1000));\nawait Promise.race([exit, timedOut]);\n`,
    // 가짜가 응답을 보내는 타이머.
    `setTimeout(() => res.end("late"), 50);\n`,
    `await new Promise((resolve, reject) => setTimeout(() => route.fulfill({ response }).then(resolve, reject), 50));\n`,
    // 깨어나 같은 조건을 다시 확인하는 타이머.
    `await new Promise((resolve) => {\n  const poll = () => (done() ? resolve() : setTimeout(poll, 50));\n  poll();\n});\n`,
    // 이벤트 루프 차례 하나는 시간을 기다리지 않는다(잇달아 쓰면 횟수 세기로 짚는다).
    `await new Promise((resolve) => setTimeout(resolve, 0));\n`,
    `await new Promise((resolve) => setImmediate(resolve));\n`,
    `await new Promise((resolve) => setTimeout(resolve));\n`,
    // timers/promises가 아닌 곳의 같은 이름, Playwright의 다른 대기.
    `import { setTimeout as later } from "./elsewhere.mjs";\nawait later(50);\nawait page.waitForURL("/");\n`,
    // 가져온 이름을 지역 매개변수가 가리면 그 함수가 아니다(#266 리뷰 SPEC-4).
    `import { setTimeout } from "node:timers/promises";\nexport async function run(setTimeout) {\n  await setTimeout(50);\n}\n`,
    // timers/promises의 차례 넘기기(setImmediate·scheduler.yield)는 시간을 기다리지 않는다(Node 문서: setImmediate와 같음). 잇달아 쓰면 횟수 세기로 짚는다.
    `import { setImmediate, scheduler } from "node:timers/promises";\nawait setImmediate();\nexpect(done).toBe(true);\nawait scheduler.yield();\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(await lint(code, place, waitRules), [], code);
});

test("code outside tests may wait a fixed time", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ])
    assert.deepEqual(
      await lint(
        `await new Promise((resolve) => setTimeout(resolve, 50));\n`,
        place,
        waitRules
      ),
      [],
      place
    );
});

test("test code may not abort after a fixed time or count event loop turns as the end of the work", async () => {
  /** @type {Record<string, [string, RegExp]>} */
  const ordered = {
    // 정해진 시간 뒤 중단.
    "an abort timer": [
      `setTimeout(() => cancel.abort(), 50);\n`,
      /정해진 시간 뒤에 중단/,
    ],
    "an abort timer block with a reason": [
      `setTimeout(() => {\n  stop.abort(new Error("stop"));\n}, 100);\n`,
      /정해진 시간 뒤에 중단/,
    ],
    "an abort timer with a variable delay": [
      `setTimeout(() => controller.abort(), delay);\n`,
      /정해진 시간 뒤에 중단/,
    ],
    // 정해진 횟수만큼 차례 넘기기.
    "a counted zero timer": [
      `for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));\n`,
      /정해진 횟수/,
    ],
    "a counted timer without a delay": [
      `for (let i = 0; i < 2; i++) await new Promise((r) => setTimeout(() => r()));\n`,
      /정해진 횟수/,
    ],
    "a counted setImmediate block": [
      `for (let i = 0; i < 3; i++) {\n  await new Promise((resolve) => setImmediate(resolve));\n}\n`,
      /정해진 횟수/,
    ],
    "counted microtasks": [
      `for (const _ of [1, 2]) await Promise.resolve();\nfor (let i = 0; i < 2; i++) await new Promise((r) => queueMicrotask(r));\nfor (let i = 0; i < 2; i++) await new Promise((r) => process.nextTick(r));\n`,
      /정해진 횟수/,
    ],
    // 차례 예약도 출처로 본다: 이름을 바꿔 가져온 node:timers의 setImmediate(#266 리뷰 SPEC-2).
    "a counted setImmediate under another name": [
      `import { setImmediate as soon } from "node:timers";\nfor (let i = 0; i < 3; i++) await new Promise((resolve) => soon(resolve));\n`,
      /정해진 횟수/,
    ],
    // timers/promises의 차례 넘기기도 횟수를 세면 같다(#266 리뷰 SPEC-4).
    "counted timers/promises turns": [
      `import { setImmediate as soon, scheduler } from "node:timers/promises";\nfor (let i = 0; i < 3; i++) await soon();\nawait scheduler.yield();\nawait scheduler.yield();\n`,
      /정해진 횟수/,
    ],
  };
  for (const [shape, [code, kind]] of Object.entries(ordered))
    for (const place of testPlaces) {
      const messages = await lint(code, place, waitRules);
      assert.ok(messages.length, `${place}: ${shape} not reported`);
      for (const message of messages) {
        assert.match(message.message, kind, `${place}: ${shape}`);
        // 메시지가 대안과 기준 문서의 절을 알려 준다.
        assert.match(message.message, /신호/);
        assert.match(message.message, /CODING_STANDARDS\.md#순서/);
      }
    }
  // 한 반복은 한 번만 알린다.
  const microtasks = ordered["counted microtasks"];
  assert.ok(microtasks, "no counted microtasks case");
  assert.equal((await lint(microtasks[0], testPlaces[0], waitRules)).length, 3);
});

test("test code may abort on a signal, keep an abort timer as a bound and repeat a turn until a condition holds", async () => {
  const allowed = [
    // 신호를 받은 뒤 중단한다.
    `await waiting;\ncancel.abort();\nentered.then(() => stop.abort());\n`,
    // 담아 두고 푸는 상한.
    `const deadline = setTimeout(() => cancel.abort(), 5000);\nclearTimeout(deadline);\n`,
    // 조건을 다시 확인하는 반복.
    `while (!closed) await new Promise((r) => setImmediate(r));\n`,
    `do await new Promise((r) => setTimeout(r, 0));\nwhile (scheduled > 0);\n`,
    `for (;;) {\n  await new Promise((r) => setImmediate(r));\n  if (done()) break;\n}\n`,
    // 차례가 아닌 일을 기다리는 반복.
    `for (const item of items) await handle(item);\nfor (let i = 0; i < 3; i++) await server.release();\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(await lint(code, place, waitRules), [], code);
});

/** 화면 전체 검색 규칙의 메시지만. */
const locatorRules = ["tests/no-page-wide-locator"];

// E2E는 타입 정보로 페이지를 가리므로 있는 E2E 파일 자리를 빌린다.
const e2ePlaces = [
  "apps/web/e2e/home.spec.ts",
  "apps/web/e2e/support/organization.ts",
];
// 시험이 받는 page와 다른 탭(`context.newPage()`), 영역 locator.
const e2eHead = `import type { BrowserContext, Locator, Page } from "@playwright/test";\ndeclare const page: Page;\ndeclare const context: BrowserContext;\ndeclare const area: Locator;\nconst other = await context.newPage();\nexport {};\n`;

test("an E2E may not search the whole page by text or pick by position among page-wide or same-name matches", async () => {
  /** @type {Record<string, [string, RegExp]>} */
  const found = {
    // 화면 전체에서 글자로 찾기.
    "page text": [`await page.getByText("대기").click();\n`, /글자로/],
    "another tab's text": [
      `await other.getByText("조직이 일시정지 중입니다").isVisible();\n`,
      /글자로/,
    ],
    "page text in an or": [
      `await area.or(page.getByText("실패")).waitFor();\n`,
      /글자로/,
    ],
    // 화면 전체 검색에서 순서로 고르기.
    "page role first": [
      `await page.getByRole("link", { name: "설정" }).first().click();\n`,
      /화면 전체에서 찾은/,
    ],
    "page filter last": [
      `await page.getByRole("status").filter({ hasText: "불러오는 중" }).last().waitFor();\n`,
      /화면 전체에서 찾은/,
    ],
    "page locator nth": [
      `await page.locator("[data-author]").nth(1).click();\n`,
      /화면 전체에서 찾은/,
    ],
    // 이름·글자로 찾은 것 중 순서로 고르기(영역 안이어도).
    "area text first": [
      `await area.getByText("실행 시도 완료").first().waitFor();\n`,
      /이름·글자로 찾은/,
    ],
    "area named role nth": [
      `await area.getByRole("button", { name: "취소" }).nth(1).click();\n`,
      /이름·글자로 찾은/,
    ],
    "area label last": [
      `await area.getByLabel("제목").last().fill("x");\n`,
      /이름·글자로 찾은/,
    ],
    "a text filter then first": [
      `await area.getByRole("listitem").filter({ hasText: "완료" }).first().click();\n`,
      /이름·글자로 찾은/,
    ],
    "an and after a named match": [
      `await area.getByRole("link", { name: /^실행 시도/ }).and(area.locator("a")).first().click();\n`,
      /이름·글자로 찾은/,
    ],
  };
  for (const [shape, [code, kind]] of Object.entries(found))
    for (const place of e2ePlaces) {
      const [message, ...rest] = await lint(
        e2eHead + code,
        place,
        locatorRules
      );
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, kind, shape);
      // 메시지가 대안과 기준 문서의 절을 알려 준다.
      assert.match(message.message, /영역|ID/);
      assert.match(message.message, /CODING_STANDARDS\.md#화면/);
    }
});

test("an E2E may find areas on the page, search inside them, pick list items by order and wait for either of two", async () => {
  const allowed = [
    // 영역·대화상자·조작 요소를 페이지에서 찾고 그 안에서 글자로 찾는다.
    `const map = page.getByRole("region", { name: "연구 지도" });\nawait map.getByText("연구 문제").click();\nawait page.getByRole("dialog", { name: "새 연구 조직" }).getByLabel("조직 이름").fill("x");\n`,
    `await page.getByRole("button", { name: "저장" }).click();\nawait page.getByLabel("Lead에게 보낼 메시지").fill("x");\nawait page.getByTestId("run-stop-reason").waitFor();\n`,
    `await other.getByRole("main").getByText("찾을 수 없는 승인 요청").waitFor();\n`,
    // 이름 없는 목록 항목을 순서로 고르는 것은 순서 확인이다.
    `const rows = area.getByRole("row");\nawait rows.nth(1).click();\nawait area.getByRole("listitem").first().waitFor();\nawait area.locator("[data-date]").last().hover();\n`,
    `await page.getByRole("region", { name: "최근 실행 시도" }).getByRole("link").first().click();\n`,
    // 둘 중 먼저 뜨는 것을 기다린다(Playwright 문서의 관용 표현).
    `await area.or(page.getByRole("alert")).first().waitFor();\n`,
    // 변수에 담은 locator는 따라가지 않는다.
    `const links = page.getByRole("link");\nawait links.first().click();\n`,
  ];
  for (const code of allowed)
    for (const place of e2ePlaces) {
      // 코드가 읽히지 않으면 lint가 실패로 드러낸다. 읽히지 않아 통과하는 것이 아니다.
      assert.deepEqual(
        await lint(e2eHead + code, place, locatorRules),
        [],
        code
      );
    }
});

test("code outside the E2E may search a whole page", async () => {
  for (const place of [
    "apps/server/test/lint-sample.test.ts",
    "scripts/lint-sample.test.mjs",
    "scripts/live/lint-sample.mjs",
  ])
    assert.deepEqual(
      await lint(
        `await page.getByText("대기").first().click();\n`,
        place,
        locatorRules
      ),
      [],
      place
    );
});

/** finally 정리 규칙의 메시지만. */
const finallyRules = ["tests/no-cleanup-in-finally"];

test("test code may not wait or call a failing cleanup in finally", async () => {
  const awaited = {
    "one awaited close": `try {\n  check();\n} finally {\n  await server.close();\n}\n`,
    "cleanups one after another": `try {\n  check();\n} finally {\n  await stopMain(child);\n  await removeFolder(home);\n}\n`,
    "a guarded close": `try {\n  check();\n} finally {\n  if (child) await killHard(child);\n}\n`,
    "a close in a loop": `try {\n  check();\n} finally {\n  for (const child of children) await killHard(child);\n}\n`,
    // 끝나기만 하는 기다림과 실패를 삼키는 기다림도 같은 모양이라, 실패할 수 있는 새 정리가 이 모양을 따라 한다.
    "a wait that only ends": `try {\n  check();\n} finally {\n  await new Promise((resolve) => server.close(resolve));\n}\n`,
    "a swallowed close": `try {\n  check();\n} finally {\n  await client.end().catch(() => {});\n}\n`,
    "a close inside a nested try": `try {\n  check();\n} finally {\n  try {\n    await server.close();\n  } catch (error) {\n    failures.push(error);\n  }\n}\n`,
    "for await": `try {\n  check();\n} finally {\n  for await (const line of lines) handle(line);\n}\n`,
    // Playwright fixture가 use 뒤에 정리하는 모양.
    "a fixture's cleanup": `const fixture = async ({}, use) => {\n  const server = await start();\n  try {\n    await use(server.url);\n  } finally {\n    await server.stop();\n  }\n};\nexport { fixture };\n`,
  };
  const thrown = {
    "process.kill": `try {\n  check();\n} finally {\n  process.kill(pid, "SIGKILL");\n}\n`,
    // 살아 있는지 확인해도 그 사이에 끝날 수 있다.
    "a checked process.kill": `try {\n  check();\n} finally {\n  if (alive(pid)) process.kill(pid, "SIGKILL");\n}\n`,
    "fs.rmSync": `import fs from "node:fs";\ntry {\n  check();\n} finally {\n  fs.rmSync("link", { force: true });\n}\n`,
    chmodSync: `import { chmodSync } from "node:fs";\ntry {\n  check();\n} finally {\n  chmodSync("dir", 0o700);\n}\n`,
  };
  /** @type {Array<[string, Record<string, string>, RegExp]>} */
  const kinds = [
    ["await", awaited, /onTestFinished/],
    ["sync", thrown, /이미 사라진 대상/],
  ];
  for (const [kind, shapes, pattern] of kinds)
    for (const [shape, code] of Object.entries(shapes))
      for (const place of testPlaces) {
        const [message, ...rest] = await lint(code, place, finallyRules);
        assert.ok(message, `${place}: ${shape} not reported`);
        assert.deepEqual(rest, [], `${place}: ${shape}`);
        // 메시지가 원래 실패를 가리는 까닭, 대안과 기준 문서의 절을 알려 준다.
        assert.match(
          message.message,
          /원래 실패를 가리고/,
          `${kind}: ${shape}`
        );
        assert.match(message.message, pattern, `${kind}: ${shape}`);
        assert.match(message.message, /withCleanup/, `${kind}: ${shape}`);
        assert.match(message.message, /CODING_STANDARDS\.md#정리/);
        // 실패를 삼키라고 안내하지 않는다.
        assert.doesNotMatch(message.message, /catch/);
      }
});

test("test code may release without waiting in finally and register cleanups where it takes a resource", async () => {
  const allowed = [
    // 기다리지 않고 실패하지 않는 되돌리기·풀기.
    `try {\n  await check();\n} finally {\n  clearTimeout(timer);\n  warn.mockRestore();\n  gate.open();\n  vi.useRealTimers();\n}\n`,
    // 기다림은 본문과 catch에서 한다.
    `try {\n  await check();\n} catch (error) {\n  await report(error);\n}\n`,
    // 이미 사라진 대상만 넘어가는 동기 끄기.
    `try {\n  check();\n} finally {\n  try {\n    process.kill(pid, "SIGKILL");\n  } catch (error) {\n    if (error.code !== "ESRCH") failures.push(error);\n  }\n}\n`,
    // 자원을 잡은 직후 러너나 withCleanup에 정리를 등록한다.
    `import { onTestFinished } from "vitest";\nconst server = await start();\nonTestFinished(async () => {\n  await server.close();\n  await removeFolder(dir);\n});\n`,
    `import { withCleanup } from "@babojubot/process/test-cleanup";\nawait withCleanup(async (defer) => {\n  const child = spawn();\n  defer(() => killHard(child));\n  await check(child);\n});\n`,
    // finally 밖의 끄기·지우기와 Promise의 finally 메서드.
    `process.kill(pid, "SIGKILL");\nfs.rmSync("file", { force: true });\nawait work().finally(() => clearTimeout(timer));\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(await lint(code, place, finallyRules), [], code);
});

test("code outside tests may wait in finally", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ])
    assert.deepEqual(
      await lint(
        `try {\n  check();\n} finally {\n  await server.close();\n  process.kill(pid, "SIGKILL");\n}\n`,
        place,
        finallyRules
      ),
      [],
      place
    );
});

/** 정리 hook 규칙의 메시지만. */
const skippedCleanupRules = ["tests/no-skipped-cleanup"];

test("a shared cleanup hook may not stop at the first failing cleanup", async () => {
  const shapes = {
    // 앞 정리가 실패하면 뒤 모델 서버를 닫지 않는다(#243).
    "two closes one after another": `afterAll(async () => {\n  await t?.close();\n  await model?.close();\n});\n`,
    "a list of cleanups in a loop": `afterEach(async () => {\n  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();\n});\n`,
    "a close in a loop block": `afterEach(async () => {\n  for (const server of servers) {\n    await server.close();\n  }\n});\n`,
    "a folder removal before another removal": `afterEach(async () => {\n  await removeFolder(root);\n  await Promise.all(attempts.map((dir) => removeFolder(dir)));\n});\n`,
    "a close before a later wait": `afterEach(async () => {\n  refusal = null;\n  await gate?.close();\n  for (const step of steps) step();\n  await settle();\n});\n`,
    "Playwright's afterAll": `test.afterAll(async () => {\n  await server.stop();\n  await relays.close();\n});\n`,
    "node:test's after": `after(async () => {\n  await environment.removeOrphans();\n  await relays.close();\n});\n`,
  };
  for (const [shape, code] of Object.entries(shapes))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, skippedCleanupRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.equal(message.messageId, "skipped", shape);
      assertCleanupAdvice(message);
    }
});

/** 정리 hook 규칙의 메시지가 이유, 대안(모두 시도·각각 등록·폴더 순서)과 기준 문서의 절을 알려 준다. */
function assertCleanupAdvice(message) {
  assert.match(message.message, /뒤 자원/);
  assert.match(message.message, /attemptAll/);
  assert.match(message.message, /onTestFinished/);
  assert.match(message.message, /folderCleanup\(…\)\.own\(…\)/);
  assert.match(message.message, /CODING_STANDARDS\.md#정리/);
}

test("catching every cleanup in one try still skips the later ones", async () => {
  const shapes = {
    // 서버 닫기가 실패하면 catch로 넘어가 모델 서버를 닫지 않는다(#248 리뷰).
    "two closes in one try": `afterAll(async () => {\n  try {\n    await server.close();\n    await model.close();\n  } catch (error) {\n    failures.push(error);\n  }\n});\n`,
    // 한 서버가 실패하면 남은 서버를 닫지 않는다.
    "a try around the whole loop": `afterEach(async () => {\n  try {\n    for (const server of servers) await server.close();\n  } catch (error) {\n    failures.push(error);\n  }\n});\n`,
    "a later close nested in the same try": `afterEach(async () => {\n  try {\n    await server.close();\n    if (model) {\n      await model.close();\n    }\n  } catch (error) {\n    failures.push(error);\n  }\n});\n`,
  };
  for (const [shape, code] of Object.entries(shapes))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, skippedCleanupRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.equal(message.messageId, "caught", shape);
      assert.match(message.message, /한 try…catch/);
      assertCleanupAdvice(message);
    }
});

test("cleanup hooks are told by where they come from, and the same check covers a hook's helper and a fixture", async () => {
  const shapes = {
    "a Vitest hook under another name": `import { afterAll as atLast } from "vitest";\natLast(async () => {\n  await server.close();\n  await model.close();\n});\n`,
    "a node:test hook under another name": `import { after as atEnd } from "node:test";\natEnd(async () => {\n  await server.close();\n  await model.close();\n});\n`,
    "node:test's default export": `import nodeTest from "node:test";\nnodeTest.after(async () => {\n  await server.close();\n  await model.close();\n});\n`,
    // 저장소 지원 파일이 넓혀 다시 내보낸 Playwright test(apps/web/e2e/support/shared-settings-run/fixture.ts).
    "a Playwright test a support file re-exports": `import { test } from "./fixture.ts";\ntest.afterAll(async () => {\n  await server.stop();\n  await relays.close();\n});\n`,
    "a test extended in the same file": `import { test as base } from "@playwright/test";\nconst settingsTest = base.extend({});\nsettingsTest.afterEach(async () => {\n  await server.stop();\n  await relays.close();\n});\n`,
    "Promises that each close a server, in a loop": `afterEach(async () => {\n  for (const server of servers.splice(0))\n    await new Promise((resolve, reject) =>\n      server.close((error) => (error ? reject(error) : resolve()))\n    );\n});\n`,
    // hook만 부르는 같은 파일 함수 한 단계.
    "a helper only the hook calls": `async function finish() {\n  await server.close();\n  await model.close();\n}\nafterAll(async () => {\n  await finish();\n});\n`,
    "a helper given as the hook": `const finish = async () => {\n  await server.close();\n  await model.close();\n};\nafterEach(finish);\n`,
    // fixture의 use 뒤 정리도 hook과 같다.
    "cleanups after use in a Playwright fixture": `import { test as base } from "@playwright/test";\nexport const test = base.extend({\n  servers: async ({ page }, provide) => {\n    await provide(page);\n    await server.close();\n    await model.close();\n  },\n});\n`,
    "a fixture given with options": `import { test as base } from "@playwright/test";\nexport const test = base.extend({\n  servers: [\n    async ({ page }, use) => {\n      await use(page);\n      try {\n        await server.close();\n        await model.close();\n      } catch (error) {\n        failures.push(error);\n      }\n    },\n    { auto: true },\n  ],\n});\n`,
  };
  for (const [shape, code] of Object.entries(shapes))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, skippedCleanupRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assertCleanupAdvice(message);
    }
});

test("a shared cleanup hook may try every cleanup, and a resource's own cleanup may chain its steps", async () => {
  const allowed = [
    `afterAll(() => attemptAll([() => folder?.cleanUp(), () => model?.close()]));\n`,
    // 그 폴더를 쓰는 서버를 끈 뒤에 지운다. 끄기가 실패하면 폴더를 남긴다. 폴더 지우기는 출처(공용 removeFolder)로 알아본다
    // (#266 리뷰 SPEC-7: 선언 없는 같은 이름은 그 도구가 아니다).
    `import { removeFolder } from "@babojubot/process/remove-folder";\nafterEach(async () => {\n  await t?.close();\n  t = undefined;\n  if (root) await removeFolder(root);\n});\n`,
    // 앞 단계가 끝나야 하는 단계는 한 단계 안에 둔다.
    `afterAll(() =>\n  attemptAll([\n    async () => {\n      await environment.removeOrphans();\n      await removeFolder(root);\n    },\n    () => relays.close(),\n  ])\n);\n`,
    // 실패를 모은다.
    `afterEach(async () => {\n  for (const server of servers)\n    try {\n      await server.close();\n    } catch (error) {\n      failures.push(error);\n    }\n  report(failures);\n});\n`,
    // 정리가 아닌 기다림과 정리 하나.
    `afterEach(async () => {\n  await Promise.allSettled(preparations.splice(0));\n  await server?.close();\n});\n`,
    // 자원 하나를 잡은 직후 등록한 정리는 그 단계를 차례로 잇는다.
    `onTestFinished(async () => {\n  await chmod(locked, 0o700);\n  await removeFolder(root);\n});\n`,
    // 정리마다 따로 catch한다.
    `afterAll(async () => {\n  try {\n    await server.close();\n  } catch (error) {\n    failures.push(error);\n  }\n  try {\n    await model.close();\n  } catch (error) {\n    failures.push(error);\n  }\n  report(failures);\n});\n`,
    // 서로 다른 갈래의 정리는 한 번에 하나만 돈다.
    `afterEach(async () => {\n  if (remote) await remote.close();\n  else await local.close();\n});\n`,
    `afterEach(async () => {\n  try {\n    if (remote) await remote.close();\n    else await local.close();\n  } catch (error) {\n    failures.push(error);\n  }\n});\n`,
    // try 안에서도 끈 뒤에 그 폴더를 지운다. 끄기가 실패하면 폴더를 남긴다.
    `import { removeFolder } from "@babojubot/process/remove-folder";\nafterEach(async () => {\n  try {\n    await server.stop();\n    await removeFolder(root);\n  } catch (error) {\n    failures.push(error);\n  }\n});\n`,
    // return 뒤의 정리는 앞 정리와 이어지지 않는다.
    `afterEach(async () => {\n  if (shared) {\n    await shared.close();\n    return;\n  }\n  await own.close();\n});\n`,
    // 같은 이름의 지역 함수는 hook이 아니다(scripts/boot-check-flow.test.mjs의 after).
    `const after = (run) => run();\nafter(async () => {\n  await server.close();\n  await model.close();\n});\n`,
    `import { afterAll } from "./schedule.ts";\nafterAll(async () => {\n  await server.close();\n  await model.close();\n});\n`,
    // 시험도 부르는 함수는 호출마다 자원·순서가 달라 그 함수만 보고 판단하지 않는다.
    `async function finish() {\n  await server.close();\n  await model.close();\n}\nafterAll(async () => {\n  await finish();\n});\ntest("restarts", async () => {\n  await finish();\n});\n`,
    // fixture가 use 뒤에 실패를 모아 차례로 시도한다(apps/web/e2e/support/shared-settings.ts).
    `import { test as base } from "@playwright/test";\nexport const test = base.extend({\n  settings: async ({ page }, use) => {\n    await server.close();\n    await use(page);\n    for (const gate of gates) await attempt(gate.settle);\n    await attempt(() => restore(page));\n  },\n});\n`,
    // Playwright가 아닌 extend의 함수는 fixture가 아니다.
    `const schema = base.extend({\n  parse: async (value, use) => {\n    await use(value);\n    await a.close();\n    await b.close();\n  },\n});\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, skippedCleanupRules),
        [],
        `${place}: ${code}`
      );
});

/** 끄기 오류 규칙의 메시지만. */
const killErrorRules = ["tests/no-ignored-kill-error"];

test("test code may not ignore the error of process.kill", async () => {
  const shapes = {
    // 권한 오류도 "끝났다"가 된다(#243).
    "a liveness check answering false": [
      `function alive(pid) {\n  try {\n    process.kill(pid, 0);\n    return true;\n  } catch {\n    return false;\n  }\n}\n`,
      "probe",
    ],
    "a liveness check with an unread error": [
      `const gone = (pid) => {\n  try {\n    process.kill(pid, 0);\n    return false;\n  } catch (error) {\n    return true;\n  }\n};\n`,
      "probe",
    ],
    "a swallowed kill": [
      `try {\n  process.kill(pid, "SIGKILL");\n} catch {\n  /* Already gone. */\n}\n`,
      "signal",
    ],
    "a swallowed group kill after a check": [
      `for (const group of groups)\n  try {\n    if (alive(group)) process.kill(-group, "SIGCONT");\n    process.kill(-group, "SIGKILL");\n  } catch {\n    // 이미 끝났다.\n  }\n`,
      "signal",
    ],
    // 오류를 읽어도 로그만 남기고 같은 답을 내면 넘긴 것과 같다.
    "a logged liveness check": [
      "function alive(pid) {\n  try {\n    process.kill(pid, 0);\n    return true;\n  } catch (error) {\n    console.warn(`확인하지 못했다: ${error.message}`);\n    return false;\n  }\n}\n",
      "probe",
    ],
    "an error dropped with void": [
      `try {\n  process.kill(pid, "SIGKILL");\n} catch (error) {\n  void error;\n}\n`,
      "signal",
    ],
    // 출처로 본다: 다른 이름으로 가져온 kill, node:process에서 가져온 process.
    "kill imported under another name": [
      `import { kill as signal } from "node:process";\ntry {\n  signal(pid, "SIGTERM");\n} catch {\n  /* gone */\n}\n`,
      "signal",
    ],
    "process imported from node:process": [
      `import proc from "node:process";\nfunction alive(pid) {\n  try {\n    proc.kill(pid, 0);\n    return true;\n  } catch {\n    return false;\n  }\n}\n`,
      "probe",
    ],
    // 공용 가져오기 판정: dynamic import·require에서 꺼낸 kill도 같다(#266 리뷰 SPEC-1).
    "kill taken from a dynamic import": [
      `const { kill } = await import("node:process");\ntry {\n  kill(pid, "SIGTERM");\n} catch {\n  /* gone */\n}\n`,
      "signal",
    ],
    "kill taken from require": [
      `const { kill: signal } = require("process");\ntry {\n  signal(pid, "SIGTERM");\n} catch {\n  /* gone */\n}\n`,
      "signal",
    ],
    // 안쪽 catch가 ESRCH 밖의 실패를 다시 던져도 바깥 catch가 삼킨다.
    "an outer catch swallowing what an inner catch rethrows": [
      `try {\n  try {\n    process.kill(pid, "SIGKILL");\n  } catch (error) {\n    if (error.code !== "ESRCH") throw error;\n  }\n} catch {\n  /* ignore */\n}\n`,
      "signal",
    ],
  };
  for (const [shape, [code, kind]] of Object.entries(shapes))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, killErrorRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.equal(message.messageId, kind, shape);
      // 메시지가 이유, 대안과 기준 문서의 절을 알려 준다.
      assert.match(message.message, /EPERM/);
      assert.match(
        message.message,
        kind === "probe" ? /processAlive/ : /killUnlessGone/
      );
      assert.match(message.message, /ESRCH/);
      assert.match(message.message, /CODING_STANDARDS\.md#정리/);
    }
});

test("test code may pass over a finished process by its error code", async () => {
  const allowed = [
    `function alive(pid) {\n  try {\n    process.kill(pid, 0);\n    return true;\n  } catch (error) {\n    if (error.code === "ESRCH") return false;\n    throw error;\n  }\n}\n`,
    `import { killUnlessGone, processAlive } from "@babojubot/process/test-cleanup";\nif (processAlive(pid)) killUnlessGone(pid);\n`,
    `expect(() => process.kill(pid, 0)).not.toThrow();\n`,
    // 끄기가 아닌 조회의 실패는 이 규칙이 보지 않는다.
    `try {\n  parse(text);\n} catch {\n  return undefined;\n}\n`,
    // 같은 이름의 지역 값은 Node의 process가 아니다.
    `function stop(process) {\n  try {\n    process.kill();\n  } catch {\n    /* the fake has no process */\n  }\n}\n`,
    // 안쪽 catch가 오류 코드를 보고 처리한 kill은 바깥 catch 탓이 아니다.
    `try {\n  try {\n    process.kill(pid, "SIGKILL");\n  } catch (error) {\n    if (error.code !== "ESRCH") failures.push(error);\n  }\n  await removeFolder(root);\n} catch {\n  /* the folder was already gone */\n}\n`,
    // 로그를 남기고 모으거나 다른 도움 함수에 넘기면 나중에 실패시킬 수 있다.
    `try {\n  process.kill(pid, "SIGKILL");\n} catch (error) {\n  console.warn(error);\n  failures.push(error);\n}\n`,
    `function alive(pid) {\n  try {\n    process.kill(pid, 0);\n    return true;\n  } catch (error) {\n    log.warn(error);\n    return false;\n  }\n}\n`,
    // 코드를 보고 ESRCH 밖은 "아직 있음"으로 답해 다시 확인한다(packages/runtime/src/providers/recovery.test.ts의 groupGone).
    `const groupGone = (group) => {\n  try {\n    process.kill(-group, 0);\n    return false;\n  } catch (e) {\n    return e.code === "ESRCH";\n  }\n};\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, killErrorRules),
        [],
        `${place}: ${code}`
      );
});

/** 서버 닫기 오류 규칙의 메시지만. */
const closeErrorRules = ["tests/no-ignored-close-error"];
/** 타입 표기를 쓰는 예를 돌릴 TypeScript 자리. */
const typedPlaces = testPlaces.filter((place) => place.endsWith(".ts"));

test("test code may not fulfil a Promise with the error of a Node server's close", async () => {
  /** @type {Record<string, [string, string[]]>} */
  const shapes = {
    // 열리지 않았거나 이미 닫힌 서버면 오류 객체로 이행한다.
    "resolve given to close": [
      `import { createServer } from "node:net";\nconst server = createServer();\nonTestFinished(() => new Promise((resolve) => server.close(resolve)));\n`,
      testPlaces,
    ],
    "a callback that drops the error": [
      `import http from "node:http";\nconst server = http.createServer();\nawait new Promise((r) => server.close(() => r()));\n`,
      testPlaces,
    ],
    // 같은 파일 함수가 돌려준 객체의 서버(scripts/boot-check.test.mjs).
    "a server a same-file function returns": [
      `import http from "node:http";\nasync function occupy() {\n  const server = http.createServer();\n  return { server };\n}\nconst listener = await occupy();\nawait new Promise((resolve) => listener.server.close(resolve));\n`,
      testPlaces,
    ],
    "a parameter typed as a server": [
      `import net from "node:net";\nexport const closing = (probe: net.Server) =>\n  new Promise<void>((resolve) => probe.close(() => resolve()));\n`,
      typedPlaces,
    ],
    // net.Server를 이어받는 다른 서버 모듈(tls·http2)도 같은 close 계약이다(#266 리뷰 SPEC-5).
    "a tls server": [
      `import tls from "node:tls";\nconst server = tls.createServer({});\nawait new Promise((resolve) => server.close(resolve));\n`,
      testPlaces,
    ],
    "a renamed http2 server": [
      `import { createSecureServer as secure } from "node:http2";\nconst server = secure({});\nawait new Promise((resolve) => server.close(resolve));\n`,
      testPlaces,
    ],
    "a parameter typed as a tls server": [
      `import type { Server } from "node:tls";\nexport const closing = (probe: Server) =>\n  new Promise<void>((resolve) => probe.close(() => resolve()));\n`,
      typedPlaces,
    ],
    "servers from a typed list": [
      `import http from "node:http";\nimport type { Server } from "node:net";\nconst servers: http.Server[] = [];\nconst wires: { server: Server }[] = [];\nfor (const wire of wires.splice(0)) await new Promise((resolve) => wire.server.close(resolve));\nawait attemptAll(servers.map((server) => () => new Promise((resolve) => server.close(resolve))));\n`,
      typedPlaces,
    ],
  };
  for (const [shape, [code, places]] of Object.entries(shapes))
    for (const place of places) {
      const messages = await lint(code, place, closeErrorRules);
      assert.ok(messages.length > 0, `${place}: ${shape} not reported`);
      for (const message of messages) {
        // 메시지가 이유, 대안과 기준 문서의 절을 알려 준다.
        assert.match(message.message, /Promise가 이행/);
        assert.match(message.message, /reject\(error\)/);
        assert.match(message.message, /attemptAll/);
        assert.match(message.message, /CODING_STANDARDS\.md#정리/);
      }
    }
  const typedList = shapes["servers from a typed list"];
  assert.ok(typedList, "no typed list case");
  assert.equal(
    (await lint(typedList[0], typedPlaces[0], closeErrorRules)).length,
    2
  );
});

test("test code may reject with a close error and leave other close callbacks alone", async () => {
  const allowed = [
    `import http from "node:http";\nconst server = http.createServer();\nawait new Promise((resolve, reject) =>\n  server.close((error) => (error ? reject(error) : resolve()))\n);\n`,
    `import http from "node:http";\nconst server = http.createServer();\nawait new Promise((resolve) =>\n  server.close((error) => {\n    if (error) failures.push(error);\n    resolve();\n  })\n);\n`,
    // 출처를 모르는 값과 성공만 알리는 close(dgram 소켓)는 보지 않는다.
    `await new Promise((resolve) => watcher.close(resolve));\n`,
    `import dgram from "node:dgram";\nconst socket = dgram.createSocket("udp4");\nawait new Promise((resolve) => socket.close(resolve));\n`,
    // 같은 이름의 지역 값은 서버 모듈이 아니다.
    `const tls = { createServer: () => watcher };\nconst server = tls.createServer();\nawait new Promise((resolve) => server.close(resolve));\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, closeErrorRules),
        [],
        `${place}: ${code}`
      );
});

test("code outside tests may chain cleanups and ignore kill and close errors", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ]) {
    const messages = await lint(
      `import http from "node:http";\nafterEach(async () => {\n  await a.close();\n  await b.close();\n});\ntry {\n  process.kill(pid, 0);\n} catch {\n  /* gone */\n}\nconst server = http.createServer();\nawait new Promise((resolve) => server.close(resolve));\n`,
      place,
      [...skippedCleanupRules, ...killErrorRules, ...closeErrorRules]
    );
    assert.deepEqual(messages, [], place);
  }
});

/** 기대 실패 규칙의 메시지만. */
const expectedFailureRules = ["tests/no-expected-failure"];

test("test code may not mark a test as expected to fail", async () => {
  const shapes = {
    // 본문 맨 앞에 두면 그 뒤의 어느 실패든 기대한 실패가 된다.
    "Playwright test.fail in the body": `test("saves", async () => {\n  test.fail(true, "on purpose");\n  await save();\n});\n`,
    "Playwright test.fail declaring a test": `test.fail("saves", async () => {\n  await save();\n});\n`,
    "test.fail.only": `test.fail.only("saves", async () => {\n  await save();\n});\n`,
    "a test made by extend": `settingsTest.fail("saves", async () => {\n  await save();\n});\n`,
    "Vitest it.fails": `it.fails("saves", async () => {\n  await save();\n});\n`,
    // 시험 함수는 이름이 아니라 출처로 본다: vitest·node:test에서 다른 이름으로 가져와도 시험 함수다.
    // 저장소 지원 파일이 넓혀 내보낸 시험 함수는 상대 경로든 패키지 이름이든 같다.
    "a test a workspace package extends": `import { settingsTest } from "@babojubot/process/testing";\nsettingsTest.fail("saves", async () => {\n  await save();\n});\n`,
    "Vitest it imported under another name": `import { it as check } from "vitest";\ncheck.fails("saves", async () => {\n  await save();\n});\n`,
  };
  for (const [shape, code] of Object.entries(shapes))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, expectedFailureRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 까닭, 대안(따로 돌린 실행의 종료 코드·고유 문구)과 기준 문서의 절을 알려 준다.
      assert.match(message.message, /어떤 이유로 실패해도/);
      assert.match(message.message, /runPlaywright/);
      assert.match(message.message, /rejects\.toThrow/);
      assert.match(message.message, /CODING_STANDARDS\.md#단언/);
    }
});

test("test code may fail on purpose through other values and check a failure by its message", async () => {
  const allowed = [
    `import assert from "node:assert/strict";\nassert.fail("unexpectedly succeeded");\n`,
    `gate.fail();\nrun.fails = 1;\n`,
    `await expect(save()).rejects.toThrow("저장 실패");\n`,
    `test.skip(process.platform === "win32", "Windows에서는 막을 수 없다");\n`,
    // 시험 함수 이름을 가린 지역 매개변수의 `fails`는 시험 표시가 아니다.
    `export function count(it) {\n  return it.fails;\n}\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(await lint(code, place, expectedFailureRules), [], code);
});

/** 시험 사이 상태 규칙의 메시지만. */
const stateRules = ["tests/no-state-between-tests"];

test("test code may not pass state from one test to another", async () => {
  const shared = {
    "a value one test sets and another reads": `let before;\ntest("changes", async () => {\n  before = await read();\n  await change();\n});\ntest("restores", async () => {\n  expect(await read()).toEqual(before);\n});\n`,
    "a value set inside a callback of a test": `let lateWrite;\ntest("sends", async ({ page }) => {\n  await page.route("**", (route) => {\n    lateWrite = send(route);\n  });\n});\ntest("waits", async () => {\n  await lateWrite;\n});\n`,
    "a describe-level value": `describe("outbox", () => {\n  let claim;\n  it("claims", async () => {\n    claim = await claimOne();\n  });\n  it("settles", async () => {\n    await settle(claim);\n  });\n});\n`,
    "a value that a beforeAll prepared and a test replaces": `let server;\nbeforeAll(async () => {\n  server = await start();\n});\nit("restarts", async () => {\n  server = await restart(server);\n});\nit("reads", async () => {\n  expect(await server.get()).toBe(1);\n});\n`,
    "test.each": `let last;\ntest.each([1, 2])("stores %s", async (n) => {\n  last = await store(n);\n});\ntest("reads", () => {\n  expect(last).toBe(2);\n});\n`,
    // 시험 문맥을 받는 표 시험(`test.for`)과 저장소 지원 파일이 넓힌 시험 함수의 표 시험(#286 PR 3b-3b-2 설계 점검 1회차 [4]).
    "test.for": `let last;\ntest.for([1, 2])("stores %s", async (n) => {\n  last = await store(n);\n});\ntest("reads", () => {\n  expect(last).toBe(2);\n});\n`,
    "an extended test's for": `import { holdsTest } from "./connect-failure-support.ts";\nlet last;\nholdsTest.for([1, 2])("stores %s", async (n, { holds }) => {\n  last = await store(n, holds);\n});\ntest("reads", () => {\n  expect(last).toBe(2);\n});\n`,
  };
  const serial = {
    "serial mode": `test.describe.configure({ mode: "serial" });\ntest("a", () => {});\n`,
    "a serial group": `test.describe.serial("steps", () => {\n  test("a", () => {});\n});\n`,
  };
  /** @type {Array<[string, Record<string, string>, RegExp]>} */
  const kinds = [
    ["shared", shared, /다른 시험이 대입한 값/],
    ["serial", serial, /차례대로 묶습니다/],
  ];
  for (const [kind, shapes, pattern] of kinds)
    for (const [shape, code] of Object.entries(shapes))
      for (const place of testPlaces) {
        const [message, ...rest] = await lint(code, place, stateRules);
        assert.ok(message, `${place}: ${shape} not reported`);
        assert.deepEqual(rest, [], `${place}: ${shape}`);
        assert.match(message.message, pattern, `${kind}: ${shape}`);
        // 메시지가 혼자 돌릴 때 실패하는 까닭, 대안과 기준 문서의 절을 알려 준다.
        assert.match(message.message, /beforeEach·fixture/, shape);
        assert.match(message.message, /CODING_STANDARDS\.md#격리/);
      }
});

test("test code may prepare state in hooks and keep each test's own values", async () => {
  const allowed = [
    // hook이 시험마다 만들고 정리한다.
    `let t;\nbeforeEach(async () => {\n  t = await createTestDatabase();\n});\nit("a", async () => {\n  await use(t);\n});\nit("b", async () => {\n  await use(t);\n});\n`,
    // 파일 하나에 한 번 준비하고 시험은 읽기만 한다.
    `let server;\nbeforeAll(async () => {\n  server = await start();\n});\nafterAll(() => server.close());\nit("a", async () => {\n  await server.get();\n});\nit("b", async () => {\n  await server.get();\n});\n`,
    // 시험마다 자기 서버를 대입하고 afterEach가 닫고 비운다. 도움 함수가 대입하는 시험도 같다.
    `let t;\nafterEach(async () => {\n  await t?.close();\n  t = undefined;\n});\nasync function session() {\n  t = await startTestServer();\n  return t;\n}\nit("a", async () => {\n  t = await startTestServer();\n  await t.get();\n});\nit("b", async () => {\n  await session();\n  await t.get();\n});\n`,
    // 시험이 남긴 것을 afterEach가 쓴다(본문이 끝난 뒤 보내기).
    `let sendLate;\ntest.afterEach(() => {\n  sendLate?.();\n  sendLate = undefined;\n});\ntest("a", async () => {\n  sendLate = () => send();\n});\n`,
    // 시험 안의 변수, 한 시험이 쓰고 읽는 바깥 변수, 다른 모드.
    `let count = 0;\ntest("a", () => {\n  let local;\n  local = 1;\n  count += local;\n  expect(count).toBe(1);\n});\ntest("b", () => {\n  let local = 2;\n  expect(local).toBe(2);\n});\ntest.describe.configure({ mode: "parallel", timeout: 1000 });\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(await lint(code, place, stateRules), [], code);
});

test("code outside tests may share state between calls and mark failures", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ]) {
    const messages = await lint(
      `let before;\ntest("a", () => {\n  before = 1;\n});\ntest("b", () => {\n  read(before);\n});\ntest.fail("c", () => {});\ntest.describe.configure({ mode: "serial" });\n`,
      place,
      [...stateRules, ...expectedFailureRules]
    );
    assert.deepEqual(messages, [], place);
  }
});

// ---------- 시험 데이터의 타입 단언 (#243) ----------

/** 시험 데이터 단언은 금지 구문 규칙의 한 갈래다. */
const fixtureRules = ["no-restricted-syntax"];
/** 시험 데이터 단언 규칙의 메시지만. */
const fixtureMessages = (messages) =>
  messages.filter(
    (m) =>
      m.ruleId === "no-restricted-syntax" &&
      /CODING_STANDARDS\.md#시험-데이터/.test(m.message)
  );
/** TypeScript 시험 코드 자리. 타입 단언은 .mjs에 쓸 수 없다. */
const typedTestPlaces = testPlaces.filter((place) => place.endsWith(".ts"));

const fixtureAssertions = {
  // 감사가 찾은 모양: 일부 필드만 넣은 객체를 unknown을 거쳐 실제 타입으로 바꾼다.
  "a partial object through unknown": `type Item = { kind: "a"; id: string; at: string };\nexport const item = { kind: "a" } as unknown as Item;\n`,
  "a value through any": `declare const value: string;\nexport const n = value as any as number;\n`,
  "angle-bracket assertions through unknown": `declare const value: string;\nexport const n = <number>(<unknown>value);\n`,
  "a mixed as and angle-bracket pair": `declare const value: string;\nexport const n = <number>(value as unknown);\n`,
  // 객체 리터럴에 바로 붙인 단언은 필드를 빠뜨려도 통과한다.
  "an object literal as its type": `type Result = { stopReason: string; error: string | null };\nexport const result = { stopReason: "cancelled" } as Result;\n`,
  "an object literal argument": `type Options = { a: number };\ndeclare function f(options: Options): void;\nf({} as Options);\n`,
  "an angle-bracket object literal": `type Options = { a: number };\nexport const options = <Options>{};\n`,
  // never는 어느 자리에도 들어가 그 자리의 타입 검사를 끈다. 쓰지 않는 의존성 채우기와 일부러 넣는 틀린 값이 이 모양이었다.
  "a placeholder as never": `declare class Workspaces {\n  constructor(root: string, db: { query(): void });\n}\nexport const w = new Workspaces("root", null as never);\n`,
  "an object literal as never": `declare function set(value: { color: "sky" }): void;\nset({ color: "neon" } as never);\n`,
  "an angle-bracket never": `declare const value: string;\nexport const n: number = <never>value;\n`,
};

for (const [shape, code] of Object.entries(fixtureAssertions))
  test(`test code may not build data with ${shape}`, async () => {
    for (const place of typedTestPlaces) {
      const [message, ...rest] = fixtureMessages(
        await lint(code, place, fixtureRules)
      );
      assert.ok(message, `${place}: not reported`);
      assert.deepEqual(rest, [], place);
      // 메시지가 이유와 대안(satisfies·완전한 값·좁은 매개변수 타입)을 알려 준다.
      assert.match(message.message, /필드/);
      assert.match(message.message, /satisfies T/);
      assert.match(message.message, /fakeDeclarations/);
      assert.match(message.message, /Pick<T, …>/);
      // never는 쓰지 않는 의존성의 대역과 일부러 넣는 틀린 값의 자리를 알려 준다.
      if (shape.includes("never")) {
        assert.match(message.message, /unused/);
        assert.match(message.message, /outsideContract/);
      }
    }
  });

test("test code may check data against its type, add properties with one assertion and narrow known values", async () => {
  const allowed = [
    // 완전한 값과 그 타입의 확인.
    `type Result = { stopReason: string; error: string | null };\nexport const a: Result = { stopReason: "cancelled", error: null };\nexport const b = { stopReason: "cancelled", error: null } satisfies Result;\n`,
    // as const, 객체 리터럴을 unknown·any로 바꾸기(T라고 주장하지 않는다).
    `export const a = { kind: "a" } as const;\nexport const b = { kind: "a" } as unknown;\nexport const c = { kind: "a" } as any;\n`,
    // 이름 붙은 대역과 타입 밖 값(stand-ins.ts의 모양): 단언 하나가 그 함수 안에만 있다.
    `export function unused<T extends object>(name: string): T {\n  const target: object = Object.create(null);\n  return new Proxy(target, { get: () => { throw new Error(name); } }) as T;\n}\nexport const outsideContract = <T>(value: unknown): T => value as T;\n`,
    // never를 돌려주는 함수와 never 타입 표기는 단언이 아니다.
    `export const fail = (message: string): never => {\n  throw new Error(message);\n};\nexport function assertNever(value: never): never {\n  throw new Error(String(value));\n}\n`,
    // 있는 객체에 속성을 덧붙여 읽기, 이미 검사한 값·식의 단언 한 번, 빈 배열의 원소 타입, non-null.
    `declare const window: { name: string };\nexport const marker = (window as typeof window & { marker: number }).marker;\nexport const parsed = JSON.parse("{}") as { a: number };\nexport const list = [] as string[];\ndeclare const maybe: string | undefined;\nexport const sure = maybe!;\n`,
    // 단언 하나 안의 unknown(이중 단언이 아님).
    `declare const value: unknown;\nexport const n = value as number;\n`,
  ];
  for (const code of allowed)
    for (const place of typedTestPlaces)
      assert.deepEqual(
        fixtureMessages(await lint(code, place, fixtureRules)),
        [],
        code
      );
});

test("product code may assert types", async () => {
  // 제품 코드는 시험 데이터 규칙을 받지 않는다(타입 정보로 검사하므로 있는 파일 자리를 빌린다).
  assert.deepEqual(
    fixtureMessages(
      await lint(
        fixtureAssertions["a partial object through unknown"],
        "packages/runtime/src/providers/login.ts",
        fixtureRules
      )
    ),
    []
  );
});

// ---------- 프로세스 환경 직접 변경 (#243) ----------

/** process.env 직접 변경 규칙의 메시지만. */
const envRules = ["tests/no-process-env-change"];

const envChanges = {
  // 감사가 찾은 모양: 원래 값을 덮어쓰고, 복원은 서버 닫기 뒤에서 지운다.
  "an assignment to an entry": `process.env.OPENCODE_CONFIG_CONTENT = "{}";\n`,
  "a computed entry": `const name = "SETTING";\nprocess.env[name] = "1";\n`,
  "a compound assignment": `process.env.PATH += ":/extra";\n`,
  "an update": `process.env.COUNT++;\n`,
  "a deleted entry": `delete process.env.OPENCODE_CONFIG_CONTENT;\n`,
  "a deleted computed entry": `const name = "SETTING";\ndelete process.env[name];\n`,
  // 시험이 저장해 둔 사본으로 환경 전체를 바꾸기.
  "a replaced environment": `const saved = { ...process.env };\nprocess.env = { ...saved };\n`,
  "a computed env member": `process["env"].SETTING = "1";\n`,
  "Object.assign": `Object.assign(process.env, { SETTING: "1" });\n`,
  "Reflect.set": `Reflect.set(process.env, "SETTING", "1");\n`,
  "Reflect.deleteProperty": `Reflect.deleteProperty(process.env, "SETTING");\n`,
  // 계산된 문자열 메서드 이름.
  'Object["assign"]': `Object["assign"](process.env, { SETTING: "1" });\n`,
  'Reflect["set"]': `Reflect["set"](process.env, "SETTING", "1");\n`,
  // 전역 객체를 거친 process.
  "globalThis.process": `globalThis.process.env.SETTING = "1";\n`,
  "a deleted entry through global": `delete global.process.env["SETTING"];\n`,
  "Object.assign through globalThis": `Object.assign(globalThis.process.env, { SETTING: "1" });\n`,
  // node:process에서 가져온 env·process(다른 이름으로 가져와도).
  "an imported env": `import { env } from "node:process";\nenv.SETTING = "1";\n`,
  "an imported env under another name": `import { env as variables } from "process";\ndelete variables.SETTING;\n`,
  "a default-imported process": `import proc from "node:process";\nproc.env.SETTING = "1";\n`,
  "a namespace-imported process": `import * as proc from "node:process";\nproc.env = {};\n`,
  // 같은 파일에서 그 값을 받은 변수.
  "a destructured env": `const { env } = process;\nenv.SETTING = "1";\n`,
  "a renamed destructured env from globalThis": `const { env: variables } = globalThis.process;\nconst name = "SETTING";\ndelete variables[name];\n`,
  "a variable holding process.env": `const env = process.env;\nReflect.set(env, "SETTING", "1");\n`,
  "a variable holding process": `const proc = process;\nproc.env.SETTING = "1";\n`,
};

for (const [shape, code] of Object.entries(envChanges))
  test(`test code may not change process.env with ${shape}`, async () => {
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, envRules);
      assert.ok(message, `${place}: not reported`);
      assert.deepEqual(rest, [], place);
      // 메시지가 이유와 대안(stub과 복원, 자식 환경, globalSetup이 넘기는 값)을 알려 준다.
      assert.match(message.message, /원래 값을 잃고/);
      assert.match(message.message, /vi\.stubEnv/);
      assert.match(message.message, /vi\.unstubAllEnvs/);
      assert.match(message.message, /새 객체/);
      assert.match(message.message, /provide/);
      assert.match(message.message, /CODING_STANDARDS\.md#격리/);
    }
  });

test("test code may read process.env, stub it, build a child's environment from it and change values of the same names that are not it", async () => {
  const allowed = [
    // 읽기와 runner의 stub·복원.
    `export const home = process.env.HOME;\nexport const has = "PATH" in process.env;\n`,
    `import { onTestFinished, vi } from "vitest";\nvi.stubEnv("SETTING", "1");\nonTestFinished(() => {\n  vi.unstubAllEnvs();\n});\n`,
    // 자식에 줄 환경은 새 객체로 만들고 그 객체를 바꾼다.
    `const env = { ...process.env, SETTING: "1" };\nenv.OTHER = "2";\ndelete env.PATH;\nObject.assign(env, { MORE: "3" });\nexport { env };\n`,
    // 다른 객체의 env 속성.
    `const options = { env: {} };\noptions.env = { SETTING: "1" };\noptions.env.SETTING = "2";\n`,
    // 같은 이름의 지역 값·매개변수(그림자 바인딩).
    `const process = { env: {} };\nprocess.env.SETTING = "1";\ndelete process.env.SETTING;\n`,
    `export function set(process, env) {\n  process.env.SETTING = "1";\n  env.SETTING = "1";\n  Object.assign(env, {});\n}\n`,
    `const globalThis = { process: { env: {} } };\nglobalThis.process.env.SETTING = "1";\n`,
    // 다른 모듈의 env, 다른 객체에서 꺼낸 env, 다른 이름의 속성.
    `import { env } from "./config.js";\nenv.SETTING = "1";\n`,
    `const config = { env: {} };\nconst { env } = config;\nenv.SETTING = "1";\n`,
    `const { argv } = process;\nargv[0] = "node";\ndelete argv[1];\n`,
    // 바꾸지 않는 메서드는 계산된 이름이어도 짚지 않는다.
    `export const keys = Object["keys"](process.env);\nexport const has = Reflect["has"](process.env, "PATH");\n`,
    // 새 값을 다시 받은 변수는 더는 process.env가 아니다.
    `let env = process.env;\nenv = { ...env };\nenv.SETTING = "1";\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, envRules),
        [],
        `${place}: ${code}`
      );
});

test("code outside tests may set process.env", async () => {
  assert.deepEqual(
    await lint(
      envChanges["an assignment to an entry"],
      "scripts/lint-sample.mjs",
      envRules
    ),
    []
  );
});

/** 기다리지 않은 Promise 규칙(타입 정보)의 메시지만. */
const promiseRules = [
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-misused-promises",
];

// 타입 정보는 TypeScript 프로젝트에 든 파일에만 생기므로 있는 시험 파일 자리를 빌린다. 서버·화면·패키지·E2E.
const promisePlaces = [
  "apps/server/test/main.test.ts",
  "apps/web/src/live-refresh.test.ts",
  "packages/runtime/src/providers/process.test.ts",
  "packages/db/src/client.test.ts",
  "apps/web/e2e/home.spec.ts",
  "apps/web/e2e/support/organization.ts",
];
const isE2E = (place) => place.startsWith("apps/web/e2e/");
// 러너마다 같은 모양을 쓴다. E2E는 Playwright, 나머지는 Vitest의 expect다.
const promiseHead = (place) =>
  `import { expect } from "${isE2E(place) ? "@playwright/test" : "vitest"}";\nimport http from "node:http";\ndeclare const reply: Promise<number>;\ndeclare function work(): Promise<void>;\nexport {};\n`;
const e2eOnly = `import type { Locator } from "@playwright/test";\ndeclare const status: Locator;\n`;

test("tests may not leave a promise unawaited, drop it with void, or hand an async function to a callback that ignores its result", async () => {
  const found = {
    "an unawaited resolves assertion": `expect(reply).resolves.toBe(1);\n`,
    "an unawaited rejects assertion": `expect(reply).rejects.toThrow("x");\n`,
    "an unawaited poll": `expect.poll(() => 1).toBe(1);\n`,
    "background work left running": `work();\n`,
    "a then without a failure handler": `reply.then((value) => value + 1);\n`,
    "work dropped with void": `void work();\n`,
    "an assertion dropped with void": `void expect(reply).resolves.toBe(1);\n`,
    "an async request handler": `http.createServer(async (_req, res) => {\n  await work();\n  res.end();\n});\n`,
    "an async listener": `process.once("beforeExit", async () => {\n  await work();\n});\n`,
  };
  for (const [shape, code] of Object.entries(found))
    for (const place of promisePlaces) {
      const [message, ...rest] = await lint(
        promiseHead(place) + code,
        place,
        promiseRules
      );
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
    }
  // Playwright의 web-first 단언을 기다리지 않은 모양.
  for (const place of promisePlaces.filter(isE2E))
    for (const code of [
      `expect(status).toHaveText("저장됨");\n`,
      `expect(status).not.toBeVisible();\n`,
      `void expect(status).toBeChecked();\n`,
    ]) {
      const [message, ...rest] = await lint(
        promiseHead(place) + e2eOnly + code,
        place,
        promiseRules
      );
      assert.ok(message, `${place}: ${code} not reported`);
      assert.deepEqual(rest, [], `${place}: ${code}`);
    }
});

test("tests may await, return, collect or later await a promise and hand failures of a fake server back to its caller", async () => {
  const allowed = [
    `await expect(reply).resolves.toBe(1);\nawait expect.poll(() => 1).toBe(1);\nawait work();\n`,
    `export function started() {\n  return work();\n}\nexport const arrow = () => work();\n`,
    `await Promise.all([work(), work()]);\n`,
    // 먼저 시작해 두고 뒤에서 기다린다.
    `const later = work();\nawait reply;\nawait later;\n`,
    // 나중에 기다릴 Promise의 표시.
    `import { awaitedLater } from "@babojubot/process/test-cleanup";\nconst exited = awaitedLater(work());\nawait exited;\n`,
    // 실패를 받는 처리기가 있다.
    `reply.then(\n  (value) => value,\n  (error: unknown) => {\n    throw error;\n  }\n);\n`,
    // 가짜 서버의 실패는 요청한 쪽에 응답으로 돌려준다.
    `import { answering } from "@babojubot/runtime/testing";\nhttp.createServer(\n  answering(async (_req, res) => {\n    await work();\n    res.end();\n  })\n);\n`,
  ];
  for (const code of allowed)
    for (const place of promisePlaces)
      assert.deepEqual(
        await lint(promiseHead(place) + code, place, promiseRules),
        [],
        `${place}: ${code}`
      );
  for (const place of promisePlaces.filter(isE2E))
    assert.deepEqual(
      await lint(
        promiseHead(place) +
          e2eOnly +
          `await expect(status).toHaveText("저장됨");\nawait expect(status).not.toBeVisible();\n`,
        place,
        promiseRules
      ),
      [],
      place
    );
});

/** 빈 처리기로 거절 버리기 규칙의 메시지만. */
const droppedRules = ["tests/no-dropped-rejection"];
const droppedHead = `declare const p: Promise<number>;\ndeclare const failures: unknown[];\nexport {};\n`;

test("tests may not drop the rejection of a promise they do not wait for with an empty handler", async () => {
  const found = {
    "an empty catch": `p.catch(() => {});\n`,
    "an empty catch dropped with void": `void p.catch(() => {});\n`,
    "a catch returning undefined": `p.catch(() => undefined);\n`,
    "a catch returning a fixed value": `p.catch(() => false);\n`,
    "a catch that only returns": `p.catch(function () {\n  return;\n});\n`,
    "a catch ignoring its error": `p.catch((_error) => {});\n`,
    "an optional catch": `p?.catch(() => {});\n`,
    "an empty failure handler of then": `p.then(undefined, () => {});\n`,
    "then with both handlers dropping": `p.then(\n  () => 1,\n  () => void 0\n);\n`,
    "a named empty function": `const ignore = () => {};\np.catch(ignore);\n`,
    "a declared empty function": `function ignore() {}\np.catch(ignore);\n`,
    "a catch on a promise another function keeps": `export function keep(q: Promise<number>) {\n  q.catch(() => {});\n  failures.push(q);\n}\n`,
    "a catch on a promise only an inner function returns": `export function keep(q: Promise<number>) {\n  q.catch(() => {});\n  return () => {\n    return q;\n  };\n}\n`,
  };
  for (const [shape, code] of Object.entries(found))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(
        droppedHead + code,
        place,
        droppedRules
      );
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 대안과 기준 문서의 절을 알려 준다.
      assert.match(message.message, /awaitedLater/);
      assert.match(message.message, /CODING_STANDARDS\.md#단언/);
    }
});

test("tests may use a caught value, handle the error, or mark a promise they hand back for a later wait", async () => {
  const allowed = [
    // 값으로 쓴다.
    `export const value = await p.catch(() => undefined);\nexport const text = await p.catch(() => "");\n`,
    `export const later = p.catch(() => 0);\n`,
    // 오류를 받아 남기거나 다시 던진다.
    `p.catch((error: unknown) => {\n  failures.push(error);\n});\n`,
    `p.catch((error: unknown) => {\n  throw new Error("failed", { cause: error });\n});\n`,
    `p.then(undefined, (error: unknown) => failures.push(error));\n`,
    // 같은 Promise를 그대로 돌려줘 나중에 기다리게 한다(awaitedLater).
    `export function awaitedLater<T>(promise: Promise<T>) {\n  promise.catch(() => {});\n  return promise;\n}\n`,
    `export const mark = <T,>(promise: Promise<T>) => {\n  promise.catch(() => {});\n  return promise;\n};\n`,
    // 실패를 받지 않는 finally.
    `p.finally(() => {});\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(droppedHead + code, place, droppedRules),
        [],
        `${place}: ${code}`
      );
});

test("code outside tests may drop a rejection", async () => {
  assert.deepEqual(
    await lint(
      droppedHead + `p.catch(() => {});\n`,
      "scripts/lint-sample.mjs",
      droppedRules
    ),
    []
  );
});

/** 화면 상태 한 번 읽기 규칙의 메시지만. */
const oneShotRules = ["tests/no-one-shot-ui-read"];
const oneShotHead = `import { expect, type Locator, type Page } from "@playwright/test";\ndeclare const page: Page;\ndeclare const box: Locator;\nexport {};\n`;

test("an E2E may not assert a UI state it read once from a locator", async () => {
  /** @type {Record<string, [string, string, string]>} */
  const found = {
    "isChecked into toBe": [
      `expect(await box.isChecked()).toBe(true);\n`,
      "isChecked",
      "toBeChecked",
    ],
    "isVisible negated": [
      `expect(!(await box.isVisible())).toBe(false);\n`,
      "isVisible",
      "toBeVisible",
    ],
    "isHidden truthy": [
      `expect(await box.isHidden()).toBeTruthy();\n`,
      "isHidden",
      "toBeHidden",
    ],
    "isEnabled with not": [
      `expect(await box.isEnabled()).not.toBe(false);\n`,
      "isEnabled",
      "toBeEnabled",
    ],
    isDisabled: [
      `expect(await box.isDisabled()).toBe(false);\n`,
      "isDisabled",
      "toBeDisabled",
    ],
    isEditable: [
      `expect(await box.isEditable()).toBe(true);\n`,
      "isEditable",
      "toBeEditable",
    ],
    "getAttribute compared to another read": [
      `expect(await box.getAttribute("aria-controls")).toBe("panel");\n`,
      "getAttribute",
      "toHaveAttribute",
    ],
    "textContent trimmed": [
      `expect((await box.textContent())!.trim()).toBe("저장됨");\n`,
      "textContent",
      "toHaveText",
    ],
    "innerText with a fallback": [
      `expect((await box.innerText()) ?? "").toContain("저장");\n`,
      "innerText",
      "toHaveText",
    ],
    innerHTML: [
      `expect(await box.innerHTML()).toContain("<b>");\n`,
      "innerHTML",
      "toHaveText",
    ],
    "allTextContents length": [
      `expect((await box.allTextContents()).length).toBe(2);\n`,
      "allTextContents",
      "toHaveText",
    ],
    allInnerTexts: [
      `expect(await box.allInnerTexts()).toEqual(["a"]);\n`,
      "allInnerTexts",
      "toHaveText",
    ],
    "inputValue converted": [
      `expect(Number(await box.inputValue())).toBeGreaterThan(1);\n`,
      "inputValue",
      "toHaveValue",
    ],
    "count with any matcher": [
      `expect(await box.count()).toBeGreaterThan(3);\n`,
      "count",
      "toHaveCount",
    ],
    "a soft assertion": [
      `expect.soft(await box.count()).toBe(1);\n`,
      "count",
      "toHaveCount",
    ],
    "page title": [
      `expect(await page.title()).toBe("홈");\n`,
      "title",
      "toHaveTitle",
    ],
    "an asserted type": [
      `expect((await box.getAttribute("id")) as string).toBe("x");\n`,
      "getAttribute",
      "toHaveAttribute",
    ],
    "an optional chain": [
      `expect((await box.textContent())?.trim()).toBe("x");\n`,
      "textContent",
      "toHaveText",
    ],
    "a computed method name": [
      `expect(await box["isChecked"]()).toBe(true);\n`,
      "isChecked",
      "toBeChecked",
    ],
    // 변수에 담아 읽는 우회.
    "a read kept in a variable": [
      `const checked = await box.isChecked();\nexpect(checked).toBe(true);\n`,
      "isChecked",
      "toBeChecked",
    ],
    "a read assigned later": [
      `let id: string | null = null;\nid = await box.getAttribute("id");\nexpect(id).toBeTruthy();\n`,
      "getAttribute",
      "toHaveAttribute",
    ],
    "a read through two variables": [
      `const n = await box.count();\nconst total = n + 1;\nexpect(total).toBe(3);\n`,
      "count",
      "toHaveCount",
    ],
    // 같은 파일의 도움 함수로 감싸는 우회.
    "a helper returning a read": [
      `const idOf = (l: Locator) => l.getAttribute("id");\nexpect(await idOf(box)).toBe("x");\n`,
      "getAttribute",
      "toHaveAttribute",
    ],
    "an async helper returning a read": [
      `async function countOf(l: Locator) {\n  return l.count();\n}\nconst n = await countOf(box);\nexpect(n).toBe(1);\n`,
      "count",
      "toHaveCount",
    ],
    // 다시 시도하는 자리 밖에서 읽고 그 안에서 단언하면 다시 읽지 않는다.
    "a read outside the retried block": [
      `const n = await box.count();\nawait expect(async () => {\n  expect(n).toBe(1);\n}).toPass();\n`,
      "count",
      "toHaveCount",
    ],
  };
  for (const [shape, [code, method, matcher]] of Object.entries(found))
    for (const place of e2ePlaces) {
      const [message, ...rest] = await lint(
        oneShotHead + code,
        place,
        oneShotRules
      );
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, new RegExp(`${method}\\(\\)`), shape);
      // 메시지가 대안과 기준 문서의 절을 알려 준다.
      assert.match(message.message, new RegExp(matcher), shape);
      assert.match(message.message, /expect\.poll/);
      assert.match(message.message, /CODING_STANDARDS\.md#화면/);
    }
});

test("an E2E may wait with web-first assertions, compare against a value read before an action, and read inside a retried block", async () => {
  const allowed = [
    `await expect(box).toBeChecked();\nawait expect(box).toHaveAttribute("id", /.+/);\nawait expect(box).toHaveCount(2);\nawait expect(page).toHaveTitle("홈");\n`,
    // 동작 전에 읽은 순간 값은 기대값 자리에 둔다.
    `const before = await box.isChecked();\nawait box.click();\nawait expect(box).toBeChecked({ checked: !before });\n`,
    `const loaded = await box.count();\nawait expect.poll(() => box.count()).toBeGreaterThan(loaded);\n`,
    `await expect(box).toHaveAttribute("aria-controls", (await box.getAttribute("id"))!);\n`,
    // 다시 시도하는 자리 안에서 읽고 단언한다.
    `await expect.poll(async () => (await box.textContent())?.trim()).toBe("x");\n`,
    `await expect(async () => {\n  expect(await box.count()).toBe(1);\n}).toPass();\n`,
    `const check = async () => {\n  const n = await box.count();\n  expect(n).toBe(1);\n};\nawait expect(check).toPass();\n`,
    `const read = (l: Locator) => l.getAttribute("d");\nawait expect(async () => {\n  expect(await read(box)).toBe("M0");\n}).toPass();\n`,
    `async function settledCount() {\n  expect(await box.count()).toBe(1);\n}\nawait expect(settledCount).toPass();\n`,
    `await expect\n  .poll(async () => {\n    const n = await box.count();\n    expect(n).toBeGreaterThan(0);\n    return n;\n  })\n  .toBe(2);\n`,
    // 흐름을 가르는 읽기, 단언하지 않는 읽기.
    `if ((await box.getAttribute("aria-expanded")) !== "true") await box.click();\nconst name = await box.textContent();\nawait page.getByRole("link", { name: name! }).click();\n`,
    // Playwright locator가 아닌 같은 이름의 메서드.
    `const fake = { count: async () => 1, isChecked: async () => true };\nexpect(await fake.count()).toBe(1);\nexpect(await fake.isChecked()).toBe(true);\n`,
  ];
  for (const code of allowed)
    for (const place of e2ePlaces)
      assert.deepEqual(
        await lint(oneShotHead + code, place, oneShotRules),
        [],
        `${place}: ${code}`
      );
});

test("test code may not end a start on a fixed time or count event loop turns in a row", async () => {
  /** @type {Record<string, [string, RegExp]>} */
  const found = {
    // 중단 시한의 이유로 거절되기를 기대한다.
    "an expected timeout": [
      `await expect(server.start(AbortSignal.timeout(200))).rejects.toMatchObject({ name: "TimeoutError" });\n`,
      /정해진 시간 뒤에 중단/,
    ],
    "an expected abort in an options object": [
      `await expect(run({ signal: AbortSignal.timeout(50) })).rejects.toThrow(/AbortError/);\n`,
      /정해진 시간 뒤에 중단/,
    ],
    "a timed signal kept in a const": [
      `const signal = AbortSignal.timeout(100);\nawait expect(server.start(signal)).rejects.toHaveProperty("name", "TimeoutError");\n`,
      /정해진 시간 뒤에 중단/,
    ],
    "assert.rejects with the abort's name": [
      `await assert.rejects(server.start(AbortSignal.timeout(200)), { name: "AbortError" });\n`,
      /정해진 시간 뒤에 중단/,
    ],
    // 잇달아 차례 넘기기.
    "two zero timers in a row": [
      `await new Promise((r) => setTimeout(r, 0));\nawait new Promise((r) => setTimeout(r, 0));\n`,
      /정해진 횟수/,
    ],
    "mixed turns in a block": [
      `{\n  await Promise.resolve();\n  await new Promise((r) => setImmediate(r));\n  await new Promise((r) => process.nextTick(r));\n}\n`,
      /정해진 횟수/,
    ],
  };
  for (const [shape, [code, kind]] of Object.entries(found))
    for (const place of testPlaces) {
      const [message, ...rest] = await lint(code, place, waitRules);
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, kind, shape);
      assert.match(message.message, /신호/);
      assert.match(message.message, /CODING_STANDARDS\.md#순서/);
    }
});

test("test code may bound a wait with a timed signal, expect another failure under it, and take a single turn", async () => {
  const allowed = [
    // 성공을 기다리는 상한, 다른 이유의 거절을 기대하는 상한.
    `await expect(check(AbortSignal.timeout(10_000))).resolves.toBeUndefined();\nawait expect(check(AbortSignal.timeout(10_000))).rejects.toThrow(/not on this computer/);\nawait expect(check(AbortSignal.timeout(10_000))).rejects.toThrow();\n`,
    // 신호를 받은 뒤 중단한다.
    `const scene = new AbortController();\nconst starting = server.start(scene.signal);\nawait arrived;\nscene.abort(new Error("stop"));\nawait expect(starting).rejects.toThrow("stop");\n`,
    // 같은 이름의 지역 AbortSignal.
    `const AbortSignal = { timeout: (ms: number) => ms };\nawait expect(start(AbortSignal.timeout(1))).rejects.toMatchObject({ name: "TimeoutError" });\n`,
    // 차례 하나, 사이에 다른 일이 있는 차례.
    `await new Promise((r) => setImmediate(r));\nexpect(done).toBe(false);\nawait new Promise((r) => setImmediate(r));\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, waitRules),
        [],
        `${place}: ${code}`
      );
});

// JS 시험(node:test·가짜 서버)도 타입 정보로 본다. scripts는 그 폴더의 tsconfig.json, 시험 폴더의 .mjs는 기본 프로젝트다. agent 도구의
// 시험은 TypeScript다(scripts/script-lint-rules.test.mjs가 Promise 규칙을 본다).
const jsPromisePlaces = [
  "scripts/gh-post.test.mjs",
  "scripts/live/processes.test.mjs",
  "apps/server/test/chaos-harness.test.mjs",
  "apps/web/e2e/support/misbehaving-server.mjs",
];
const jsPromiseHead = `import assert from "node:assert/strict";\nimport { describe, test } from "node:test";\nasync function work() {}\n`;

test("JS tests may not leave a promise unawaited either, while node:test's own test calls stay as they are", async () => {
  const found = [
    `work();\n`,
    `void work();\n`,
    `assert.rejects(work());\n`,
    `process.once("beforeExit", async () => {\n  await work();\n});\n`,
  ];
  for (const code of found)
    for (const place of jsPromisePlaces) {
      const [message, ...rest] = await lint(
        jsPromiseHead + code,
        place,
        promiseRules
      );
      assert.ok(message, `${place}: ${code} not reported`);
      assert.deepEqual(rest, [], `${place}: ${code}`);
    }
  const allowed = `await work();\nawait assert.rejects(work());\ntest("runs", async () => {\n  await work();\n});\ndescribe("group", () => {\n  test("inside", () => {});\n});\n`;
  for (const place of jsPromisePlaces)
    assert.deepEqual(
      await lint(jsPromiseHead + allowed, place, promiseRules),
      [],
      place
    );
});

/** awaitedLater 규칙의 메시지만. */
const laterRules = ["tests/no-unawaited-later"];
const laterImport = `import { awaitedLater } from "@babojubot/process/test-cleanup";\n`;
const laterHead = `const p = Promise.resolve(1);\nconst use = (value) => value;\nconst child = {};\n`;

test("a promise marked with awaitedLater must be stored and awaited later in the same file", async () => {
  /** @type {Record<string, [string, string]>} */
  const found = {
    "a dropped call": [
      `${laterImport}${laterHead}awaitedLater(p);\n`,
      "notStored",
    ],
    "an awaited call": [
      `${laterImport}${laterHead}await awaitedLater(p);\n`,
      "notStored",
    ],
    "a call passed on": [
      `${laterImport}${laterHead}use(awaitedLater(p));\n`,
      "notStored",
    ],
    "a let": [
      `${laterImport}${laterHead}let later = awaitedLater(p);\nawait later;\n`,
      "notStored",
    ],
    "a const never awaited": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nuse(later);\n`,
      "notAwaited",
    ],
    "a const only chained": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nlater.then(() => 1);\n`,
      "notAwaited",
    ],
    "a property never awaited": [
      `${laterImport}${laterHead}child.exited = awaitedLater(p);\nuse(child.exited);\n`,
      "notAwaited",
    ],
    "a same-name property of another object": [
      `${laterImport}${laterHead}const other = {};\nchild.exited = awaitedLater(p);\nawait other.exited;\n`,
      "notAwaited",
    ],
    "the same object under another name": [
      `${laterImport}${laterHead}child.exited = awaitedLater(p);\nconst alias = child;\nawait alias.exited;\n`,
      "notAwaited",
    ],
    "a shorter path": [
      `${laterImport}${laterHead}child.run = {};\nchild.run.exited = awaitedLater(p);\nawait child.exited;\n`,
      "notAwaited",
    ],
    "a property of a call result": [
      `${laterImport}${laterHead}const make = () => child;\nmake().exited = awaitedLater(p);\nawait make().exited;\n`,
      "notAwaited",
    ],
    "a computed property": [
      `${laterImport}${laterHead}const key = "exited";\nchild[key] = awaitedLater(p);\nawait child[key];\n`,
      "notAwaited",
    ],
    // 출처로 판정한다: 다른 이름, 상대 경로, 이름공간, 다시 받은 const.
    "an aliased import": [
      `import { awaitedLater as later } from "@babojubot/process/test-cleanup";\n${laterHead}later(p);\n`,
      "notStored",
    ],
    // 상대 경로로 가져온 것은 자리마다 실제 test-cleanup.ts를 가리키는 경로로 아래 "awaitedLater is told by the file it comes from"이
    // 본다. 모든 자리에 같은 `../test-cleanup.ts`를 쓰면 다른 파일을 가리킨다(경로 철자로 보던 판정이 받던 모양, #266 리뷰 SPEC-5).
    "a namespace import": [
      `import * as cleanup from "@babojubot/process/test-cleanup";\n${laterHead}cleanup.awaitedLater(p);\n`,
      "notStored",
    ],
    "a const alias": [
      `${laterImport}${laterHead}const mark = awaitedLater;\nmark(p);\n`,
      "notStored",
    ],
    "the function passed as a value": [
      `${laterImport}${laterHead}[p].map(awaitedLater);\n`,
      "notCalled",
    ],
    // 출처는 이름공간에서 꺼낸 const, 구조 분해, 이름공간의 별칭, 동적 가져오기까지 따라간다(#269).
    "a const taken from the namespace": [
      `import * as cleanup from "@babojubot/process/test-cleanup";\n${laterHead}const mark = cleanup.awaitedLater;\nmark(p);\n`,
      "notStored",
    ],
    "a name destructured from the namespace": [
      `import * as cleanup from "@babojubot/process/test-cleanup";\n${laterHead}const { awaitedLater: mark } = cleanup;\nmark(p);\n`,
      "notStored",
    ],
    "an alias of the namespace": [
      `import * as cleanup from "@babojubot/process/test-cleanup";\n${laterHead}const tools = cleanup;\ntools.awaitedLater(p);\n`,
      "notStored",
    ],
    "a name destructured from a dynamic import": [
      `${laterHead}const { awaitedLater } = await import("@babojubot/process/test-cleanup");\nawaitedLater(p);\n`,
      "notStored",
    ],
    // 출처로 본다: 이름공간에서 꺼낸 이름의 const 별칭(#266 리뷰 SPEC-4).
    "a const alias of a name taken from the namespace": [
      `import * as cleanup from "@babojubot/process/test-cleanup";\n${laterHead}const { awaitedLater } = cleanup;\nconst mark = awaitedLater;\nmark(p);\n`,
      "notStored",
    ],
    // 공용 가져오기 판정: require·createRequire에서 꺼낸 이름도 같다(#266 리뷰 SPEC-1).
    "a name taken from a renamed createRequire": [
      `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\nconst { awaitedLater: mark } = load("@babojubot/process/test-cleanup");\n${laterHead}mark(p);\n`,
      "notStored",
    ],
    "a name taken from a createRequire function": [
      `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst { awaitedLater: mark } = load("@babojubot/process/test-cleanup");\n${laterHead}mark(p);\n`,
      "notStored",
    ],
    // 다시 내보내면 다른 파일에서 부른 결과를 따라갈 수 없다.
    "a re-export": [
      `export { awaitedLater } from "@babojubot/process/test-cleanup";\n`,
      "notCalled",
    ],
    // 상대 경로의 다시 내보내기는 자리마다 실제 파일을 가리키는 경로로 "awaitedLater is told by the file it comes from"이 본다.
    "a renamed re-export": [
      `export { awaitedLater as later } from "@babojubot/process/test-cleanup";\n`,
      "notCalled",
    ],
    "a re-export of the whole module": [
      `export * from "@babojubot/process/test-cleanup";\n`,
      "notCalled",
    ],
    // 기다림은 그 Promise의 결과를 받는 호출만이다. 무관한 호출의 인자로 넣고 그 호출을 기다려도 기다린 것이 아니다.
    "an await around an unrelated call": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Boolean(later);\n`,
      "notAwaited",
    ],
    "an await around a global method": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait console.log(later);\n`,
      "notAwaited",
    ],
    "an await around a local function that drops its argument": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst noop = (value) => value !== undefined;\nawait noop(later);\n`,
      "notAwaited",
    ],
    // 내장·외부 패키지의 함수는 결과를 받는지 알 수 없다. 이 저장소의 시험 도움만 따라갈 수 없어도 기다림으로 본다.
    "an await around an imported built-in function": [
      `${laterImport}import { inspect } from "node:util";\n${laterHead}const later = awaitedLater(p);\nawait inspect(later);\n`,
      "notAwaited",
    ],
    "an await around a method of a built-in namespace": [
      `${laterImport}import * as fsp from "node:fs/promises";\n${laterHead}const later = awaitedLater(p);\nawait fsp.readFile(later);\n`,
      "notAwaited",
    ],
    // 결과를 받는 자리는 인자 위치까지 맞아야 한다. 조합 함수는 첫 인자 배열만, expect는 첫 인자만, 가져온 도움은 첫 인자만 받는다(#272 외부 리뷰 F1).
    "a second argument of Promise.all": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.all([], later);\n`,
      "notAwaited",
    ],
    "a second argument of Promise.race": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.race([p], later);\n`,
      "notAwaited",
    ],
    "a promise passed to Promise.all without an array": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.all(later);\n`,
      "notAwaited",
    ],
    "the message argument of expect": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait expect(p, later).resolves.toBe(1);\n`,
      "notAwaited",
    ],
    "a later argument of an imported helper": [
      `${laterImport}import { within } from "./support.ts";\n${laterHead}const later = awaitedLater(p);\nawait within(1000, later);\n`,
      "notAwaited",
    ],
    "a later argument of a helper from a namespace import": [
      `${laterImport}import * as support from "./support.ts";\n${laterHead}const later = awaitedLater(p);\nawait support.within(1000, later);\n`,
      "notAwaited",
    ],
    "an await of an array that holds it": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait [later];\n`,
      "notAwaited",
    ],
    "a switch without default that awaits in every case": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nswitch (Math.random() > 0.5) {\n  case true:\n    await later;\n    break;\n  case false:\n    await later;\n}\n`,
      "awaitedInBranch",
    ],
    "nested ifs with one leaf that does not await": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nif (Math.random() > 0.5) {\n  if (Math.random() > 0.5) await later;\n  else use(1);\n} else await later;\n`,
      "awaitedInBranch",
    ],
    "an expect that neither rejects nor resolves": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait expect(later).toBeInstanceOf(Promise);\n`,
      "notAwaited",
    ],
    "a property read that is not then, catch or finally": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait later.constructor;\n`,
      "notAwaited",
    ],
    // 한 분기에서만 기다리면 다른 길에서 거절이 감춰진다.
    "an await in one branch of an if": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nif (Math.random() > 0.5) await later;\n`,
      "awaitedInBranch",
    ],
    "an await behind &&": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst wanted = Math.random() > 0.5;\nwanted && (await later);\n`,
      "awaitedInBranch",
    ],
    "an await in one arm of a conditional expression": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait (Math.random() > 0.5 ? later : p);\n`,
      "awaitedInBranch",
    ],
    "an await in a loop that may not run": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nfor (const _ of []) await later;\n`,
      "awaitedInBranch",
    ],
    "an await only in a catch": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\ntry {\n  use(1);\n} catch {\n  await later;\n}\n`,
      "awaitedInBranch",
    ],
    "a property awaited in one branch": [
      `${laterImport}${laterHead}child.exited = awaitedLater(p);\nif (Math.random() > 0.5) await child.exited;\n`,
      "awaitedInBranch",
    ],
    "a local function that awaits its argument in one branch": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst wait = async (value) => {\n  if (Math.random() > 0.5) await value;\n};\nawait wait(later);\n`,
      "awaitedInBranch",
    ],
    // 실행되지 않는 기다림은 기다림이 아니다(#286 항목 21): 아무도 부르지 않는 함수 안, 그런 함수만 부르는 함수 안, 조기 return 뒤.
    "an await in a function nobody calls": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst never = async () => {\n  await later;\n};\n`,
      "notAwaited",
    ],
    "an await in a function only an uncalled function calls": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nasync function inner() {\n  await later;\n}\nconst outer = () => inner();\n`,
      "notAwaited",
    ],
    // 함수를 읽기만 하는 것(인자로 넘기기·다른 이름에 담기)은 부르는 것이 아니다. 넘겨받은 쪽이 부르는지는 모른다(#291 외부 리뷰 1회차 STD-2).
    "an await in a function that is only logged": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst never = async () => {\n  await later;\n};\nconsole.log(never);\n`,
      "notAwaited",
    ],
    "an await in a function that is only given another name": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nasync function never() {\n  await later;\n}\nconst alias = never;\nuse(alias);\n`,
      "notAwaited",
    ],
    "an await in a named function handed to another function as a callback": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst wait = async () => {\n  await later;\n};\nsetTimeout(wait, 0);\n`,
      "notAwaited",
    ],
    "an await after an early return": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nexport async function run() {\n  return 1;\n  await later;\n}\n`,
      "notAwaited",
    ],
    // 다른 Promise가 먼저 이행할 수 있는 race·any는 표시한 Promise가 정해지기 전에 끝나, 그 뒤의 거절을 기다리지 않고 지나간다.
    // 시한은 거절로 설계한다(공용 within, @babojubot/process/test-support).
    "a Promise.race with a promise that may settle first": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.race([later, Promise.resolve()]);\n`,
      "notAwaited",
    ],
    "a Promise.any with a promise that may fulfil first": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.any([p, later]);\n`,
      "notAwaited",
    ],
    // 한 분기에서만 부르는 함수 안의 기다림은 그 분기에서만 기다린다(#291 외부 리뷰 2회차 STD-3). 함수를 부르는 자리의 분기까지 본다.
    "an await in a function called in one branch": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst wait = async () => {\n  await later;\n};\nif (Math.random() > 0.5) await wait();\n`,
      "awaitedInBranch",
    ],
    "an await in a callback written in one branch": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nif (Math.random() > 0.5)\n  test("waits", async () => {\n    await later;\n  });\n`,
      "awaitedInBranch",
    ],
    "an await in a function only a function called in one branch calls": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nasync function inner() {\n  await later;\n}\nconst outer = async () => {\n  await inner();\n};\nconst wanted = Math.random() > 0.5;\nwanted && (await outer());\n`,
      "awaitedInBranch",
    ],
    // 다른 값이 거절만 하는 race·any도, 그 조합의 거절을 받아 성공으로 바꾸는 자리(expect(…).rejects, .catch, then의 거절 처리기,
    // try/catch)에서는 시한의 거절로 끝나 표시한 Promise를 보지 않고 통과한다(#291 외부 리뷰 2회차 SPEC-1).
    "a deadline race whose rejection an expect takes as success": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait expect(Promise.race([later, new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 1000))])).rejects.toThrow("late");\n`,
      "notAwaited",
    ],
    "a deadline race whose rejection a catch handler takes": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.race([later, new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 1000))]).catch(() => undefined);\n`,
      "notAwaited",
    ],
    "a deadline race whose rejection a then handler takes": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.any([later, new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 1000))]).then(use, () => undefined);\n`,
      "notAwaited",
    ],
    // try/catch로 받으면 거절이 나지 않은 길만 덮는다. catch에서 다시 기다려야 모든 길이다.
    "a deadline race awaited in a try whose catch does not await again": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\ntry {\n  await Promise.race([later, new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 1000))]);\n} catch {\n  use(1);\n}\n`,
      "awaitedInBranch",
    ],
    "a repository timeout helper whose rejection an expect takes as success": [
      `${laterImport}${laterHead}import { within } from "./support.ts";\nconst later = awaitedLater(p);\nawait expect(within(later, 1000)).rejects.toThrow();\n`,
      "notAwaited",
    ],
    "a local timeout helper that fulfils when the time runs out": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst within = async (value, ms) =>\n  Promise.race([value, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]);\nawait within(later, 1000);\n`,
      "notAwaited",
    ],
  };
  for (const [shape, [code, kind]] of Object.entries(found))
    for (const place of testPlaces) {
      const messages = await lint(code, place, laterRules);
      assert.deepEqual(
        messages.map((message) => [message.ruleId, message.messageId]),
        [["tests/no-unawaited-later", kind]],
        `${place}: ${shape}`
      );
    }
});

/** 거절만 할 수 있는 Promise(시한). race·any에서 표시한 Promise보다 먼저 이행할 수 없다. */
const rejectsLate =
  'new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 1000))';

test("a promise marked with awaitedLater may be awaited, collected, expected, returned or read back from its property", async () => {
  const allowed = [
    `const later = awaitedLater(p);\nawait later;\n`,
    `const later = awaitedLater(p);\nawait Promise.all([later, p]);\n`,
    `const later = awaitedLater(p);\nawait expect(later).rejects.toThrow("x");\n`,
    `const later = awaitedLater(p);\nawait use(later.catch(() => undefined));\n`,
    `export function start() {\n  const later = awaitedLater(p);\n  return later;\n}\n`,
    `const later = awaitedLater(p);\nexport const read = () => later;\n`,
    // 속성은 같은 파일의 다른 함수에서 읽어 기다려도 된다.
    `child.exited = awaitedLater(p);\nexport async function wait() {\n  return await Promise.race([child.exited, ${rejectsLate}]);\n}\n`,
    `child.exited = awaitedLater(p);\nawait child.exited;\n`,
    // 같은 이름으로 넘겨받은 객체, 깊은 경로, this.
    `child.exited = awaitedLater(p);\nexport const wait = (child) => Promise.race([child.exited, ${rejectsLate}]);\n`,
    `child.run = {};\nchild.run.exited = awaitedLater(p);\nawait child.run.exited;\n`,
    `export class Server {\n  start() {\n    this.exited = awaitedLater(p);\n  }\n  async stop() {\n    await this.exited;\n  }\n}\n`,
    // 같은 파일의 함수는 받은 인자를 기다리는지 따라가고, 가져온 함수(시한 도움 등)는 따라갈 수 없어 기다림으로 본다.
    `const later = awaitedLater(p);\nconst wait = async (value) => {\n  await value;\n};\nawait wait(later);\n`,
    `const later = awaitedLater(p);\nfunction race(value) {\n  return Promise.race([value, ${rejectsLate}]);\n}\nawait race(later);\n`,
    // race·any는 다른 쪽이 거절만 할 수 있을 때(시한) 표시한 Promise의 결과를 받는다.
    `const later = awaitedLater(p);\nawait Promise.any([later, ${rejectsLate}]);\n`,
    // 함수 안의 기다림은 그 함수를 부르거나 내보내거나 콜백으로 넘기면 된다.
    `const later = awaitedLater(p);\nconst run = async () => {\n  await later;\n};\nawait run();\n`,
    `const later = awaitedLater(p);\nexport async function run() {\n  await later;\n}\n`,
    `const later = awaitedLater(p);\ntest("waits", async () => {\n  await later;\n});\n`,
    `const later = awaitedLater(p);\nasync function inner() {\n  await later;\n}\nexport const outer = () => inner();\n`,
    // 시한 race를 try에서 기다리고 catch에서 표시한 Promise를 다시 기다리면 모든 길이다(#291 외부 리뷰 2회차 SPEC-1).
    `const later = awaitedLater(p);\ntry {\n  await Promise.race([later, ${rejectsLate}]);\n} catch {\n  await later.catch(() => undefined);\n}\n`,
    // 돌려준 함수(반환값, 반환하는 객체 식의 속성 값)는 내보내기처럼 받은 쪽이 부른다.
    `export function start() {\n  const later = awaitedLater(p);\n  const stop = async () => {\n    await later;\n  };\n  return { stop };\n}\n`,
    // 함수를 부르는 자리가 모든 분기를 덮으면 된다(#291 외부 리뷰 2회차 STD-3).
    `const later = awaitedLater(p);\nconst wait = async () => {\n  await later;\n};\nif (Math.random() > 0.5) await wait();\nelse await wait();\n`,
    // 경계(CODING_STANDARDS.md#단언): 이름 없는 콜백은 넘겨받은 함수가 부른다고 본다. 그 함수가 부르지 않아도 lint는 세고, 리뷰가 본다.
    `const later = awaitedLater(p);\nconst ignore = () => undefined;\nignore(async () => {\n  await later;\n});\n`,
    `import { within } from "./support.ts";\nconst later = awaitedLater(p);\nawait within(later, 1000);\n`,
    `import * as support from "./support.ts";\nconst later = awaitedLater(p);\nawait support.within(later, 1000);\n`,
    `const later = awaitedLater(p);\nawait expect(later).resolves.toBe(1);\n`,
    `const later = awaitedLater(p);\nawait later.finally(() => undefined);\n`,
    // 모든 분기에서 기다리거나 분기 밖에서 기다리면 된다. try 블록 안의 기다림은 분기가 아니다.
    `const later = awaitedLater(p);\nif (Math.random() > 0.5) await later;\nelse await Promise.all([later]);\n`,
    `const later = awaitedLater(p);\nif (Math.random() > 0.5) use(1);\nawait later;\n`,
    `const later = awaitedLater(p);\ntry {\n  await later;\n} finally {\n  use(1);\n}\n`,
    `const later = awaitedLater(p);\nswitch (Math.floor(Math.random() * 3)) {\n  case 0:\n  case 1:\n    await later;\n    break;\n  default:\n    await later;\n}\n`,
    `const later = awaitedLater(p);\nif (Math.random() > 0.5) {\n  if (Math.random() > 0.5) await later;\n  else await later;\n} else await later;\n`,
    `import { within } from "@babojubot/runtime/testing";\nconst later = awaitedLater(p);\nawait within(later, 1000);\n`,
    // 가져온 이름을 지역 매개변수가 가리면 그 함수가 아니다(#266 리뷰 SPEC-4).
    `export function mark(awaitedLater, value) {\n  awaitedLater(value);\n}\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(laterImport + laterHead + code, place, laterRules),
        [],
        `${place}: ${code}`
      );
  // 같은 이름의 지역 함수와 다른 모듈의 함수는 보지 않는다.
  for (const code of [
    `const awaitedLater = (x) => x;\nconst p = Promise.resolve(1);\nawaitedLater(p);\n`,
    `import { awaitedLater } from "./elsewhere.mjs";\nconst p = Promise.resolve(1);\nawaitedLater(p);\n`,
  ])
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, laterRules),
        [],
        `${place}: ${code}`
      );
});

// 시한으로 끝날 수 있는 조합(다른 값이 거절만 하는 race·any, 가져온 저장소 도움)의 기다림은 함수로 뽑아도 직접 쓴 것과 같은
// 판정이다(#291 외부 리뷰 3회차 SPEC-1): 함수 안의 기다림은 그 함수의 결과가 거절되는 것이라, 부르는 자리에서 그 결과를 받는 모양
// (expect(…).rejects·.catch·then의 거절 처리기·allSettled·try/catch)까지 본다. 여러 단계로 감싼 함수, 그 자리에서 부르는 이름 없는
// 함수, then의 처리기도 같다. 각 줄은 [직접 쓴 모양, 함수로 뽑은 모양들…, 기대: 짚는 문구 또는 null(통과)].
test("a deadline wait gets the same verdict written directly or moved into a local function", async () => {
  const race = `Promise.race([later, ${rejectsLate}])`;
  const pairs = [
    [
      `const later = awaitedLater(p);\nawait expect(${race}).rejects.toThrow("late");\n`,
      `const later = awaitedLater(p);\nasync function wait() {\n  await ${race};\n}\nawait expect(wait()).rejects.toThrow("late");\n`,
      `const later = awaitedLater(p);\nconst wait = () => ${race};\nawait expect(wait()).rejects.toThrow("late");\n`,
      `const later = awaitedLater(p);\nasync function inner() {\n  await ${race};\n}\nasync function outer() {\n  return await inner();\n}\nawait expect(outer()).rejects.toThrow("late");\n`,
      `const later = awaitedLater(p);\nawait expect(\n  (async () => {\n    await ${race};\n  })()\n).rejects.toThrow("late");\n`,
      "notAwaited",
    ],
    [
      `const later = awaitedLater(p);\nawait ${race}.catch(() => undefined);\n`,
      `const later = awaitedLater(p);\nconst wait = async () => {\n  await ${race};\n};\nawait wait().catch(() => undefined);\n`,
      `const later = awaitedLater(p);\nawait p\n  .then(async () => {\n    await ${race};\n  })\n  .catch(() => undefined);\n`,
      "notAwaited",
    ],
    [
      `const later = awaitedLater(p);\nawait ${race}.then(use, () => undefined);\n`,
      `const later = awaitedLater(p);\nconst wait = async () => {\n  await ${race};\n};\nawait wait().then(use, () => undefined);\n`,
      "notAwaited",
    ],
    [
      `const later = awaitedLater(p);\nawait Promise.allSettled([${race}]);\n`,
      `const later = awaitedLater(p);\nconst wait = async () => {\n  await ${race};\n};\nawait Promise.allSettled([wait()]);\n`,
      "notAwaited",
    ],
    [
      `import { within } from "./support.ts";\nconst later = awaitedLater(p);\nawait expect(within(later, 1000)).rejects.toThrow();\n`,
      `import { within } from "./support.ts";\nconst later = awaitedLater(p);\nconst wait = () => within(later, 1000);\nawait expect(wait()).rejects.toThrow();\n`,
      "notAwaited",
    ],
    [
      `const later = awaitedLater(p);\ntry {\n  await ${race};\n} catch {\n  use(1);\n}\n`,
      `const later = awaitedLater(p);\nconst wait = async () => {\n  await ${race};\n};\ntry {\n  await wait();\n} catch {\n  use(1);\n}\n`,
      "awaitedInBranch",
    ],
    // 결과의 거절이 전파되는 자리면 직접 쓴 것처럼 통과한다.
    [
      `const later = awaitedLater(p);\nawait ${race};\n`,
      `const later = awaitedLater(p);\nasync function wait() {\n  await ${race};\n}\nawait wait();\n`,
      `const later = awaitedLater(p);\nasync function inner() {\n  await ${race};\n}\nasync function outer() {\n  return await inner();\n}\nawait outer();\n`,
      `const later = awaitedLater(p);\nawait (async () => {\n  await ${race};\n})();\n`,
      `const later = awaitedLater(p);\nawait p.then(async () => {\n  await ${race};\n});\n`,
      null,
    ],
    [
      `const later = awaitedLater(p);\nawait expect(${race}).resolves.toBe(1);\n`,
      `const later = awaitedLater(p);\nconst wait = () => ${race};\nawait expect(wait()).resolves.toBe(1);\n`,
      null,
    ],
    [
      `const later = awaitedLater(p);\ntry {\n  await ${race};\n} catch {\n  await later.catch(() => undefined);\n}\n`,
      `const later = awaitedLater(p);\nconst wait = async () => {\n  await ${race};\n};\ntry {\n  await wait();\n} catch {\n  await later.catch(() => undefined);\n}\n`,
      null,
    ],
  ];
  for (const pair of pairs) {
    const kind = /** @type {string | null} */ (pair.at(-1));
    for (const code of /** @type {string[]} */ (pair.slice(0, -1)))
      for (const place of testPlaces) {
        const messages = await lint(
          laterImport + laterHead + code,
          place,
          laterRules
        );
        if (kind === null) {
          assert.deepEqual(messages, [], `${place}: ${code}`);
          continue;
        }
        const [message, ...rest] = messages;
        assert.ok(message, `${place}: not reported: ${code}`);
        assert.deepEqual(rest, [], `${place}: ${code}`);
        assert.deepEqual(
          [message.ruleId, message.messageId],
          ["tests/no-unawaited-later", kind],
          code
        );
      }
  }
});

// 시험 규칙은 JS 기본 전역(Promise·Math·console·process 등)과 시험 도구(expect·assert·test)도 글자 이름이 아니라 출처로 본다(#266
// 리뷰 SPEC-4): 별칭·다른 이름으로 가져와도 같고, 같은 이름의 지역 값으로 가리면 그것이 아니다.
test("test rules tell globals and test tools by origin, not by name", async () => {
  const reported = [
    // 다른 이름으로 가져온 expect로 경과 시간을 단언한다.
    [
      "tests/no-elapsed-time-assertion",
      `import { expect as check } from "vitest";\ncheck(Date.now() - started).toBeLessThan(5000);\n`,
    ],
    // 별칭으로 받은 Promise로 잠든다.
    [
      "tests/no-fixed-time-wait",
      `const P = Promise;\nawait new P((resolve) => setTimeout(resolve, 50));\n`,
    ],
    // 별칭으로 받은 process의 kill 실패를 넘긴다.
    [
      "tests/no-ignored-kill-error",
      `const proc = process;\ntry {\n  proc.kill(pid, "SIGTERM");\n} catch {\n  /* gone */\n}\n`,
    ],
  ];
  for (const [rule, code] of reported)
    for (const place of testPlaces) {
      const messages = await lint(code, place, [rule]);
      assert.ok(messages.length > 0, `${place}: ${rule} not reported: ${code}`);
    }
  const kept = [
    // 같은 이름의 지역 값은 그 전역·도구가 아니다.
    [
      "tests/no-elapsed-time-assertion",
      `const expect = (value) => ({ toBeLessThan: () => value });\nexpect(Date.now() - started).toBeLessThan(5000);\n`,
    ],
    [
      "tests/no-fixed-time-wait",
      `const Promise = FakePromise;\nawait new Promise((resolve) => setTimeout(resolve, 50));\n`,
    ],
    [
      "tests/no-ignored-kill-error",
      `const process = fakeProcess;\ntry {\n  process.kill(pid, "SIGTERM");\n} catch {\n  /* gone */\n}\n`,
    ],
  ];
  for (const [rule, code] of kept)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, [rule]),
        [],
        `${place}: ${code}`
      );
});

// 옛 이름 판정이 잡던 도구는 그 이름을 내보내는 모든 모듈에서 잡는다(#266 리뷰 SPEC-5). 같은 값을 다른 이름으로도 내놓는 곳
// (vitest의 assert = chai.assert, Playwright의 test.expect = expect, node:test의 기본 내보내기 = test, node:timers의 promises =
// timers/promises, node:console = 전역 console)은 공용 판정이 한 출처로 맞춘다.
test("test rules see a tool under every name its module exports it", async () => {
  const kill = (log) =>
    `try {\n  process.kill(pid, "SIGKILL");\n} catch (error) {\n  ${log}(error);\n}\n`;
  const shared = (runner) =>
    `let before;\n${runner}("changes", async () => {\n  before = await read();\n});\n${runner}("restores", async () => {\n  assert.equal(await read(), before);\n});\n`;
  const reported = [
    // 리뷰의 재현: vitest의 assert로 경과 시간을 단언한다.
    [
      "tests/no-elapsed-time-assertion",
      `import { assert } from "vitest";\nconst started = Date.now();\nassert(Date.now() - started < 500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `import { assert } from "vitest";\nconst check = assert;\ncheck.isBelow(Date.now() - started, 500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `import { chai } from "vitest";\nchai.assert.isBelow(Date.now() - started, 500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `import { chai } from "vitest";\nchai.expect(Date.now() - started).to.be.below(500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `import { expect } from "vitest";\nexpect.assert(Date.now() - started < 500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `import { ok as check } from "node:assert/strict";\ncheck(Date.now() - started < 500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `import { test } from "@playwright/test";\nconst { expect: check } = test;\ncheck(Date.now() - started).toBeLessThan(500);\n`,
    ],
    // Playwright의 expect.extend·expect.configure는 새 expect를 돌려준다(test.extend처럼 따라간다).
    [
      "tests/no-elapsed-time-assertion",
      `import { expect as base } from "@playwright/test";\nconst expect = base.configure({ timeout: 1000 });\nexpect(Date.now() - started).toBeLessThan(500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `import { expect as base } from "@playwright/test";\nconst check = base.extend({});\ncheck(Date.now() - started).toBeLessThan(500);\n`,
    ],
    [
      "tests/no-fixed-time-wait",
      `import { promises } from "node:timers";\nawait promises.setTimeout(100);\n`,
    ],
    [
      "tests/no-fixed-time-wait",
      `import timers from "node:timers";\nconst { setTimeout: sleep } = timers.promises;\nawait sleep(100);\n`,
    ],
    [
      "tests/no-state-between-tests",
      `import check from "node:test";\n${shared("check")}`,
    ],
    [
      "tests/no-state-between-tests",
      `import nodeTest from "node:test";\nconst { it: check } = nodeTest;\n${shared("check")}`,
    ],
    [
      "tests/no-ignored-kill-error",
      `import { warn } from "node:console";\n${kill("warn")}`,
    ],
    [
      "tests/no-ignored-kill-error",
      `import logger from "node:console";\n${kill("logger.warn")}`,
    ],
  ];
  for (const [rule, code] of reported)
    for (const place of testPlaces) {
      const messages = await lint(code, place, [rule]);
      assert.ok(messages.length > 0, `${place}: ${rule} not reported: ${code}`);
    }
  const kept = [
    // 같은 이름의 지역 값은 그 도구가 아니다.
    [
      "tests/no-elapsed-time-assertion",
      `export function check(assert) {\n  assert(Date.now() - started < 500);\n}\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `const chai = { assert: { isBelow: record }, expect: record };\nchai.assert.isBelow(Date.now() - started, 500);\nchai.expect(Date.now() - started);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `const ok = record;\nok(Date.now() - started < 500);\n`,
    ],
    [
      "tests/no-elapsed-time-assertion",
      `const expect = tools.configure({ timeout: 1000 });\nexpect(Date.now() - started).toBeLessThan(500);\n`,
    ],
    [
      "tests/no-fixed-time-wait",
      `export async function wait(promises) {\n  await promises.setTimeout(100);\n}\n`,
    ],
    [
      "tests/no-state-between-tests",
      `const check = (name, fn) => fn();\n${shared("check")}`,
    ],
    ["tests/no-ignored-kill-error", `const warn = record;\n${kill("warn")}`],
  ];
  for (const [rule, code] of kept)
    for (const place of testPlaces)
      assert.deepEqual(
        await lint(code, place, [rule]),
        [],
        `${place}: ${code}`
      );
});

// 출처로 판정하는 시험 규칙은 모두 같은 두 가지를 지킨다(#266 리뷰 SPEC-7·8·9): 같은 값에 닿는 접근 모양(정식 이름·이름 바꾼 가져오기·
// const 별칭·이름공간 속성·구조 분해·require, 전역이면 별칭·구조 분해·전역 객체 속성)이 달라도 같은 판정을 내고, 같은 이름의 지역 값에는
// 반대 판정을 낸다. 사례는 정식 이름으로 하나만 적고 모양은 scripts/lint-access-shapes.mjs가 만든다. `kept`면 정식 사례가 통과하는 사례다.
const shareState = (runner) =>
  `let shared;\n${runner}("first", () => {\n  shared = 1;\n});\n${runner}("second", () => {\n  expect(shared).toBe(1);\n});\n`;
const hookCleanups = (hook) =>
  `${hook}(async () => {\n  await t?.close();\n  await model?.close();\n});\n`;
const laterHeadImport = `import { awaitedLater } from "@babojubot/process/test-cleanup";\n`;
/**
 * @type {Array<{ rule: string, kept?: boolean, value: { module?: string, global?: string, path: string[] },
 *   use: (ref: string) => string, head?: string, local?: boolean, localSkipped?: string }>}
 */
const originCases = [
  // 대역의 hoisted 칸: 칸을 만드는 `vi.hoisted`와 대역을 거는 `vi.mock`을 각각 모든 접근 모양으로.
  {
    rule: "tests/hoisted-state-at-call",
    value: { module: "vitest", path: ["vi", "hoisted"] },
    head: `import { vi as mocking } from "vitest";\n`,
    use: (r) =>
      `const state = ${r}(() => ({ seen: [] }));\nmocking.mock("node:fs/promises", async () => ({ open: async (file) => {\n  await work();\n  state.seen.push(file);\n} }));\n`,
  },
  {
    rule: "tests/hoisted-state-at-call",
    value: { module: "vitest", path: ["vi", "mock"] },
    head: `import { vi as hoisting } from "vitest";\n`,
    use: (r) =>
      `const state = hoisting.hoisted(() => ({ seen: [] }));\n${r}("node:fs/promises", async () => ({ open: async (file) => {\n  await work();\n  state.seen.push(file);\n} }));\n`,
  },
  // 경과 시간 단언: 단언 도구·시계·계산.
  ...[
    { module: "vitest", path: ["expect"] },
    { module: "@playwright/test", path: ["expect"] },
    { module: "@playwright/test", path: ["test", "expect"] },
    { global: "expect", path: [] },
  ].map((value) => ({
    rule: "tests/no-elapsed-time-assertion",
    value,
    use: (r) => `${r}(Date.now() - started).toBeLessThan(5000);\n`,
  })),
  ...[
    { module: "vitest", path: ["assert"] },
    { module: "vitest", path: ["chai", "assert"] },
    { module: "node:assert/strict", path: ["ok"] },
    { module: "node:assert", path: ["strict", "ok"] },
  ].map((value) => ({
    rule: "tests/no-elapsed-time-assertion",
    value,
    use: (r) => `${r}(Date.now() - started < 5000);\n`,
  })),
  ...[
    { global: "Date", path: ["now"] },
    { global: "performance", path: ["now"] },
    { module: "node:perf_hooks", path: ["performance", "now"] },
  ].map((value) => ({
    rule: "tests/no-elapsed-time-assertion",
    value,
    use: (r) =>
      `const started = ${r}();\nexpect(${r}() - started).toBeLessThan(5000);\n`,
  })),
  {
    rule: "tests/no-elapsed-time-assertion",
    value: { global: "Math", path: ["round"] },
    use: (r) => `expect(${r}(Date.now() - started)).toBeLessThan(5);\n`,
  },
  // 정해진 시간 대기·중단·차례 세기.
  ...[
    { global: "setTimeout", path: [] },
    { module: "node:timers", path: ["setTimeout"] },
  ].map((value) => ({
    rule: "tests/no-fixed-time-wait",
    value,
    use: (r) => `await new Promise((resolve) => ${r}(resolve, 50));\n`,
  })),
  ...[
    { module: "node:timers/promises", path: ["setTimeout"] },
    { module: "node:timers/promises", path: ["scheduler", "wait"] },
    { module: "node:timers", path: ["promises", "setTimeout"] },
  ].map((value) => ({
    rule: "tests/no-fixed-time-wait",
    value,
    use: (r) => `await ${r}(100);\n`,
  })),
  {
    rule: "tests/no-fixed-time-wait",
    value: { global: "Promise", path: [] },
    use: (r) => `await new ${r}((resolve) => setTimeout(resolve, 50));\n`,
  },
  {
    rule: "tests/no-fixed-time-wait",
    value: { global: "AbortSignal", path: ["timeout"] },
    use: (r) =>
      `await expect(server.start(${r}(200))).rejects.toMatchObject({ name: "TimeoutError" });\n`,
  },
  {
    rule: "tests/no-fixed-time-wait",
    value: { module: "vitest", path: ["expect"] },
    use: (r) =>
      `await ${r}(server.start(AbortSignal.timeout(200))).rejects.toMatchObject({ name: "TimeoutError" });\n`,
  },
  {
    rule: "tests/no-fixed-time-wait",
    value: { module: "node:assert/strict", path: ["rejects"] },
    use: (r) =>
      `await ${r}(server.start(AbortSignal.timeout(200)), { name: "AbortError" });\n`,
  },
  ...[
    { global: "setImmediate", path: [] },
    { global: "process", path: ["nextTick"] },
    { module: "node:process", path: ["nextTick"] },
  ].map((value) => ({
    rule: "tests/no-fixed-time-wait",
    value,
    use: (r) =>
      `for (let i = 0; i < 5; i++) await new Promise((wake) => ${r}(wake));\n`,
  })),
  ...[
    { module: "node:timers/promises", path: ["setImmediate"] },
    { module: "node:timers/promises", path: ["scheduler", "yield"] },
    { global: "Promise", path: ["resolve"] },
  ].map((value) => ({
    rule: "tests/no-fixed-time-wait",
    value,
    use: (r) => `for (let i = 0; i < 5; i++) await ${r}();\n`,
  })),
  // 나중에 기다릴 표시와 그것을 받는 자리(Promise 조합·expect·저장소 도움).
  {
    rule: "tests/no-unawaited-later",
    value: {
      module: "@babojubot/process/test-cleanup",
      path: ["awaitedLater"],
    },
    use: (r) => `const p = Promise.resolve(1);\n${r}(p);\n`,
  },
  ...[
    {
      value: { global: "Promise", path: ["all"] },
      use: (r) => `await ${r}([exited]);\n`,
    },
    {
      value: { module: "vitest", path: ["expect"] },
      use: (r) => `await ${r}(exited).resolves.toBe(1);\n`,
    },
    {
      value: { module: "@babojubot/contracts", path: ["settled"] },
      use: (r) => `await ${r}(exited);\n`,
    },
  ].map(({ value, use }) => ({
    rule: "tests/no-unawaited-later",
    value,
    head: `${laterHeadImport}const exited = awaitedLater(work());\n`,
    use,
    kept: true,
  })),
  // process.env 바꾸기.
  ...[
    { global: "process", path: ["env"] },
    { module: "node:process", path: ["env"] },
  ].map((value) => ({
    rule: "tests/no-process-env-change",
    value,
    use: (r) => `${r}.SETTING = "1";\n`,
  })),
  ...[
    { global: "Object", path: ["assign"] },
    { global: "Reflect", path: ["set"] },
  ].map((value) => ({
    rule: "tests/no-process-env-change",
    value,
    use: (r) => `${r}(process.env, "SETTING", "1");\n`,
  })),
  // process.kill의 실패 넘기기·finally의 동기 정리·로그만 남기기.
  ...[
    { global: "process", path: ["kill"] },
    { module: "node:process", path: ["kill"] },
  ].flatMap((value) => [
    {
      rule: "tests/no-ignored-kill-error",
      value,
      use: (r) =>
        `try {\n  ${r}(pid, "SIGTERM");\n} catch {\n  /* gone */\n}\n`,
    },
    {
      rule: "tests/no-cleanup-in-finally",
      value,
      use: (r) =>
        `try {\n  check();\n} finally {\n  ${r}(pid, "SIGKILL");\n}\n`,
    },
  ]),
  ...[
    { global: "console", path: ["warn"] },
    { module: "node:console", path: ["warn"] },
  ].map((value) => ({
    rule: "tests/no-ignored-kill-error",
    value,
    use: (r) =>
      `try {\n  process.kill(pid, "SIGKILL");\n} catch (error) {\n  ${r}(error);\n}\n`,
  })),
  // 공용 정리 hook·fixture의 정리 연쇄.
  ...[
    { module: "vitest", path: ["afterAll"] },
    { module: "vitest", path: ["afterEach"] },
    { module: "node:test", path: ["after"] },
    { module: "node:test", path: ["test", "after"] },
    { global: "afterAll", path: [] },
    { module: "@playwright/test", path: ["test", "afterAll"] },
  ].map((value) => ({
    rule: "tests/no-skipped-cleanup",
    value,
    use: hookCleanups,
  })),
  {
    rule: "tests/no-skipped-cleanup",
    value: { global: "Promise", path: [] },
    use: (r) =>
      `afterEach(async () => {\n  await new ${r}((resolve) => server.close(resolve));\n  await model.close();\n});\n`,
  },
  {
    rule: "tests/no-skipped-cleanup",
    value: { module: "@playwright/test", path: ["test", "extend"] },
    use: (r) =>
      `export const fixtures = ${r}({\n  servers: async ({ page }, provide) => {\n    await provide(page);\n    await server.close();\n    await model.close();\n  },\n});\n`,
  },
  // 공용 폴더 지우기: 닫은 뒤 지우기만 이어지면 통과하고, 첫 정리로 지우면 뒤 정리를 건너뛸 수 있다.
  {
    rule: "tests/no-skipped-cleanup",
    value: {
      module: "@babojubot/process/remove-folder",
      path: ["removeFolder"],
    },
    use: (r) =>
      `afterEach(async () => {\n  await server.close();\n  await ${r}(root);\n});\n`,
    kept: true,
  },
  {
    rule: "tests/no-skipped-cleanup",
    value: {
      module: "@babojubot/process/remove-folder",
      path: ["removeFolder"],
    },
    use: (r) =>
      `afterAll(async () => {\n  await ${r}(root);\n  await model.close();\n});\n`,
    local: false,
    localSkipped:
      "정리 동사 이름(remove…)으로 알아보는 휴리스틱이 같은 이름의 지역 함수도 정리로 본다(출처 판정은 그 위에 덧붙인다).",
  },
  // 서버 닫기의 실패 버리기.
  ...[
    { module: "node:http", path: ["createServer"] },
    { module: "node:tls", path: ["createServer"] },
    { module: "node:http2", path: ["createSecureServer"] },
  ].map((value) => ({
    rule: "tests/no-ignored-close-error",
    value,
    use: (r) =>
      `const server = ${r}();\nawait new Promise((resolve) => server.close(resolve));\n`,
  })),
  {
    rule: "tests/no-ignored-close-error",
    value: { module: "node:net", path: ["Server"] },
    use: (r) =>
      `const server = new ${r}();\nawait new Promise((resolve) => server.close(resolve));\n`,
  },
  // 기대한 실패 표시.
  ...[
    { global: "it", path: ["fails"] },
    { module: "vitest", path: ["it", "fails"] },
    { module: "vitest", path: ["test", "fails"] },
    { module: "@playwright/test", path: ["test", "fail"] },
  ].map((value) => ({
    rule: "tests/no-expected-failure",
    value,
    use: (r) => `${r}("saves", async () => {\n  await save();\n});\n`,
  })),
  // 시험 사이 상태·직렬 모드, 시험마다 도는 hook의 비우기.
  ...[
    { global: "test", path: [] },
    { module: "vitest", path: ["test"] },
    { module: "vitest", path: ["it"] },
    { module: "node:test", path: ["test"] },
    { module: "node:test", path: ["it"] },
    { module: "@playwright/test", path: ["test"] },
  ].map((value) => ({
    rule: "tests/no-state-between-tests",
    value,
    use: shareState,
  })),
  {
    rule: "tests/no-state-between-tests",
    value: {
      module: "@playwright/test",
      path: ["test", "describe", "configure"],
    },
    use: (r) => `${r}({ mode: "serial" });\n`,
  },
  {
    rule: "tests/no-state-between-tests",
    value: { module: "@playwright/test", path: ["test", "describe", "serial"] },
    use: (r) => `${r}("steps", () => {});\n`,
  },
  ...[
    { module: "vitest", path: ["afterEach"] },
    { module: "@playwright/test", path: ["test", "afterEach"] },
  ].map((value) => ({
    rule: "tests/no-state-between-tests",
    value,
    use: (r) => `${r}(() => {\n  shared = undefined;\n});\n${shareState("it")}`,
    kept: true,
  })),
];

/** E2E 규칙(타입 정보): 한 번 읽은 화면 상태의 단언. expect와 변환 함수도 출처로 본다. */
const oneShotCases = [
  {
    value: { module: "@playwright/test", path: ["expect"] },
    use: (r) => `${r}(await status.isChecked()).toBe(true);\n`,
  },
  ...["Number", "String", "Boolean"].map((name) => ({
    value: { global: name, path: [] },
    use: (r) => `expect(${r}(await status.isChecked())).toBe(true);\n`,
  })),
];

test("every test rule that judges by origin sees its tool through every access shape and passes a same-named local", async () => {
  // 어긋난 사례를 모두 모아 한 번에 보인다(한 규칙의 여러 모양이 함께 깨지는 일이 많다).
  const wrong = [];
  const check = async (rule, place, { shape, code, same }, kept) => {
    const found = (await lint(code, place, [rule])).length > 0;
    if (found !== (kept ? !same : same))
      wrong.push(`${rule} ${shape} (${found ? "reported" : "kept"}): ${code}`);
  };
  for (const { rule, kept, ...spec } of originCases)
    for (const generated of accessShapes(spec))
      await check(
        rule,
        "apps/server/test/lint-sample.test.ts",
        generated,
        kept
      );
  for (const spec of oneShotCases)
    for (const generated of accessShapes({ ...spec, head: e2eOnly }))
      await check(
        "tests/no-one-shot-ui-read",
        "apps/web/e2e/support/organization.ts",
        generated,
        false
      );
  assert.deepEqual(wrong, []);
});

/** awaitedLater는 경로 철자가 아니라 대상 파일(@babojubot/process의 test-cleanup.ts)로 본다(#266 리뷰 SPEC-5). */
test("awaitedLater is told by the file it comes from, not by how the path is spelled", async () => {
  const marked = (source) =>
    `import { awaitedLater } from "${source}";\nawaitedLater(work());\n`;
  const reported = [
    [
      "apps/server/test/lint-sample.test.ts",
      marked("../../../packages/process/src/test-cleanup.ts"),
    ],
    ["packages/process/src/test-cleanup.test.ts", marked("./test-cleanup")],
    [
      "apps/server/test/lint-sample.test.ts",
      `export { awaitedLater as later } from "../../../packages/process/src/test-cleanup.ts";\n`,
    ],
    [
      "packages/process/src/test-cleanup.test.ts",
      `export * from "./test-cleanup.ts";\n`,
    ],
  ];
  for (const [place, code] of reported)
    assert.ok(
      (await lint(code, place, laterRules)).length > 0,
      `${place}: ${code} not reported`
    );
  // 다른 폴더의 같은 이름 파일은 그 도움이 아니다.
  for (const place of testPlaces)
    for (const code of [
      marked("./test-cleanup.ts"),
      `export { awaitedLater } from "./test-cleanup.ts";\n`,
      `export * from "./test-cleanup.ts";\n`,
    ])
      assert.deepEqual(
        await lint(code, place, laterRules),
        [],
        `${place}: ${code}`
      );
});

// ---------- 호출 문맥 (#286 PR 3b-3b-2 외부 리뷰 1회차) ----------

/** 호출 문맥 규칙의 메시지만. */
const callContextMessages = async (code, place) =>
  await lint(code, place, ["tests/call-context-through-arming"]);

const callContextShapes = {
  "a named import": `import { AsyncLocalStorage } from "node:async_hooks";\nexport const calls = new AsyncLocalStorage();\n`,
  "a default import without the node: prefix": `import hooks from "async_hooks";\nexport const calls = new hooks.AsyncLocalStorage();\n`,
  "a dynamic import": `const hooks = await import("node:async_hooks");\nexport const calls = new hooks.AsyncLocalStorage();\n`,
  "a require": `const hooks = require("node:async_hooks");\nexport const calls = new hooks.AsyncLocalStorage();\n`,
  "a re-export": `export { AsyncLocalStorage } from "node:async_hooks";\n`,
  "a star re-export": `export * from "async_hooks";\n`,
  "vitest's importActual": `import { vi } from "vitest";\nconst hooks = await vi.importActual("node:async_hooks");\nexport const calls = new hooks.AsyncLocalStorage();\n`,
  "a mock factory's original": `import { vi } from "vitest";\nvi.mock("node:async_hooks", async (original) => ({ ...(await original()) }));\n`,
};

for (const [shape, code] of Object.entries(callContextShapes))
  test(`test code takes a call's context only through callArming, not with ${shape}`, async () => {
    for (const place of testPlaces) {
      const messages = await callContextMessages(code, place);
      assert.equal(messages.length, 1, `${place}: ${code}`);
      assert.match(messages[0].message, /@babojubot\/process\/call-arming/);
    }
  });

test("the shared call-arming helper is the one place that holds a call's context", async () => {
  const helper = "packages/process/src/call-arming-support.ts";
  const code = await readFile(path.join(repository, helper), "utf8");
  assert.match(code, /AsyncLocalStorage/);
  assert.deepEqual(await callContextMessages(code, helper), []);
});
