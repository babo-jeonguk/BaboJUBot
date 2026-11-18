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
