import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeFolder } from "@babojubot/process/remove-folder";
import { withCleanup } from "@babojubot/process/test-cleanup";
import { findCodeMapProblems } from "./check-code-map.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const area = "docs/agents/code-map/area.md";

/** 코드 지도 절 파일의 표. 행마다 [작업, 진입점, 테스트] 칸을 받는다. */
function table(...rows) {
  return [
    "# 영역",
    "",
    "| 작업·증상 | 진입점 | 테스트 |",
    "| --- | --- | --- |",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
  ].join("\n");
}

function writeFiles(root, files) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
}

/** 가짜 저장소(파일 이름 → 내용)에서 지도를 검사한다. */
async function problemsOf(files) {
  return withCleanup((defer) => {
    const root = mkdtempSync(path.join(tmpdir(), "babojubot-code-map-"));
    defer(() => removeFolder(root));
    writeFiles(root, files);
    return findCodeMapProblems({ root, files: Object.keys(files) });
  });
}

const core = {
  "packages/core/src/run.ts": "export function planRunStart() {}\n",
  "packages/core/src/run.test.ts":
    'describe("run termination", () => { test("ends the run", () => {}); });\n',
};

test("passes names that are in the files the row points to", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table([
        "실행 시작",
        "[core/run.ts](../../../packages/core/src/run.ts) `planRunStart`",
        "[core](../../../packages/core/src/run.test.ts)",
      ]),
    }),
    []
  );
});

test("fails a name that is gone, naming the map file, line and name", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table([
        "실행 시작",
        "[core/run.ts](../../../packages/core/src/run.ts) `planRunBegin`",
        "",
      ]),
    }),
    [
      `${area}:5: 없는 이름 \`planRunBegin\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
    ]
  );
});

test("fails a name that lives only in a file the row does not point to", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "packages/db/src/runs.ts": "export function claimNextRun() {}\n",
      [area]: table(["실행 시작", "core/run.ts `claimNextRun`", ""]),
    }),
    [
      `${area}:5: 없는 이름 \`claimNextRun\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
    ]
  );
});

test("searches every code file but Markdown when the row points to no file", async () => {
  const files = {
    ...core,
    "docs/notes.md": "`releaseSlot`\n",
    [area]: table(["실행 시작", "`planRunStart`·`releaseSlot`", ""]),
  };
  assert.deepEqual(await problemsOf(files), [
    `${area}:5: 없는 이름 \`releaseSlot\` — 저장소 코드 전체에서 찾음`,
  ]);
});

test("resolves short file notations under packages and apps, including test and e2e folders", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "apps/server/test/support.ts": "export function eventually() {}\n",
      "apps/web/e2e/support/organization.ts":
        "export function railOrganizationLink() {}\n",
      "scripts/verify-changed.mjs": "export function plan() {}\n",
      [area]: table(
        ["실행 시작", "core/run.ts `planRunStart`", ""],
        ["서버 시험", "server/support.ts `eventually`", ""],
        ["E2E", "web/e2e/support/organization.ts `railOrganizationLink`", ""],
        ["검사 범위", "scripts/verify-changed.mjs `plan`", ""],
        ["파일 이름만", "`run.test.ts`", ""]
      ),
    }),
    []
  );
});

test("fails a file notation that matches no file", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table(["실행 시작", "core/start.ts", ""]),
    }),
    [`${area}:5: 맞는 파일이 없는 파일 표기 \`core/start.ts\``]
  );
});

test("fails a file notation that matches more than one file", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "packages/contracts/src/run.ts": "export const runSchema = {};\n",
      [area]: table(["실행 시작", "run.ts `planRunStart`", ""]),
    }),
    [
      `${area}:5: 여러 파일과 맞는 파일 표기 \`run.ts\`: packages/contracts/src/run.ts, packages/core/src/run.ts — 경로를 더 적어 하나로 좁히세요`,
    ]
  );
});

test("leaves out code notations that are not identifiers: Korean, spaces, quotes, paths, commands, globs", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table([
        '`중단하고 보내기` 버튼, `run ended` 문구, `"queued"`',
        "core/run.ts `planRunStart`, `POST /api/runs`, `/runs/:id`, `pnpm check`, `plan*`, `@babojubot/core`",
        "",
      ]),
    }),
    []
  );
});

test("passes a state value written as a string in the file", async () => {
  assert.deepEqual(
    await problemsOf({
      "packages/contracts/src/run.ts":
        'export const runStates = ["queued", "running"];\n',
      [area]: table([
        "실행 상태 `queued`·`running`",
        "contracts/run.ts `runStates`",
        "",
      ]),
    }),
    []
  );
});

