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

test("test code may not abort after a fixed time or count event loop turns as the end of the work", async () => {
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
  };
  for (const [shape, [code, kind]] of Object.entries(ordered))
    for (const place of testPlaces) {
      const messages = waitMessages(await lint(code, place));
      assert.ok(messages.length, `${place}: ${shape} not reported`);
      for (const message of messages) {
        assert.match(message.message, kind, `${place}: ${shape}`);
        // 메시지가 대안과 기준 문서의 절을 알려 준다.
        assert.match(message.message, /신호/);
        assert.match(message.message, /CODING_STANDARDS\.md#순서/);
      }
    }
  // 한 반복은 한 번만 알린다.
  assert.equal(
    waitMessages(await lint(ordered["counted microtasks"][0], testPlaces[0]))
      .length,
    3
  );
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
      assert.deepEqual(waitMessages(await lint(code, place)), [], code);
});

/** 화면 전체 검색 규칙의 메시지만. */
const locatorMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-page-wide-locator");

// E2E는 타입 정보로 페이지를 가리므로 있는 E2E 파일 자리를 빌린다.
const e2ePlaces = [
  "apps/web/e2e/home.spec.ts",
  "apps/web/e2e/support/organization.ts",
];
// 시험이 받는 page와 다른 탭(`context.newPage()`), 영역 locator.
const e2eHead = `import type { BrowserContext, Locator, Page } from "@playwright/test";\ndeclare const page: Page;\ndeclare const context: BrowserContext;\ndeclare const area: Locator;\nconst other = await context.newPage();\nexport {};\n`;

test("an E2E may not search the whole page by text or pick by position among page-wide or same-name matches", async () => {
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
      const [message, ...rest] = locatorMessages(
        await lint(e2eHead + code, place)
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
      const messages = await lint(e2eHead + code, place);
      // 코드가 읽히지 않아 통과하는 것이 아니다.
      assert.deepEqual(
        messages.filter((m) => m.fatal),
        [],
        code
      );
      assert.deepEqual(locatorMessages(messages), [], code);
    }
});

test("code outside the E2E may search a whole page", async () => {
  for (const place of [
    "apps/server/test/lint-sample.test.ts",
    "scripts/lint-sample.test.mjs",
    "scripts/live/lint-sample.mjs",
  ])
    assert.deepEqual(
      locatorMessages(
        await lint(`await page.getByText("대기").first().click();\n`, place)
      ),
      [],
      place
    );
});

/** finally 정리 규칙의 메시지만. */
const finallyMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-cleanup-in-finally");

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
  for (const [kind, shapes, pattern] of [
    ["await", awaited, /onTestFinished/],
    ["sync", thrown, /이미 사라진 대상/],
  ])
    for (const [shape, code] of Object.entries(shapes))
      for (const place of testPlaces) {
        const [message, ...rest] = finallyMessages(await lint(code, place));
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
    `import { withCleanup } from "@babojubot/runtime/test-cleanup";\nawait withCleanup(async (defer) => {\n  const child = spawn();\n  defer(() => killHard(child));\n  await check(child);\n});\n`,
    // finally 밖의 끄기·지우기와 Promise의 finally 메서드.
    `process.kill(pid, "SIGKILL");\nfs.rmSync("file", { force: true });\nawait work().finally(() => clearTimeout(timer));\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(finallyMessages(await lint(code, place)), [], code);
});

test("code outside tests may wait in finally", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ])
    assert.deepEqual(
      finallyMessages(
        await lint(
          `try {\n  check();\n} finally {\n  await server.close();\n  process.kill(pid, "SIGKILL");\n}\n`,
          place
        )
      ),
      [],
      place
    );
});

/** 정리 hook 규칙의 메시지만. */
const skippedCleanupMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-skipped-cleanup");

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
      const [message, ...rest] = skippedCleanupMessages(
        await lint(code, place)
      );
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      // 메시지가 이유, 대안과 기준 문서의 절을 알려 준다.
      assert.match(message.message, /뒤 자원/);
      assert.match(message.message, /cleanUpAll/);
      assert.match(message.message, /folderCleanup/);
      assert.match(message.message, /CODING_STANDARDS\.md#정리/);
    }
});

test("a shared cleanup hook may try every cleanup, and a resource's own cleanup may chain its steps", async () => {
  const allowed = [
    `afterAll(() => cleanUpAll([() => folder?.cleanUp(), () => model?.close()]));\n`,
    // 그 폴더를 쓰는 서버를 끈 뒤에 지운다. 끄기가 실패하면 폴더를 남긴다.
    `afterEach(async () => {\n  await t?.close();\n  t = undefined;\n  if (root) await removeFolder(root);\n});\n`,
    // 앞 단계가 끝나야 하는 단계는 한 단계 안에 둔다.
    `afterAll(() =>\n  cleanUpAll([\n    async () => {\n      await environment.removeOrphans();\n      await removeFolder(root);\n    },\n    () => relays.close(),\n  ])\n);\n`,
    // 실패를 모은다.
    `afterEach(async () => {\n  for (const server of servers)\n    try {\n      await server.close();\n    } catch (error) {\n      failures.push(error);\n    }\n  report(failures);\n});\n`,
    // 정리가 아닌 기다림과 정리 하나.
    `afterEach(async () => {\n  await Promise.allSettled(preparations.splice(0));\n  await server?.close();\n});\n`,
    // 자원 하나를 잡은 직후 등록한 정리는 그 단계를 차례로 잇는다.
    `onTestFinished(async () => {\n  await chmod(locked, 0o700);\n  await removeFolder(root);\n});\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        skippedCleanupMessages(await lint(code, place)),
        [],
        `${place}: ${code}`
      );
});

