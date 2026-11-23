import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("searches only source code when the row points to no file; data and lock files count only when the line points to them", async () => {
  const files = {
    ...core,
    "docs/notes.md": "`releaseSlot`\n",
    "pnpm-lock.yaml": "packages:\n  lockedName: {}\n",
    "packages/core/package.json": JSON.stringify({ configName: 1 }),
    "apps/web/src/index.css": ".shellFrame { color: red; }\n",
    [area]: table(
      [
        "실행 시작",
        "`planRunStart`·`releaseSlot`·`lockedName`·`configName`·`shellFrame`",
        "",
      ],
      ["설정", "core/package.json `configName`", ""]
    ),
  };
  assert.deepEqual(await problemsOf(files), [
    `${area}:5: 없는 이름 \`releaseSlot\` — 저장소 소스 코드 전체에서 찾음`,
    `${area}:5: 없는 이름 \`lockedName\` — 저장소 소스 코드 전체에서 찾음`,
    `${area}:5: 없는 이름 \`configName\` — 저장소 소스 코드 전체에서 찾음`,
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
        "core/run.ts `planRunStart`, `POST /api/runs`, `/runs/:id`, `git status`, `plan*`",
        "",
      ]),
    }),
    []
  );
});

const workspace = {
  "package.json": JSON.stringify({
    name: "root",
    scripts: { "check:docs": "node scripts/check-project.mjs", test: "x" },
    devDependencies: { "@types/node": "24.0.0" },
  }),
  "packages/process/package.json": JSON.stringify({
    name: "@babojubot/process",
    exports: {
      ".": "./src/index.ts",
      "./remove-folder": "./src/remove-folder.ts",
      "./fixtures/*": "./src/fixtures/*.ts",
    },
  }),
  "apps/web/package.json": JSON.stringify({
    name: "@babojubot/web",
    scripts: { "test:e2e": "playwright test" },
  }),
  "apps/web/src/main.tsx": "export {};\n",
  // exports가 가리키는 파일. 입구는 대상 파일까지 있어야 쓸 수 있다.
  "packages/process/src/index.ts": "export {};\n",
  "packages/process/src/remove-folder.ts": "export {};\n",
  "packages/process/src/fixtures/lifeline.ts": "export {};\n",
};

test("passes package specifiers whose workspace entry is exported or whose package is declared", async () => {
  assert.deepEqual(
    await problemsOf({
      ...workspace,
      [area]: table([
        "공용 실행",
        "`@babojubot/process`·`@babojubot/process/remove-folder`·`@babojubot/process/fixtures/lifeline`·`@babojubot/web/src/main.tsx`·`@types/node`",
        "",
      ]),
    }),
    []
  );
});

test("fails a package specifier whose entry is not exported, whose workspace package is missing or which no package declares", async () => {
  assert.deepEqual(
    await problemsOf({
      ...workspace,
      [area]: table([
        "공용 실행",
        "`@babojubot/process/test-cleanup`·`@babojubot/launch`·`@babojubot/web/src/gone.tsx`·`@vitest/ui`",
        "",
      ]),
    }),
    [
      `${area}:5: 없는 패키지 입구 \`@babojubot/process/test-cleanup\` — packages/process/package.json의 exports: ., ./remove-folder, ./fixtures/*`,
      `${area}:5: 없는 패키지 \`@babojubot/launch\` — workspace 패키지가 아니고 어느 package.json에도 의존성으로 없음`,
      `${area}:5: 없는 패키지 입구 \`@babojubot/web/src/gone.tsx\` — apps/web/package.json에 exports가 없고 apps/web/src/gone.tsx 파일도 없음`,
      `${area}:5: 없는 패키지 \`@vitest/ui\` — workspace 패키지가 아니고 어느 package.json에도 의존성으로 없음`,
    ]
  );
});

