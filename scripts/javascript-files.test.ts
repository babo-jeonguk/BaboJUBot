// 새 JS 파일 금지(#270 PR 3b-1). 스크립트·시험·도구는 TypeScript로 쓴다. 바뀐 파일 목록(merge-base와의 `git diff`, 이름 바꾸기
// 포함)에서 새로 더해진 JS를 찾는다. JS를 TypeScript로 옮기기(이름 바꾸기)와 기존 JS 고치기·옮기기·지우기는 받는다. 예외 목록은 없다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addedJavaScript, isJavaScript } from "./javascript-files.ts";

const script = fileURLToPath(new URL("./javascript-files.ts", import.meta.url));
const workflow = fileURLToPath(
  new URL("../.github/workflows/scaffold.yml", import.meta.url)
);

/** `git diff -z --name-status --find-renames`의 출력 모양: 상태와 경로(이름 바꾸기·복사는 원래 경로와 새 경로)를 NUL로 잇는다. */
const diff = (...entries: string[][]) =>
  entries.map((fields) => `${fields.join("\0")}\0`).join("");

/** 명령에 바뀐 파일 목록을 표준 입력으로 준다. */
const check = (input: string) =>
  spawnSync(process.execPath, [script], {
    input,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });

test("JavaScript is every format TypeScript reads as JavaScript", () => {
  assert.deepEqual(
    [
      "a.js",
      "a.jsx",
      "a.mjs",
      "a.cjs",
      "a.ts",
      "a.tsx",
      "a.mts",
      "a.cts",
      "a.d.ts",
      "a.json",
      "a.md",
    ].filter(isJavaScript),
    ["a.js", "a.jsx", "a.mjs", "a.cjs"]
  );
});

test("a JavaScript file that is added, copied or renamed from another format is new JavaScript", () => {
  assert.deepEqual(
    addedJavaScript(
      diff(
        ["A", "scripts/new.mjs"],
        ["C75", "scripts/old.mjs", "scripts/copy.mjs"],
        ["R90", "scripts/typed.ts", "scripts/back.mjs"],
        ["A", "apps/web/e2e/support/server.cjs"],
        ["A", "scripts/new.ts"]
      )
    ),
    [
      "scripts/new.mjs",
      "scripts/copy.mjs",
      "scripts/back.mjs",
      "apps/web/e2e/support/server.cjs",
    ]
  );
});

test("moving JavaScript to TypeScript and editing, moving or deleting existing JavaScript add none", () => {
  assert.deepEqual(
    addedJavaScript(
      diff(
        [
          "R080",
          ".agents/scripts/run-worker.mjs",
          ".agents/scripts/run-worker.ts",
        ],
        ["M", "scripts/gh-post.mjs"],
        ["R100", "scripts/a.mjs", "scripts/live/a.mjs"],
        ["D", "scripts/old.mjs"],
        ["T", "scripts/link.mjs"]
      )
    ),
    []
  );
  assert.deepEqual(addedJavaScript(""), []);
});

test("the command names each new JavaScript file and fails, and passes when there is none", () => {
  const refused = check(
    diff(["A", "scripts/new.mjs"], ["A", "a folder/b.cjs"], ["A", "c.ts"])
  );
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(
    refused.stdout
      .split("\n")
      .filter((line) => line.startsWith("::error"))
      .map((line) => line.slice(0, line.indexOf("::", 2))),
    ["::error file=scripts/new.mjs", "::error file=a folder/b.cjs"]
  );
  assert.match(refused.stdout, /TypeScript/);

  const passed = check(diff(["M", "scripts/gh-post.mjs"], ["A", "c.ts"]));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, "");
});

// CI는 바뀐 파일을 고르는 job(changes)에서 같은 기준으로 본다: pull request는 base와의 merge-base, push는 앞 push와의 merge-base다.
// 그 job은 타입을 지우고 .ts를 바로 돌리는 Node 24를 준비한다.
test("CI refuses new JavaScript against the merge base in the job that picks the changes", () => {
  const text = readFileSync(workflow, "utf8");
  const changes = text.slice(
    text.indexOf("\n  changes:\n"),
    text.indexOf("\n  check:\n")
  );
  assert.ok(changes.length > 0, "no changes job");
  assert.match(
    changes,
    /uses: actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version: "24"/
  );
  assert.match(
    changes,
    /git diff -z --name-status --find-renames "\$BASE"\.\.\.HEAD \| node scripts\/javascript-files\.ts/
  );
});
