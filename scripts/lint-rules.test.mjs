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
    // 이벤트 루프 차례 하나는 시간을 기다리지 않는다(잇달아 쓰면 횟수 세기로 짚는다).
    `await new Promise((resolve) => setTimeout(resolve, 0));\n`,
    `await new Promise((resolve) => setImmediate(resolve));\n`,
    `await new Promise((resolve) => setTimeout(resolve));\n`,
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
      const [message, ...rest] = skippedCleanupMessages(
        await lint(code, place)
      );
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
      const [message, ...rest] = skippedCleanupMessages(
        await lint(code, place)
      );
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assertCleanupAdvice(message);
    }
});

test("a shared cleanup hook may try every cleanup, and a resource's own cleanup may chain its steps", async () => {
  const allowed = [
    `afterAll(() => attemptAll([() => folder?.cleanUp(), () => model?.close()]));\n`,
    // 그 폴더를 쓰는 서버를 끈 뒤에 지운다. 끄기가 실패하면 폴더를 남긴다.
    `afterEach(async () => {\n  await t?.close();\n  t = undefined;\n  if (root) await removeFolder(root);\n});\n`,
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
    `afterEach(async () => {\n  try {\n    await server.stop();\n    await removeFolder(root);\n  } catch (error) {\n    failures.push(error);\n  }\n});\n`,
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
    // 안쪽 catch가 ESRCH 밖의 실패를 다시 던져도 바깥 catch가 삼킨다.
    "an outer catch swallowing what an inner catch rethrows": [
      `try {\n  try {\n    process.kill(pid, "SIGKILL");\n  } catch (error) {\n    if (error.code !== "ESRCH") throw error;\n  }\n} catch {\n  /* ignore */\n}\n`,
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
        killErrorMessages(await lint(code, place)),
        [],
        `${place}: ${code}`
      );
});

/** 서버 닫기 오류 규칙의 메시지만. */
const closeErrorMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-ignored-close-error");
/** 타입 표기를 쓰는 예를 돌릴 TypeScript 자리. */
const typedPlaces = testPlaces.filter((place) => place.endsWith(".ts"));

test("test code may not fulfil a Promise with the error of a Node server's close", async () => {
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
    "servers from a typed list": [
      `import http from "node:http";\nimport type { Server } from "node:net";\nconst servers: http.Server[] = [];\nconst wires: { server: Server }[] = [];\nfor (const wire of wires.splice(0)) await new Promise((resolve) => wire.server.close(resolve));\nawait attemptAll(servers.map((server) => () => new Promise((resolve) => server.close(resolve))));\n`,
      typedPlaces,
    ],
  };
  for (const [shape, [code, places]] of Object.entries(shapes))
    for (const place of places) {
      const messages = closeErrorMessages(await lint(code, place));
      assert.ok(messages.length > 0, `${place}: ${shape} not reported`);
      for (const message of messages) {
        // 메시지가 이유, 대안과 기준 문서의 절을 알려 준다.
        assert.match(message.message, /Promise가 이행/);
        assert.match(message.message, /reject\(error\)/);
        assert.match(message.message, /attemptAll/);
        assert.match(message.message, /CODING_STANDARDS\.md#정리/);
      }
    }
  assert.equal(
    closeErrorMessages(
      await lint(shapes["servers from a typed list"][0], typedPlaces[0])
    ).length,
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
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        closeErrorMessages(await lint(code, place)),
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
      place
    );
    assert.deepEqual(skippedCleanupMessages(messages), [], place);
    assert.deepEqual(killErrorMessages(messages), [], place);
    assert.deepEqual(closeErrorMessages(messages), [], place);
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

// ---------- 시험 데이터의 타입 단언 (#243) ----------

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
      const [message, ...rest] = fixtureMessages(await lint(code, place));
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
      assert.deepEqual(fixtureMessages(await lint(code, place)), [], code);
});

test("product code may assert types", async () => {
  // 제품 코드는 시험 데이터 규칙을 받지 않는다(타입 정보로 검사하므로 있는 파일 자리를 빌린다).
  assert.deepEqual(
    fixtureMessages(
      await lint(
        fixtureAssertions["a partial object through unknown"],
        "packages/runtime/src/providers/login.ts"
      )
    ),
    []
  );
});

// ---------- 프로세스 환경 직접 변경 (#243) ----------

/** process.env 직접 변경 규칙의 메시지만. */
const envMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-process-env-change");

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
      const [message, ...rest] = envMessages(await lint(code, place));
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
        envMessages(await lint(code, place)),
        [],
        `${place}: ${code}`
      );
});