test("finds dotted names whole or piece by piece, private names and call notations", async () => {
  const dispatcher =
    "class RunDispatcher {\n  #settle() {}\n  handled() {}\n}\nhub.publish('message.created');\n";
  const problems = await problemsOf({
    "apps/server/src/dispatcher.ts": dispatcher,
    [area]: table([
      "깨우기",
      "server/dispatcher.ts `RunDispatcher.handled`·`#settle`·`handled()`·`message.created`·`hub.publish`·`RunDispatcher.kick`",
      "",
    ]),
  });
  assert.deepEqual(problems, [
    `${area}:5: 없는 이름 \`RunDispatcher.kick\` — 이 줄이 가리키는 파일: apps/server/src/dispatcher.ts`,
  ]);
});

test("matches names as whole words", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table(["실행 시작", "core/run.ts `planRun`·`no-run`", ""]),
    }),
    [
      `${area}:5: 없는 이름 \`planRun\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
      `${area}:5: 없는 이름 \`no-run\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
    ]
  );
});

test("checks describe names in the test column against the row's test files", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table(
        [
          "실행 끝",
          "core/run.ts",
          "[core](../../../packages/core/src/run.test.ts) `run termination`",
        ],
        [
          "실행 끝 앞부분",
          "core/run.ts",
          "[core](../../../packages/core/src/run.test.ts) `run termin…`",
        ],
        [
          "실행 끝 옛 이름",
          "core/run.ts",
          "[core](../../../packages/core/src/run.test.ts) `run ending`",
        ]
      ),
    }),
    [
      `${area}:7: 없는 시험 이름 \`run ending\` — 이 줄이 가리키는 시험 파일: packages/core/src/run.test.ts`,
    ]
  );
});

test("searches every test file for a test name when the row points to none", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table(
        ["실행 끝", "", "실행 API `run termination`"],
        ["실행 끝 옛 이름", "", "실행 API `run ending`"]
      ),
    }),
    [
      `${area}:6: 없는 시험 이름 \`run ending\` — 저장소 시험 파일 전체에서 찾음`,
    ]
  );
});

test("does not read test names outside the test column", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table(["`run ending` 문구", "core/run.ts", ""]),
    }),
    []
  );
});

test("checks paragraph lines with the same rules and skips fenced code blocks", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: [
        "# 영역",
        "",
        "```text",
        "claimNextRun → core/start.ts `planRunBegin`",
        "```",
        "",
        "늦은 시작은 core/run.ts `planRunStart`, 끝은 `planRunEnd`에서 시작합니다.",
        "",
      ].join("\n"),
    }),
    [
      `${area}:7: 없는 이름 \`planRunEnd\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
    ]
  );
});

test("reads only the code map index and its section files", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "docs/agents/code-map.md": "목차: `planRunStart`, `planRunGone`\n",
      "docs/current-implementation.md": "`planRunGone`\n",
      "docs/agents/code-map/nested/old.md": "`planRunGone`\n",
    }),
    [
      `docs/agents/code-map.md:1: 없는 이름 \`planRunGone\` — 저장소 코드 전체에서 찾음`,
    ]
  );
});

test("the command checks Git's file list and fails with the problems", async () => {
  await withCleanup((defer) => {
    const fixture = mkdtempSync(path.join(tmpdir(), "babojubot-code-map-cli-"));
    defer(() => removeFolder(fixture));
    for (const script of [
      "scripts/check-code-map.mjs",
      "scripts/test-files.mjs",
    ]) {
      mkdirSync(path.dirname(path.join(fixture, script)), { recursive: true });
      copyFileSync(path.join(repository, script), path.join(fixture, script));
    }
    writeFiles(fixture, {
      ".gitignore": ".worktrees/\n",
      ...core,
      // Git이 무시하는 worktree의 같은 이름은 찾은 것으로 치지 않는다.
      ".worktrees/other/packages/db/src/runs.ts":
        "export function claimNextRun() {}\n",
      [area]: table(["실행 시작", "`planRunStart`·`claimNextRun`", ""]),
    });
    execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });

    const result = spawnSync(process.execPath, ["scripts/check-code-map.mjs"], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docs\/agents\/code-map\/area\.md:5: 없는 이름 `claimNextRun` — 저장소 코드 전체에서 찾음/
    );
    assert.doesNotMatch(result.stderr, /planRunStart/);
  });
});