// 입구 이름만 exports에 있어도 Node가 풀지 못하는 입구는 쓸 수 없다: null로 막은 입구, 대상 파일이 없는 입구, 와일드카드가 가리키는
// 파일이 없는 입구(#286 항목 24). Node의 exports 해석(조건 node·import·default)으로 대상을 풀어 그 파일이 있는지 본다.
test("fails a package entry Node cannot resolve to a file: blocked with null, a missing target or a wildcard without its file", async () => {
  const process = {
    name: "@babojubot/process",
    exports: {
      ".": { types: "./src/index.d.ts", import: "./src/index.ts" },
      "./remove-folder": "./src/remove-folder.ts",
      "./internal/*": null,
      "./testing": null,
      "./gone": "./src/gone.ts",
      "./fixtures/*": "./src/fixtures/*.ts",
      "./browser": { browser: "./src/browser.ts" },
    },
  };
  assert.deepEqual(
    await problemsOf({
      ...workspace,
      "packages/process/package.json": JSON.stringify(process),
      "packages/process/src/internal/secret.ts": "export {};\n",
      [area]: table([
        "공용 실행",
        "`@babojubot/process`·`@babojubot/process/remove-folder`·`@babojubot/process/fixtures/lifeline`·`@babojubot/process/testing`·`@babojubot/process/internal/secret`·`@babojubot/process/gone`·`@babojubot/process/fixtures/missing`·`@babojubot/process/browser`",
        "",
      ]),
    }),
    [
      `${area}:5: 없는 패키지 입구 \`@babojubot/process/testing\` — packages/process/package.json exports가 막은 입구(null): ./testing`,
      `${area}:5: 없는 패키지 입구 \`@babojubot/process/internal/secret\` — packages/process/package.json exports가 막은 입구(null): ./internal/secret`,
      `${area}:5: 없는 패키지 입구 \`@babojubot/process/gone\` — packages/process/package.json exports의 ./gone 대상 packages/process/src/gone.ts 파일이 없음`,
      `${area}:5: 없는 패키지 입구 \`@babojubot/process/fixtures/missing\` — packages/process/package.json exports의 ./fixtures/missing 대상 packages/process/src/fixtures/missing.ts 파일이 없음`,
      `${area}:5: 없는 패키지 입구 \`@babojubot/process/browser\` — packages/process/package.json exports에서 node·import·default 조건으로 풀리는 대상이 없는 입구: ./browser`,
    ]
  );
});

test("resolves Markdown file notations to one file without searching names in them", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "docs/agents/worker.md": "`planRunGone`\n",
      "README.md": "# r\n",
      "docs/README.md": "# d\n",
      [area]: table(
        ["worker 문서", "`docs/agents/worker.md`, worker.md `planRunGone`", ""],
        ["없는 문서", "`docs/agents/gone.md`", ""],
        ["모호한 문서", "README.md", ""]
      ),
    }),
    [
      `${area}:5: 없는 이름 \`planRunGone\` — 저장소 소스 코드 전체에서 찾음`,
      `${area}:6: 맞는 파일이 없는 파일 표기 \`docs/agents/gone.md\``,
      `${area}:7: 여러 파일과 맞는 파일 표기 \`README.md\`: README.md, docs/README.md — 경로를 더 적어 하나로 좁히세요`,
    ]
  );
});