test("code outside tests may set process.env", async () => {
  assert.deepEqual(
    envMessages(
      await lint(
        envChanges["an assignment to an entry"],
        "scripts/lint-sample.mjs"
      )
    ),
    []
  );
});

/** 기다리지 않은 Promise 규칙(타입 정보)의 메시지만. */
const promiseMessages = (messages) =>
  messages.filter((m) =>
    /^@typescript-eslint\/no-(floating|misused)-promises$/.test(m.ruleId ?? "")
  );

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
      const [message, ...rest] = promiseMessages(
        await lint(promiseHead(place) + code, place)
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
      const [message, ...rest] = promiseMessages(
        await lint(promiseHead(place) + e2eOnly + code, place)
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
    `import { awaitedLater } from "@babojubot/runtime/test-cleanup";\nconst exited = awaitedLater(work());\nawait exited;\n`,
    // 실패를 받는 처리기가 있다.
    `reply.then(\n  (value) => value,\n  (error: unknown) => {\n    throw error;\n  }\n);\n`,
    // 가짜 서버의 실패는 요청한 쪽에 응답으로 돌려준다.
    `import { answering } from "@babojubot/runtime/testing";\nhttp.createServer(\n  answering(async (_req, res) => {\n    await work();\n    res.end();\n  })\n);\n`,
  ];
  for (const code of allowed)
    for (const place of promisePlaces)
      assert.deepEqual(
        promiseMessages(await lint(promiseHead(place) + code, place)),
        [],
        `${place}: ${code}`
      );
  for (const place of promisePlaces.filter(isE2E))
    assert.deepEqual(
      promiseMessages(
        await lint(
          promiseHead(place) +
            e2eOnly +
            `await expect(status).toHaveText("저장됨");\nawait expect(status).not.toBeVisible();\n`,
          place
        )
      ),
      [],
      place
    );
});

/** 빈 처리기로 거절 버리기 규칙의 메시지만. */
const droppedMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-dropped-rejection");
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
      const [message, ...rest] = droppedMessages(
        await lint(droppedHead + code, place)
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
        droppedMessages(await lint(droppedHead + code, place)),
        [],
        `${place}: ${code}`
      );
});

test("code outside tests may drop a rejection", async () => {
  assert.deepEqual(
    droppedMessages(
      await lint(
        droppedHead + `p.catch(() => {});\n`,
        "scripts/lint-sample.mjs"
      )
    ),
    []
  );
});

/** 화면 상태 한 번 읽기 규칙의 메시지만. */
const oneShotMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-one-shot-ui-read");
const oneShotHead = `import { expect, type Locator, type Page } from "@playwright/test";\ndeclare const page: Page;\ndeclare const box: Locator;\nexport {};\n`;

test("an E2E may not assert a UI state it read once from a locator", async () => {
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
      const [message, ...rest] = oneShotMessages(
        await lint(oneShotHead + code, place)
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
        oneShotMessages(await lint(oneShotHead + code, place)),
        [],
        `${place}: ${code}`
      );
});

test("test code may not end a start on a fixed time or count event loop turns in a row", async () => {
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
      const [message, ...rest] = waitMessages(await lint(code, place));
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
        waitMessages(await lint(code, place)),
        [],
        `${place}: ${code}`
      );
});