/** 끄기 오류 규칙의 메시지만. */
const killErrorMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-ignored-kill-error");

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
  };
  for (const [shape, [code, kind]] of Object.entries(shapes))
    for (const place of testPlaces) {
      const [message, ...rest] = killErrorMessages(await lint(code, place));
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
    `import { killUnlessGone, processAlive } from "@babojubot/runtime/test-cleanup";\nif (processAlive(pid)) killUnlessGone(pid);\n`,
    `expect(() => process.kill(pid, 0)).not.toThrow();\n`,
    // 끄기가 아닌 조회의 실패는 이 규칙이 보지 않는다.
    `try {\n  parse(text);\n} catch {\n  return undefined;\n}\n`,
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        killErrorMessages(await lint(code, place)),
        [],
        `${place}: ${code}`
      );
});

test("code outside tests may chain cleanups and ignore kill errors", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "scripts/live/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ]) {
    const messages = await lint(
      `afterEach(async () => {\n  await a.close();\n  await b.close();\n});\ntry {\n  process.kill(pid, 0);\n} catch {\n  /* gone */\n}\n`,
      place
    );
    assert.deepEqual(skippedCleanupMessages(messages), [], place);
    assert.deepEqual(killErrorMessages(messages), [], place);
  }
});

/** 기대 실패 규칙의 메시지만. */
const expectedFailureMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-expected-failure");

test("test code may not mark a test as expected to fail", async () => {
  const shapes = {
    // 본문 맨 앞에 두면 그 뒤의 어느 실패든 기대한 실패가 된다.
    "Playwright test.fail in the body": `test("saves", async () => {\n  test.fail(true, "on purpose");\n  await save();\n});\n`,
    "Playwright test.fail declaring a test": `test.fail("saves", async () => {\n  await save();\n});\n`,
    "test.fail.only": `test.fail.only("saves", async () => {\n  await save();\n});\n`,
    "a test made by extend": `settingsTest.fail("saves", async () => {\n  await save();\n});\n`,
    "Vitest it.fails": `it.fails("saves", async () => {\n  await save();\n});\n`,
  };
  for (const [shape, code] of Object.entries(shapes))
    for (const place of testPlaces) {
      const [message, ...rest] = expectedFailureMessages(
        await lint(code, place)
      );
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
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        expectedFailureMessages(await lint(code, place)),
        [],
        code
      );
});

/** 시험 사이 상태 규칙의 메시지만. */
const stateMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-state-between-tests");

test("test code may not pass state from one test to another", async () => {
  const shared = {
    "a value one test sets and another reads": `let before;\ntest("changes", async () => {\n  before = await read();\n  await change();\n});\ntest("restores", async () => {\n  expect(await read()).toEqual(before);\n});\n`,
    "a value set inside a callback of a test": `let lateWrite;\ntest("sends", async ({ page }) => {\n  await page.route("**", (route) => {\n    lateWrite = send(route);\n  });\n});\ntest("waits", async () => {\n  await lateWrite;\n});\n`,
    "a describe-level value": `describe("outbox", () => {\n  let claim;\n  it("claims", async () => {\n    claim = await claimOne();\n  });\n  it("settles", async () => {\n    await settle(claim);\n  });\n});\n`,
    "a value that a beforeAll prepared and a test replaces": `let server;\nbeforeAll(async () => {\n  server = await start();\n});\nit("restarts", async () => {\n  server = await restart(server);\n});\nit("reads", async () => {\n  expect(await server.get()).toBe(1);\n});\n`,
    "test.each": `let last;\ntest.each([1, 2])("stores %s", async (n) => {\n  last = await store(n);\n});\ntest("reads", () => {\n  expect(last).toBe(2);\n});\n`,
  };
  const serial = {
    "serial mode": `test.describe.configure({ mode: "serial" });\ntest("a", () => {});\n`,
    "a serial group": `test.describe.serial("steps", () => {\n  test("a", () => {});\n});\n`,
  };
  for (const [kind, shapes, pattern] of [
    ["shared", shared, /다른 시험이 대입한 값/],
    ["serial", serial, /차례대로 묶습니다/],
  ])
    for (const [shape, code] of Object.entries(shapes))
      for (const place of testPlaces) {
        const [message, ...rest] = stateMessages(await lint(code, place));
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
      assert.deepEqual(stateMessages(await lint(code, place)), [], code);
});

test("code outside tests may share state between calls and mark failures", async () => {
  for (const place of [
    "scripts/lint-sample.mjs",
    "packages/runtime/test-fixtures/lint-sample.mjs",
  ]) {
    const messages = await lint(
      `let before;\ntest("a", () => {\n  before = 1;\n});\ntest("b", () => {\n  read(before);\n});\ntest.fail("c", () => {});\ntest.describe.configure({ mode: "serial" });\n`,
      place
    );
    assert.deepEqual(
      [...stateMessages(messages), ...expectedFailureMessages(messages)],
      [],
      place
    );
  }
});