test("checks that the script a pnpm command runs is in the package.json it targets", async () => {
  assert.deepEqual(
    await problemsOf({
      ...workspace,
      [area]: table([
        "검사",
        "`pnpm check:docs`·`pnpm run test`·`pnpm --filter @babojubot/web run test:e2e`·`pnpm --filter=@babojubot/web test:e2e`·`pnpm exec eslint .`·`pnpm install`·`pnpm check:gone`·`pnpm --filter @babojubot/web run build`·`pnpm --filter @babojubot/nope test`",
        "",
      ]),
    }),
    [
      `${area}:5: 없는 pnpm 스크립트 \`pnpm check:gone\` — package.json의 scripts에 check:gone 없음`,
      `${area}:5: 없는 pnpm 스크립트 \`pnpm --filter @babojubot/web run build\` — apps/web/package.json의 scripts에 build 없음`,
      `${area}:5: 없는 pnpm 스크립트 \`pnpm --filter @babojubot/nope test\` — workspace 패키지 @babojubot/nope 없음`,
    ]
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

test("reads dotted names as paths of classes, interfaces, object constants, type literals and enums", async () => {
  const dispatcher = [
    "class RunDispatcher {",
    "  #settle() {}",
    "  handled() {}",
    "}",
    "interface RunningServer { kickHandled(): void }",
    "export const queryKeys = { overview: ['overview'], nested: { deep: 1 } } as const;",
    "type Options = { clock: { now(): number } };",
    "enum Stage { Planning }",
    "const hub = new EventHub();",
    "hub.publish('message.created');",
  ].join("\n");
  const problems = await problemsOf({
    "apps/server/src/dispatcher.ts": dispatcher,
    [area]: table([
      "깨우기",
      "server/dispatcher.ts `RunDispatcher.handled`·`#settle`·`handled()`·`RunningServer.kickHandled`·`queryKeys.overview`·`queryKeys.nested.deep`·`Options.clock.now`·`Stage.Planning`·`message.created`·`hub.publish`·`RunDispatcher.kick`",
      "",
    ]),
  });
  assert.deepEqual(problems, [
    `${area}:5: 없는 이름 \`hub.publish\` — 이 줄이 가리키는 파일: apps/server/src/dispatcher.ts`,
    `${area}:5: 없는 이름 \`RunDispatcher.kick\` — 이 줄이 가리키는 파일: apps/server/src/dispatcher.ts`,
  ]);
});

// 괄호를 붙인 표기는 부를 수 있는 것을 가리킨다. 함수를 지워도 같은 이름의 이벤트명·로그 문자열이나 값 속성이 남으면, 괄호를 떼고 문자열과
// 같은 판정에 넣는 검사는 지도를 통과시킨다(#286 항목 22).
test("checks a notation with call parentheses against what can be called, not strings or value properties", async () => {
  const selection = [
    'export const selectionEvent = "watchSelection";',
    "export const settings = { pollSelection: 1, readSelection: () => 1 };",
    "export interface Viewer { zoom: number; pan(by: number): void; tilt: (by: number) => void }",
    "export enum Mode { resetSelection }",
    "export function keepSelection() {}",
    "export const dropSelection = function () {};",
    "export class Selector { stop() {} }",
    "export const pickSelection = (id: string) => id;",
  ].join("\n");
  assert.deepEqual(
    await problemsOf({
      "apps/web/src/selection.ts": selection,
      [area]: table([
        "선택",
        "web/selection.ts `watchSelection()`·`pollSelection()`·`zoom()`·`resetSelection()`·`readSelection()`·`pan(by)`·`tilt(by)`·`keepSelection()`·`dropSelection()`·`Selector()`·`stop()`·`Selector.stop()`·`pickSelection(id)`·`watchSelection`",
        "",
      ]),
    }),
    [
      `${area}:5: 부를 수 있는 정의가 없는 호출 표기 \`watchSelection()\` — 이 줄이 가리키는 파일: apps/web/src/selection.ts`,
      `${area}:5: 부를 수 있는 정의가 없는 호출 표기 \`pollSelection()\` — 이 줄이 가리키는 파일: apps/web/src/selection.ts`,
      `${area}:5: 부를 수 있는 정의가 없는 호출 표기 \`zoom()\` — 이 줄이 가리키는 파일: apps/web/src/selection.ts`,
      `${area}:5: 부를 수 있는 정의가 없는 호출 표기 \`resetSelection()\` — 이 줄이 가리키는 파일: apps/web/src/selection.ts`,
    ]
  );
});

test("fails a name whose definition is gone though a comment or another word still holds it", async () => {
  assert.deepEqual(
    await problemsOf({
      "packages/core/src/run.ts": [
        "// planRunStart는 planRun으로 합쳤다.",
        "/** planRunBegin도 없다. */",
        "export function planRun() { return 'planRunStart was here'; }",
      ].join("\n"),
      [area]: table([
        "실행 시작",
        "core/run.ts `planRunStart`·`planRunBegin`·`planRun`",
        "",
      ]),
    }),
    [
      `${area}:5: 없는 이름 \`planRunStart\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
      `${area}:5: 없는 이름 \`planRunBegin\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
    ]
  );
});

test("fails a name the file only imports or calls; the defining file must be on the line", async () => {
  assert.deepEqual(
    await problemsOf({
      "packages/db/src/runs.ts": "export async function claimNextRun() {}\n",
      "apps/server/src/dispatcher.ts":
        'import { claimNextRun } from "@babojubot/db";\nawait claimNextRun();\n',
      [area]: table(
        ["깨우기", "server/dispatcher.ts `claimNextRun`", ""],
        ["깨우기", "server/dispatcher.ts, db/runs.ts `claimNextRun`", ""]
      ),
    }),
    [
      `${area}:5: 없는 이름 \`claimNextRun\` — 이 줄이 가리키는 파일: apps/server/src/dispatcher.ts`,
    ]
  );
});

test("accepts declarations of every kind, exported or not, in TypeScript and JavaScript files", async () => {
  assert.deepEqual(
    await problemsOf({
      "packages/core/src/kinds.ts": [
        "function localPlan() {}",
        "export class Planner { readonly limit = 1; constructor(private readonly clock: Clock) {} get size() { return 1; } }",
        "interface Clock { now(): number }",
        "export type Choice = 'a' | 'b';",
        "const { first, second: renamed } = pair;",
        "enum Stage { Planning, Done }",
        "export { localPlan as exportedPlan };",
        "const handlers = { onStop, 'kebab-key': 1 };",
      ].join("\n"),
      "scripts/tool.mjs":
        "export const toolName = 'x';\nfunction helper() {}\n",
      [area]: table(
        [
          "종류",
          "core/kinds.ts `localPlan`·`Planner`·`limit`·`clock`·`size`·`Clock`·`now`·`Choice`·`first`·`renamed`·`Stage`·`Done`·`exportedPlan`·`onStop`·`kebab-key`",
          "",
        ],
        ["스크립트", "scripts/tool.mjs `toolName`·`helper`", ""]
      ),
    }),
    []
  );
});

test("takes property names of unnamed object types and JSX attributes as definitions", async () => {
  assert.deepEqual(
    await problemsOf({
      "apps/server/src/dispatcher.ts":
        "export class RunDispatcher { constructor(options: { onLoginRequired?: () => void }) {} }\n",
      "apps/web/src/shell.tsx":
        "export function Shell() { return <Sheet onCloseAutoFocus={() => {}} />; }\n",
      [area]: table(
        [
          "준비 확인",
          "server/dispatcher.ts `onLoginRequired`·`onLoginGone`",
          "",
        ],
        ["포커스", "web/shell.tsx `Shell`·`onCloseAutoFocus`", ""]
      ),
    }),
    [
      `${area}:5: 없는 이름 \`onLoginGone\` — 이 줄이 가리키는 파일: apps/server/src/dispatcher.ts`,
    ]
  );
});

test("passes an identifier-shaped notation in the test column as a test title or a name the line's files define", async () => {
  assert.deepEqual(
    await problemsOf({
      "apps/server/test/notifications.test.ts":
        'describe("Inbox", () => {});\nexport function respondWithTools() {}\n',
      [area]: table([
        "Inbox",
        "",
        "[알림 API](../../../apps/server/test/notifications.test.ts) `Inbox`·`respondWithTools`·`InboxGone`",
      ]),
    }),
    [
      `${area}:5: 없는 시험 이름·이름 \`InboxGone\` — 이 줄이 가리키는 파일: apps/server/test/notifications.test.ts`,
    ]
  );
});

test("takes an environment variable's read site as its definition, not other property reads", async () => {
  assert.deepEqual(
    await problemsOf({
      "apps/server/src/main.ts": [
        "const providers = process.env.BABOJUBOT_PROVIDERS;",
        "const fake = env.BABOJUBOT_FAKE_PROVIDERS;",
        "const other = options.BABOJUBOT_OTHER;",
      ].join("\n"),
      [area]: table([
        "설정",
        "server/main.ts `BABOJUBOT_PROVIDERS`·`BABOJUBOT_FAKE_PROVIDERS`·`BABOJUBOT_OTHER`",
        "",
      ]),
    }),
    [
      `${area}:5: 없는 이름 \`BABOJUBOT_OTHER\` — 이 줄이 가리키는 파일: apps/server/src/main.ts`,
    ]
  );
});

test("reads JSON and YAML keys and values, and other text files without their comments", async () => {
  assert.deepEqual(
    await problemsOf({
      "harness/roles/lead/role.json": JSON.stringify({
        heartbeatMinutes: 30,
        skills: ["planning"],
      }),
      ".github/workflows/scaffold.yml":
        "jobs:\n  test-windows:\n    name: windows # test-gone\n",
      "apps/web/src/index.css":
        "/* skip-gone */\n@media (prefers-reduced-motion: reduce) { .skip-link { color: red; } }\n",
      [area]: table(
        ["Role", "roles/lead/role.json `heartbeatMinutes`·`planning`", ""],
        ["CI", "scaffold.yml `test-windows`·`windows`·`test-gone`", ""],
        [
          "화면",
          "web/index.css `prefers-reduced-motion`·`skip-link`·`skip-gone`",
          "",
        ]
      ),
    }),
    [
      `${area}:6: 없는 이름 \`test-gone\` — 이 줄이 가리키는 파일: .github/workflows/scaffold.yml`,
      `${area}:7: 없는 이름 \`skip-gone\` — 이 줄이 가리키는 파일: apps/web/src/index.css`,
    ]
  );
});

test("takes test names only from describe, it and test titles", async () => {
  assert.deepEqual(
    await problemsOf({
      "apps/server/test/isolation.test.ts": [
        "// isolated runs used to be here",
        "const label = 'stale runs';",
        'describe.skipIf(!available)("isolated runs on a real Docker engine", () => {',
        '  it("keeps the relay", () => {});',
        '  test.describe("container mounts", () => {});',
        "});",
      ].join("\n"),
      [area]: table(
        [
          "격리",
          "",
          "[서버](../../../apps/server/test/isolation.test.ts) `isolated runs on…`·`keeps the relay`·`container mounts`",
        ],
        [
          "격리",
          "",
          "[서버](../../../apps/server/test/isolation.test.ts) `isolated runs`·`stale runs`",
        ]
      ),
    }),
    [
      `${area}:6: 없는 시험 이름 \`isolated runs\` — 이 줄이 가리키는 시험 파일: apps/server/test/isolation.test.ts`,
      `${area}:6: 없는 시험 이름 \`stale runs\` — 이 줄이 가리키는 시험 파일: apps/server/test/isolation.test.ts`,
    ]
  );
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
      `docs/agents/code-map.md:1: 없는 이름 \`planRunGone\` — 저장소 소스 코드 전체에서 찾음`,
    ]
  );
});

test("skips listed paths that are not regular files, such as a link to a folder", async () => {
  const problems = await withCleanup((defer) => {
    const root = mkdtempSync(path.join(tmpdir(), "babojubot-code-map-"));
    defer(() => removeFolder(root));
    const files = {
      ...core,
      [area]: table(["실행 시작", "`planRunGone`", ""]),
    };
    writeFiles(root, files);
    // Git은 폴더를 가리키는 링크를 파일 하나로 적는다(.claude/skills/reference-first).
    mkdirSync(path.join(root, ".claude/skills/reference-first"), {
      recursive: true,
    });
    return findCodeMapProblems({
      root,
      files: [...Object.keys(files), ".claude/skills/reference-first"],
    });
  });
  assert.deepEqual(problems, [
    `${area}:5: 없는 이름 \`planRunGone\` — 저장소 소스 코드 전체에서 찾음`,
  ]);
});

test("recognizes file notations with one rule inside and outside backticks, by the extensions the repository tracks or can read", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "packages/process/src/job-object-launcher.cs": "class Launcher { }\n",
      ".github/workflows/scaffold.yml": "jobs: {}\n",
      [area]: table(
        [
          "실행기",
          "`process/job-object-launcher.cs` `Launcher`, process/gone.cs",
          "",
        ],
        ["화면", "`web/gone.jsx`, web/other.jsx", ""],
        [
          "CI",
          ".github/workflows/scaffold.yml, .github/workflows/missing.yml",
          "",
        ]
      ),
    }),
    [
      `${area}:5: 맞는 파일이 없는 파일 표기 \`process/gone.cs\``,
      `${area}:6: 맞는 파일이 없는 파일 표기 \`web/other.jsx\``,
      `${area}:6: 맞는 파일이 없는 파일 표기 \`web/gone.jsx\``,
      `${area}:7: 맞는 파일이 없는 파일 표기 \`.github/workflows/missing.yml\``,
    ]
  );
});