// JS 시험(node:test·가짜 서버)도 타입 정보로 본다. scripts·.agents는 그 폴더의 tsconfig.json, 시험 폴더의 .mjs는 기본 프로젝트다.
const jsPromisePlaces = [
  "scripts/gh-post.test.mjs",
  "scripts/live/processes.test.mjs",
  ".agents/scripts/check-worker-change.test.mjs",
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
      const [message, ...rest] = promiseMessages(
        await lint(jsPromiseHead + code, place)
      );
      assert.ok(message, `${place}: ${code} not reported`);
      assert.deepEqual(rest, [], `${place}: ${code}`);
    }
  const allowed = `await work();\nawait assert.rejects(work());\ntest("runs", async () => {\n  await work();\n});\ndescribe("group", () => {\n  test("inside", () => {});\n});\n`;
  for (const place of jsPromisePlaces)
    assert.deepEqual(
      promiseMessages(await lint(jsPromiseHead + allowed, place)),
      [],
      place
    );
});

/** awaitedLater 규칙의 메시지만. */
const laterMessages = (messages) =>
  messages.filter((m) => m.ruleId === "tests/no-unawaited-later");
const laterImport = `import { awaitedLater } from "@babojubot/runtime/test-cleanup";\n`;
const laterHead = `const p = Promise.resolve(1);\nconst use = (value) => value;\nconst child = {};\n`;

