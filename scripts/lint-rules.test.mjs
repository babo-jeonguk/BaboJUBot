// 저장소 lint 설정(eslint.config.js)이 시험 코드 규칙과 예외 주석 규칙을 실제로 거는지 본다. 규칙의 조건에 오타가 나면
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

/** `filePath` 자리에 둔 `code`의 lint 결과. 파일은 만들지 않는다. */
async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages;
}

/** 시험 코드로 보는 자리들. 규칙은 이 모든 자리에 걸려야 한다. */
const testPlaces = [
  "apps/server/test/lint-sample.test.ts",
  "apps/server/test/lint-sample-support.ts",
  "apps/web/e2e/support/lint-sample.ts",
  // src 안은 타입 정보로 검사하므로(TypeScript 프로젝트에 든 파일만) 있는 시험 파일 자리를 빌린다.
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
const removalMessages = (messages) =>
  messages.filter((m) => m.ruleId === "no-restricted-syntax");

for (const [shape, code] of Object.entries(folderRemovals))
  test(`test code may not remove a folder by ${shape}`, async () => {
    for (const place of testPlaces) {
      const [message, ...rest] = removalMessages(await lint(code, place));
      assert.ok(message, `${place}: not reported`);
      assert.deepEqual(rest, [], place);
      // 메시지가 대안과 기준 문서의 절을 알려 준다.
      assert.match(
        message.message,
        /removeFolder\(@babojubot\/runtime\/remove-folder\)/
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
    const messages = removalMessages(
      await lint(code, "apps/server/test/lint-sample.test.ts")
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
    `import { removeFolder } from "@babojubot/runtime/remove-folder";\nawait removeFolder("dir");\nawait removeFolder("dir", { retries: 10, retryDelayMs: 200 });\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(removalMessages(await lint(code, place)), [], code);
});

test("code outside tests may remove a folder directly", async () => {
  // 제품 코드와 손으로 돌리는 스크립트, 외부 프로그램을 흉내 내는 가짜 CLI는 시험 코드 규칙을 받지 않는다.
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ])
    assert.deepEqual(
      removalMessages(await lint(folderRemovals["rm with recursive"], place)),
      [],
      place
    );
});

test("a lint exception needs a reason, names its rules and is removed once unused", async () => {
  const place = "scripts/lint-sample.mjs";
  const rules = async (code) =>
    (await lint(code, place)).map((m) => m.ruleId ?? m.message);

  assert.deepEqual(
    await rules(
      "// eslint-disable-next-line no-empty-pattern\nconst {} = {};\n"
    ),
    ["@eslint-community/eslint-comments/require-description"]
  );
  assert.deepEqual(
    await rules(
      "/* eslint-disable -- 이유 */\nconst {} = {};\n/* eslint-enable -- 이유 */\n"
    ),
    ["@eslint-community/eslint-comments/no-unlimited-disable"]
  );
  assert.deepEqual(
    await rules(
      "// eslint-disable-next-line no-empty-pattern -- 이유\nconst {} = {};\n"
    ),
    []
  );
  // 쓰이지 않는 예외는 경고가 아니라 오류다.
  const unused = await lint(
    "// eslint-disable-next-line no-empty-pattern -- 이유\nconst a = 1;\nexport { a };\n",
    place
  );
  assert.equal(unused.length, 1);
  assert.equal(unused[0].severity, 2);
  assert.match(unused[0].message, /Unused eslint-disable directive/);
});

/** 경과 시간 단언 규칙의 메시지만. */
const elapsedMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-elapsed-time-assertion");

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
  };
  for (const [shape, code] of Object.entries(asserted))
    for (const place of testPlaces) {
      const [message, ...rest] = elapsedMessages(await lint(code, place));
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
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(elapsedMessages(await lint(code, place)), [], code);
});

test("code outside tests may assert elapsed time", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
  ])
    assert.deepEqual(
      elapsedMessages(
        await lint(`assert.ok(Date.now() - started < 5000);\n`, place)
      ),
      [],
      place
    );
});

/** 고정 시간 기다림 규칙의 메시지만. */
const waitMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-fixed-time-wait");

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
    waitForTimeout: `await page.waitForTimeout(300);\n`,
  };
  for (const [shape, code] of Object.entries(waits))
    for (const place of testPlaces) {
      const [message, ...rest] = waitMessages(await lint(code, place));
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
    // 이벤트 루프 차례 넘기기는 시간을 기다리지 않는다.
    `await new Promise((resolve) => setTimeout(resolve, 0));\nawait new Promise((resolve) => setImmediate(resolve));\nawait new Promise((resolve) => setTimeout(resolve));\n`,
    // timers/promises가 아닌 곳의 같은 이름, Playwright의 다른 대기.
    `import { setTimeout as later } from "./elsewhere.mjs";\nawait later(50);\nawait page.waitForURL("/");\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(waitMessages(await lint(code, place)), [], code);
});

test("code outside tests may wait a fixed time", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ])
    assert.deepEqual(
      waitMessages(
        await lint(
          `await new Promise((resolve) => setTimeout(resolve, 50));\n`,
          place
        )
      ),
      [],
      place
    );
});