test("checks folder notations against the tracked files", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "scripts/tool.mjs": "export {};\n",
      [area]: table(["폴더", "`scripts/`·`core/`·`set-aside/`", ""]),
    }),
    [`${area}:5: 맞는 폴더가 없는 폴더 표기 \`set-aside/\``]
  );
});

test("fails a code notation that no rule classifies, and leaves out only the shapes the exclusion rules name", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: table([
        "실행 시작",
        "core/run.ts `planRunStart`, `run ended` `실행 중` `/api/runs` `plan*` `{a,b}` `.skip-link` `--color-slate-500` `-2` `()` `MAP_PERF=1` `a:b`",
        "",
      ]),
    }),
    [
      `${area}:5: 분류할 수 없는 코드 표기 \`MAP_PERF=1\` — 파일·폴더·패키지·pnpm 명령·이름·제외 규칙(문구, HTTP 경로, 무늬, 점·대시로 시작, 기호만) 어디에도 맞지 않음`,
      `${area}:5: 분류할 수 없는 코드 표기 \`a:b\` — 파일·폴더·패키지·pnpm 명령·이름·제외 규칙(문구, HTTP 경로, 무늬, 점·대시로 시작, 기호만) 어디에도 맞지 않음`,
    ]
  );
});

test("reads a bare package name as a package that some package.json must declare, not as a name an import string satisfies", async () => {
  assert.deepEqual(
    await problemsOf({
      ...workspace,
      "scripts/tool.mjs":
        'import ts from "typescript";\nimport pad from "leftpad";\nconst lazy = await import("lazypkg");\nconst req = require("reqpkg");\n',
      [area]: table([
        "도구",
        "scripts/tool.mjs `@types/node`·`leftpad`·`lazypkg`·`reqpkg`",
        "",
      ]),
    }),
    [
      // 가져오기만 한 이름(\`import ts\`)도 모듈 경로 문자열도 정의가 아니다.
      `${area}:5: 없는 이름 \`leftpad\` — 이 줄이 가리키는 파일: scripts/tool.mjs`,
      `${area}:5: 없는 이름 \`lazypkg\` — 이 줄이 가리키는 파일: scripts/tool.mjs`,
      `${area}:5: 없는 이름 \`reqpkg\` — 이 줄이 가리키는 파일: scripts/tool.mjs`,
    ]
  );
  assert.deepEqual(
    await problemsOf({
      ...workspace,
      "package.json": JSON.stringify({
        name: "root",
        devDependencies: { typescript: "6.0.0", yaml: "2.0.0" },
      }),
      [area]: table(["도구", "`typescript`·`yaml`", ""]),
    }),
    []
  );
});