test("a promise marked with awaitedLater must be stored and awaited later in the same file", async () => {
  const found = {
    "a dropped call": [
      `${laterImport}${laterHead}awaitedLater(p);\n`,
      /담지 않습니다/,
    ],
    "an awaited call": [
      `${laterImport}${laterHead}await awaitedLater(p);\n`,
      /담지 않습니다/,
    ],
    "a call passed on": [
      `${laterImport}${laterHead}use(awaitedLater(p));\n`,
      /담지 않습니다/,
    ],
    "a let": [
      `${laterImport}${laterHead}let later = awaitedLater(p);\nawait later;\n`,
      /담지 않습니다/,
    ],
    "a const never awaited": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nuse(later);\n`,
      /기다리지 않습니다/,
    ],
    "a const only chained": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nlater.then(() => 1);\n`,
      /기다리지 않습니다/,
    ],
    "a property never awaited": [
      `${laterImport}${laterHead}child.exited = awaitedLater(p);\nuse(child.exited);\n`,
      /기다리지 않습니다/,
    ],
    "a same-name property of another object": [
      `${laterImport}${laterHead}const other = {};\nchild.exited = awaitedLater(p);\nawait other.exited;\n`,
      /기다리지 않습니다/,
    ],
    "the same object under another name": [
      `${laterImport}${laterHead}child.exited = awaitedLater(p);\nconst alias = child;\nawait alias.exited;\n`,
      /기다리지 않습니다/,
    ],
    "a shorter path": [
      `${laterImport}${laterHead}child.run = {};\nchild.run.exited = awaitedLater(p);\nawait child.exited;\n`,
      /기다리지 않습니다/,
    ],
    "a property of a call result": [
      `${laterImport}${laterHead}const make = () => child;\nmake().exited = awaitedLater(p);\nawait make().exited;\n`,
      /기다리지 않습니다/,
    ],
    "a computed property": [
      `${laterImport}${laterHead}const key = "exited";\nchild[key] = awaitedLater(p);\nawait child[key];\n`,
      /기다리지 않습니다/,
    ],
    // 출처로 판정한다: 다른 이름, 상대 경로, 이름공간, 다시 받은 const.
    "an aliased import": [
      `import { awaitedLater as later } from "@babojubot/runtime/test-cleanup";\n${laterHead}later(p);\n`,
      /담지 않습니다/,
    ],
    "a relative import": [
      `import { awaitedLater } from "../test-cleanup.ts";\n${laterHead}const x = awaitedLater(p);\nuse(x);\n`,
      /기다리지 않습니다/,
    ],
    "a namespace import": [
      `import * as cleanup from "@babojubot/runtime/test-cleanup";\n${laterHead}cleanup.awaitedLater(p);\n`,
      /담지 않습니다/,
    ],
    "a const alias": [
      `${laterImport}${laterHead}const mark = awaitedLater;\nmark(p);\n`,
      /담지 않습니다/,
    ],
    "the function passed as a value": [
      `${laterImport}${laterHead}[p].map(awaitedLater);\n`,
      /부르지 않고/,
    ],
    // 출처는 이름공간에서 꺼낸 const, 구조 분해, 이름공간의 별칭, 동적 가져오기까지 따라간다(#269).
    "a const taken from the namespace": [
      `import * as cleanup from "@babojubot/runtime/test-cleanup";\n${laterHead}const mark = cleanup.awaitedLater;\nmark(p);\n`,
      /담지 않습니다/,
    ],
    "a name destructured from the namespace": [
      `import * as cleanup from "@babojubot/runtime/test-cleanup";\n${laterHead}const { awaitedLater: mark } = cleanup;\nmark(p);\n`,
      /담지 않습니다/,
    ],
    "an alias of the namespace": [
      `import * as cleanup from "@babojubot/runtime/test-cleanup";\n${laterHead}const tools = cleanup;\ntools.awaitedLater(p);\n`,
      /담지 않습니다/,
    ],
    "a name destructured from a dynamic import": [
      `${laterHead}const { awaitedLater } = await import("@babojubot/runtime/test-cleanup");\nawaitedLater(p);\n`,
      /담지 않습니다/,
    ],
    // 다시 내보내면 다른 파일에서 부른 결과를 따라갈 수 없다.
    "a re-export": [
      `export { awaitedLater } from "@babojubot/runtime/test-cleanup";\n`,
      /부르지 않고/,
    ],
    "a renamed re-export from a relative path": [
      `export { awaitedLater as later } from "../test-cleanup.ts";\n`,
      /부르지 않고/,
    ],
    "a re-export of the whole module": [
      `export * from "@babojubot/runtime/test-cleanup";\n`,
      /부르지 않고/,
    ],
    // 기다림은 그 Promise의 결과를 받는 호출만이다. 무관한 호출의 인자로 넣고 그 호출을 기다려도 기다린 것이 아니다.
    "an await around an unrelated call": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Boolean(later);\n`,
      /기다리지 않습니다/,
    ],
    "an await around a global method": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait console.log(later);\n`,
      /기다리지 않습니다/,
    ],
    "an await around a local function that drops its argument": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst noop = (value) => value !== undefined;\nawait noop(later);\n`,
      /기다리지 않습니다/,
    ],
    // 내장·외부 패키지의 함수는 결과를 받는지 알 수 없다. 이 저장소의 시험 도움만 따라갈 수 없어도 기다림으로 본다.
    "an await around an imported built-in function": [
      `${laterImport}import { inspect } from "node:util";\n${laterHead}const later = awaitedLater(p);\nawait inspect(later);\n`,
      /기다리지 않습니다/,
    ],
    "an await around a method of a built-in namespace": [
      `${laterImport}import * as fsp from "node:fs/promises";\n${laterHead}const later = awaitedLater(p);\nawait fsp.readFile(later);\n`,
      /기다리지 않습니다/,
    ],
    // 결과를 받는 자리는 인자 위치까지 맞아야 한다. 조합 함수는 첫 인자 배열만, expect는 첫 인자만, 가져온 도움은 첫 인자만 받는다(#272 외부 리뷰 F1).
    "a second argument of Promise.all": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.all([], later);\n`,
      /기다리지 않습니다/,
    ],
    "a second argument of Promise.race": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.race([p], later);\n`,
      /기다리지 않습니다/,
    ],
    "a promise passed to Promise.all without an array": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait Promise.all(later);\n`,
      /기다리지 않습니다/,
    ],
    "the message argument of expect": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait expect(p, later).resolves.toBe(1);\n`,
      /기다리지 않습니다/,
    ],
    "a later argument of an imported helper": [
      `${laterImport}import { within } from "./support.ts";\n${laterHead}const later = awaitedLater(p);\nawait within(1000, later);\n`,
      /기다리지 않습니다/,
    ],
    "an await of an array that holds it": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait [later];\n`,
      /기다리지 않습니다/,
    ],
    "a switch without default that awaits in every case": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nswitch (Math.random() > 0.5) {\n  case true:\n    await later;\n    break;\n  case false:\n    await later;\n}\n`,
      /한 분기/,
    ],
    "nested ifs with one leaf that does not await": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nif (Math.random() > 0.5) {\n  if (Math.random() > 0.5) await later;\n  else use(1);\n} else await later;\n`,
      /한 분기/,
    ],
    "an expect that neither rejects nor resolves": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait expect(later).toBeInstanceOf(Promise);\n`,
      /기다리지 않습니다/,
    ],
    "a property read that is not then, catch or finally": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait later.constructor;\n`,
      /기다리지 않습니다/,
    ],
    // 한 분기에서만 기다리면 다른 길에서 거절이 감춰진다.
    "an await in one branch of an if": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nif (Math.random() > 0.5) await later;\n`,
      /한 분기/,
    ],
    "an await behind &&": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst wanted = Math.random() > 0.5;\nwanted && (await later);\n`,
      /한 분기/,
    ],
    "an await in one arm of a conditional expression": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nawait (Math.random() > 0.5 ? later : p);\n`,
      /한 분기/,
    ],
    "an await in a loop that may not run": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nfor (const _ of []) await later;\n`,
      /한 분기/,
    ],
    "an await only in a catch": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\ntry {\n  use(1);\n} catch {\n  await later;\n}\n`,
      /한 분기/,
    ],
    "a property awaited in one branch": [
      `${laterImport}${laterHead}child.exited = awaitedLater(p);\nif (Math.random() > 0.5) await child.exited;\n`,
      /한 분기/,
    ],
    "a local function that awaits its argument in one branch": [
      `${laterImport}${laterHead}const later = awaitedLater(p);\nconst wait = async (value) => {\n  if (Math.random() > 0.5) await value;\n};\nawait wait(later);\n`,
      /한 분기/,
    ],
  };
  for (const [shape, [code, kind]] of Object.entries(found))
    for (const place of testPlaces) {
      const [message, ...rest] = laterMessages(await lint(code, place));
      assert.ok(message, `${place}: ${shape} not reported`);
      assert.deepEqual(rest, [], `${place}: ${shape}`);
      assert.match(message.message, kind, shape);
      assert.match(message.message, /CODING_STANDARDS\.md#단언/);
    }
});

test("a promise marked with awaitedLater may be awaited, collected, expected, returned or read back from its property", async () => {
  const allowed = [
    `const later = awaitedLater(p);\nawait later;\n`,
    `const later = awaitedLater(p);\nawait Promise.all([later, p]);\n`,
    `const later = awaitedLater(p);\nawait expect(later).rejects.toThrow("x");\n`,
    `const later = awaitedLater(p);\nawait use(later.catch(() => undefined));\n`,
    `export function start() {\n  const later = awaitedLater(p);\n  return later;\n}\n`,
    `const later = awaitedLater(p);\nexport const read = () => later;\n`,
    // 속성은 같은 파일의 다른 함수에서 읽어 기다려도 된다.
    `child.exited = awaitedLater(p);\nexport async function wait() {\n  return await Promise.race([child.exited, p]);\n}\n`,
    `child.exited = awaitedLater(p);\nawait child.exited;\n`,
    // 같은 이름으로 넘겨받은 객체, 깊은 경로, this.
    `child.exited = awaitedLater(p);\nexport const wait = (child) => Promise.race([child.exited, p]);\n`,
    `child.run = {};\nchild.run.exited = awaitedLater(p);\nawait child.run.exited;\n`,
    `export class Server {\n  start() {\n    this.exited = awaitedLater(p);\n  }\n  async stop() {\n    await this.exited;\n  }\n}\n`,
    // 같은 파일의 함수는 받은 인자를 기다리는지 따라가고, 가져온 함수(시한 도움 등)는 따라갈 수 없어 기다림으로 본다.
    `const later = awaitedLater(p);\nconst wait = async (value) => {\n  await value;\n};\nawait wait(later);\n`,
    `const later = awaitedLater(p);\nfunction race(value) {\n  return Promise.race([value, p]);\n}\nawait race(later);\n`,
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
  ];
  for (const code of allowed)
    for (const place of testPlaces)
      assert.deepEqual(
        laterMessages(await lint(laterImport + laterHead + code, place)),
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
        laterMessages(await lint(code, place)),
        [],
        `${place}: ${code}`
      );
});