test("skips code blocks by CommonMark: tilde and longer fences, unclosed fences and indented blocks, but not indented paragraph or list continuations", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: [
        "# 영역",
        "",
        "~~~text",
        "`goneInTilde`",
        "~~~",
        "",
        "````md",
        "```",
        "`goneInLongFence`",
        "````",
        "",
        "    `goneInIndentedBlock`",
        "",
        "문단 첫 줄 `planRunStart`",
        "    `goneInParagraphContinuation`",
        "",
        "- 목록 항목 `planRunStart`",
        "",
        "    `goneInListContinuation`",
        "",
        "```",
        "`goneInUnclosedFence`",
      ].join("\n"),
    }),
    [
      `${area}:15: 없는 이름 \`goneInParagraphContinuation\` — 저장소 소스 코드 전체에서 찾음`,
      `${area}:19: 없는 이름 \`goneInListContinuation\` — 저장소 소스 코드 전체에서 찾음`,
    ]
  );
});

test("reads code spans and table cells by CommonMark and GFM: backtick runs of equal length and escaped pipes", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: [
        "# 영역",
        "",
        "| 작업·증상 | 진입점 | 테스트 |",
        "| --- | --- | --- |",
        "| 실행 | core/run.ts ``planRunStart`` `` `planRunGone` `` \\| `planRunEnd` | |",
        "",
      ].join("\n"),
    }),
    [
      `${area}:5: 없는 이름 \`planRunEnd\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
    ]
  );
});

test("reads blocks by the parser: reference links point to files, block quotes are checked, HTML blocks are not Markdown", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      [area]: [
        "# 영역",
        "",
        "| 작업·증상 | 진입점 | 테스트 |",
        "| --- | --- | --- |",
        "| 실행 | [core][run] `planRunStart`·`planRunGone` | |",
        "",
        "> 인용 `planRunQuoted`",
        "",
        "<div>",
        "`planRunInHtml`",
        "</div>",
        "",
        "[run]: ../../../packages/core/src/run.ts",
        "",
      ].join("\n"),
    }),
    [
      `${area}:5: 없는 이름 \`planRunGone\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
      `${area}:7: 없는 이름 \`planRunQuoted\` — 저장소 소스 코드 전체에서 찾음`,
    ]
  );
});

// CommonMark(§4.7)는 같은 이름의 참조 정의가 둘이면 첫 정의를 쓴다. 마지막 정의로 풀면 렌더러가 가리키지 않는 파일에서 이름을 찾아
// 통과한다(#286 항목 23).
test("resolves a reference link by its first definition, as CommonMark renders it", async () => {
  assert.deepEqual(
    await problemsOf({
      ...core,
      "packages/core/src/other.ts": "export function otherOnly() {}\n",
      [area]: [
        "# 영역",
        "",
        "| 작업·증상 | 진입점 | 테스트 |",
        "| --- | --- | --- |",
        "| 실행 | [core][run] `planRunStart`·`otherOnly` | |",
        "",
        "[run]: ../../../packages/core/src/run.ts",
        "[RUN]: ../../../packages/core/src/other.ts",
        "",
      ].join("\n"),
    }),
    [
      `${area}:5: 없는 이름 \`otherOnly\` — 이 줄이 가리키는 파일: packages/core/src/run.ts`,
    ]
  );
});

test("the command checks Git's file list and fails with the problems", async () => {
  await withCleanup((defer) => {
    const fixture = mkdtempSync(path.join(tmpdir(), "babojubot-code-map-cli-"));
    defer(() => removeFolder(fixture));
    for (const script of [
      "scripts/check-code-map.mjs",
      "scripts/markdown.mjs",
      "scripts/package-exports.ts",
      "scripts/test-files.mjs",
    ]) {
      mkdirSync(path.dirname(path.join(fixture, script)), { recursive: true });
      copyFileSync(path.join(repository, script), path.join(fixture, script));
    }
    // 복사한 검사기가 저장소의 typescript·yaml을 가져가도록 node_modules를 잇는다.
    symlinkSync(
      path.join(repository, "node_modules"),
      path.join(fixture, "node_modules"),
      "junction"
    );
    writeFiles(fixture, {
      ".gitignore": ".worktrees/\nnode_modules\n",
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
      /docs\/agents\/code-map\/area\.md:5: 없는 이름 `claimNextRun` — 저장소 소스 코드 전체에서 찾음/
    );
    assert.doesNotMatch(result.stderr, /planRunStart/);
  });
});
