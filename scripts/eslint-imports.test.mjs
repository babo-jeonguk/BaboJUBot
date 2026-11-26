// 가져오는 자리를 모으는 공용 판정(scripts/eslint-imports.mjs)이 모든 가져오기 모양에서 경로·종류·이름을 내는지 본다(#266 리뷰 SPEC-1).
// 가져오기를 보는 저장소 규칙은 모두 이 판정을 쓰므로, 여기서 한 모양을 놓치면 모든 규칙이 함께 놓친다.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeFolder } from "@babojubot/process/remove-folder";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import {
  importSites,
  originOf,
  packageEntry,
  workspacePackage,
} from "./eslint-imports.mjs";

/** `code`의 가져오는 자리를 `{ kind, source, loader, typeOnly, names }`로 모은다. 이름은 `imported>local` 문자열. */
function sitesOf(code) {
  const sites = [];
  const linter = new Linter({ configType: "flat" });
  linter.verify(code, [
    {
      languageOptions: { parser: tseslint.parser, sourceType: "module" },
      plugins: {
        probe: {
          rules: {
            sites: {
              create: (context) =>
                importSites(context, (site) =>
                  sites.push({
                    kind: site.kind,
                    source: site.source,
                    loader: site.loader,
                    typeOnly: site.typeOnly,
                    names: site.names.map(
                      (name) => `${name.imported}>${name.local ?? ""}`
                    ),
                  })
                ),
            },
          },
        },
      },
      rules: { "probe/sites": "error" },
    },
  ]);
  return sites;
}

test("reads static imports with their names, defaults, namespaces and type-only imports", () => {
  assert.deepEqual(
    sitesOf(
      `import a, { b, c as d } from "m1";\nimport * as ns from "m2";\nimport type { T } from "m3";\nimport { type U } from "m4";\nimport "m5";\n`
    ),
    [
      {
        kind: "import",
        source: "m1",
        loader: "import",
        typeOnly: false,
        names: ["default>a", "b>b", "c>d"],
      },
      {
        kind: "import",
        source: "m2",
        loader: "import",
        typeOnly: false,
        names: ["*>ns"],
      },
      {
        kind: "import",
        source: "m3",
        loader: "import",
        typeOnly: true,
        names: ["T>T"],
      },
      {
        kind: "import",
        source: "m4",
        loader: "import",
        typeOnly: true,
        names: ["U>U"],
      },
      {
        kind: "import",
        source: "m5",
        loader: "import",
        typeOnly: false,
        names: [],
      },
    ]
  );
});

test("reads re-exports by name and whole", () => {
  assert.deepEqual(
    sitesOf(
      `export { a, b as c } from "m1";\nexport * from "m2";\nexport * as ns from "m3";\nexport type { T } from "m4";\nexport const x = 1;\n`
    ),
    [
      {
        kind: "export",
        source: "m1",
        loader: "export",
        typeOnly: false,
        names: ["a>a", "b>c"],
      },
      {
        kind: "export",
        source: "m2",
        loader: "export",
        typeOnly: false,
        names: ["*>"],
      },
      {
        kind: "export",
        source: "m3",
        loader: "export",
        typeOnly: false,
        names: ["*>ns"],
      },
      {
        kind: "export",
        source: "m4",
        loader: "export",
        typeOnly: true,
        names: ["T>T"],
      },
    ]
  );
});

test("reads dynamic imports with the names taken from them", () => {
  assert.deepEqual(
    sitesOf(
      `const ns = await import("m1");\nconst { a, b: c } = await import("m2");\nvoid (await import("m3")).d;\nvoid import("m4");\nconst name = "m5";\nvoid import(name);\n`
    ).map(({ kind, source, names }) => ({ kind, source, names })),
    [
      { kind: "dynamic", source: "m1", names: ["*>ns"] },
      { kind: "dynamic", source: "m2", names: ["a>a", "b>c"] },
      { kind: "dynamic", source: "m3", names: ["d>"] },
      { kind: "dynamic", source: "m4", names: ["*>"] },
    ]
  );
});

test("reads require, createRequire functions and getBuiltinModule with the names taken from them", () => {
  assert.deepEqual(
    sitesOf(
      [
        `import { createRequire } from "node:module";`,
        `import nodeModule from "node:module";`,
        `const cp = require("m1");`,
        `const { a, b: c } = require("m2");`,
        `const load = createRequire(import.meta.url);`,
        `const { d } = load("m3");`,
        `void load("m4").e;`,
        `void createRequire(import.meta.url)("m5");`,
        `const other = nodeModule.createRequire(import.meta.url);`,
        `void other("m6");`,
        `const { spawn } = process.getBuiltinModule("node:child_process");`,
        `const name = "m7";`,
        `void require(name);`,
        `void notALoader("m8");`,
      ].join("\n")
    )
      .filter((site) => site.kind !== "import")
      .map(({ kind, source, loader, names }) => ({
        kind,
        source,
        loader,
        names,
      })),
    [
      { kind: "require", source: "m1", loader: "require", names: ["*>cp"] },
      {
        kind: "require",
        source: "m2",
        loader: "require",
        names: ["a>a", "b>c"],
      },
      { kind: "require", source: "m3", loader: "load", names: ["d>d"] },
      { kind: "require", source: "m4", loader: "load", names: ["e>"] },
      {
        kind: "require",
        source: "m5",
        loader: "createRequire(…)",
        names: ["*>"],
      },
      { kind: "require", source: "m6", loader: "other", names: ["*>"] },
      {
        kind: "require",
        source: "node:child_process",
        loader: "getBuiltinModule",
        names: ["spawn>spawn"],
      },
    ]
  );
});

test("reads vitest's loaders: importActual and importMock with the names taken from them, and the module a mock factory gets as its original", () => {
  assert.deepEqual(
    sitesOf(
      [
        `import { vi } from "vitest";`,
        `const { a } = await vi.importActual("m1");`,
        `const whole = await vi.importMock("m2");`,
        `vi.mock("m3", async (original) => ({ ...(await original()) }));`,
        `vi.doMock("m4");`,
        `vi.unmock("m5");`,
        `const name = "m6";`,
        `void vi.importActual(name);`,
        `const notVi = { importActual: (m: string) => m };`,
        `void notVi.importActual("m7");`,
      ].join("\n")
    )
      .filter((site) => site.kind !== "import")
      .map(({ kind, source, loader, names }) => ({
        kind,
        source,
        loader,
        names,
      })),
    [
      {
        kind: "require",
        source: "m1",
        loader: "vi.importActual",
        names: ["a>a"],
      },
      {
        kind: "require",
        source: "m2",
        loader: "vi.importMock",
        names: ["*>whole"],
      },
      { kind: "require", source: "m3", loader: "vi.mock", names: ["*>"] },
      { kind: "require", source: "m4", loader: "vi.doMock", names: ["*>"] },
    ]
  );
});

test("tells a value taken from vitest's importActual by the module it loads", () => {
  const code = `import { vi } from "vitest";\nconst hooks = await vi.importActual("node:async_hooks");\nvoid hooks.AsyncLocalStorage;\n`;
  const found = [];
  const linter = new Linter({ configType: "flat" });
  linter.verify(code, [
    {
      languageOptions: { parser: tseslint.parser, sourceType: "module" },
      plugins: {
        probe: {
          rules: {
            origin: {
              create: (context) => ({
                "MemberExpression[property.name='AsyncLocalStorage']"(node) {
                  found.push(originOf(context.sourceCode.getScope(node), node));
                },
              }),
            },
          },
        },
      },
      rules: { "probe/origin": "error" },
    },
  ]);
  assert.deepEqual(found, [
    { module: "async_hooks", path: ["AsyncLocalStorage"] },
  ]);
});

test("reads TypeScript import-equals requires like import-x's module visitor", () => {
  assert.deepEqual(
    sitesOf(
      `import fs = require("m1");\nimport type T = require("m2");\nimport N = Space.Inner;\n`
    ),
    [
      {
        kind: "require",
        source: "m1",
        loader: "import =",
        typeOnly: false,
        names: ["*>fs"],
      },
      {
        kind: "require",
        source: "m2",
        loader: "import =",
        typeOnly: true,
        names: ["*>T"],
      },
    ]
  );
});

test("reads resolve calls as paths without names", () => {
  assert.deepEqual(
    sitesOf(
      `import { createRequire } from "node:module";\nvoid require.resolve("m1");\nconst load = createRequire(import.meta.url);\nvoid load.resolve("m2");\nvoid createRequire(import.meta.url).resolve("m3");\nvoid path.resolve("m4");\n`
    )
      .filter((site) => site.kind !== "import")
      .map(({ kind, source, loader, names }) => ({
        kind,
        source,
        loader,
        names,
      })),
    [
      { kind: "resolve", source: "m1", loader: "require.resolve", names: [] },
      { kind: "resolve", source: "m2", loader: "load.resolve", names: [] },
      {
        kind: "resolve",
        source: "m3",
        loader: "createRequire(…).resolve",
        names: [],
      },
    ]
  );
});

/** `code`에서 부른 이름마다 그 출처(`originOf`)를 `이름: 모듈 속성` 문자열로 모은다. 모듈에서 오지 않았으면 `이름: -`. */
function originsOf(code) {
  const origins = [];
  const linter = new Linter({ configType: "flat" });
  linter.verify(code, [
    {
      languageOptions: { parser: tseslint.parser, sourceType: "module" },
      plugins: {
        probe: {
          rules: {
            origins: {
              /** @param {import("eslint").Rule.RuleContext} context */
              create: (context) => ({
                "CallExpression > Identifier.callee"(node) {
                  const origin = originOf(
                    context.sourceCode.getScope(node),
                    node
                  );
                  origins.push(
                    `${node.name}: ${origin?.module ? `${origin.module} ${origin.path.join(".")}` : "-"}`
                  );
                },
              }),
            },
          },
        },
      },
      rules: { "probe/origins": "error" },
    },
  ]);
  return origins;
}

test("tells where a called name came from, whether imported, required or taken from a dynamic import", () => {
  assert.deepEqual(
    originsOf(
      [
        `import { createRequire } from "node:module";`,
        `import { a } from "m1";`,
        `import b from "m2";`,
        `const { c, d: e } = require("m3");`,
        `const load = createRequire(import.meta.url);`,
        `const { f } = load("m4");`,
        `const { g } = await import("m5");`,
        `const { h } = process.getBuiltinModule("m6");`,
        `const local = () => {};`,
        `a(); b(); c(); e(); f(); g(); h(); local();`,
      ].join("\n")
    ).filter(
      (line) =>
        !line.startsWith("createRequire") &&
        !line.startsWith("require") &&
        !line.startsWith("load:")
    ),
    [
      "a: m1 a",
      "b: m2 default",
      "c: m3 c",
      "e: m3 d",
      "f: m4 f",
      "g: m5 g",
      "h: m6 h",
      "local: -",
    ]
  );
});

// 불러오는 함수는 글자 이름이 아니라 출처로 알아본다(#266 리뷰 SPEC-2). 본보기는 @eslint-community/eslint-utils의 ReferenceTracker다:
// 가려지지 않은 전역에서 시작하고, 가져온 이름은 원래 이름으로, 별칭·구조 분해·속성 사슬을 따라간다.
test("finds createRequire by where it comes from: renamed, a namespace, a default, required or taken from getBuiltinModule", () => {
  const loads = [
    `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\nconst { a } = load("m1");\n`,
    `import * as nodeModule from "module";\nvoid nodeModule.createRequire(import.meta.url)("m2");\n`,
    `import nodeModule from "node:module";\nconst { createRequire: make } = nodeModule;\nvoid make(import.meta.url)("m3");\n`,
    `const { createRequire: make } = require("node:module");\nconst load = make(import.meta.url);\nvoid load.resolve("m4");\n`,
    `const make = process.getBuiltinModule("module").createRequire;\nvoid make(import.meta.url)("m5");\n`,
    `import { createRequire } from "node:module";\nconst make = createRequire;\nconst load = make(import.meta.url);\nvoid load("m6");\n`,
    `void globalThis.process.getBuiltinModule("m7");\n`,
    // node:module의 Module은 모듈 자신이라 Module.createRequire도 같은 함수다(#266 리뷰 SPEC-5).
    `import { Module } from "node:module";\nconst { createRequire: make } = Module;\nvoid make(import.meta.url)("m8");\n`,
  ];
  assert.deepEqual(
    loads.flatMap((code) =>
      sitesOf(code)
        .filter((site) => /^m\d$/.test(site.source))
        .map(({ kind, source }) => `${kind} ${source}`)
    ),
    [
      "require m1",
      "require m2",
      "require m3",
      "resolve m4",
      "require m5",
      "require m6",
      "require m7",
      "require m8",
    ]
  );
});

test("does not take a local function named like require, createRequire or getBuiltinModule as a loader", () => {
  const locals = [
    `const require = (name) => name;\nvoid require("m1");\n`,
    `function load(require) {\n  return require("m2");\n}\nvoid load;\n`,
    `const createRequire = () => (name) => name;\nvoid createRequire(import.meta.url)("m3");\n`,
    `const process = { getBuiltinModule: (name) => name };\nvoid process.getBuiltinModule("m4");\n`,
    `const tools = { createRequire: () => (name) => name };\nconst load = tools.createRequire(import.meta.url);\nvoid load("m5");\n`,
    `const Module = { createRequire: () => (name) => name };\nvoid Module.createRequire(import.meta.url)("m8");\n`,
    // 다시 대입한 전역·변수는 무엇을 담는지 따라가지 않는다.
    `require = (name) => name;\nvoid require("m6");\n`,
    `import { createRequire } from "node:module";\nlet load = createRequire(import.meta.url);\nload = (name) => name;\nvoid load("m7");\n`,
  ];
  assert.deepEqual(
    locals.flatMap((code) =>
      sitesOf(code)
        .filter((site) => site.kind !== "import")
        .map((site) => site.source)
    ),
    []
  );
});

// 다른 패키지의 입구는 Node가 푸는 대로 판정한다(scripts/package-exports.ts). exports 키만 보면 null로 막은 입구도 가져올 수 있는 것으로,
// 조건 객체·`*` 무늬 입구는 대상 파일이 없는 것으로 읽어, 막힌 입구를 쓰는 가져오기를 놓치고 무늬 입구를 쓰는 가져오기를 막는다
// (#286 항목 24와 같은 모양).
/** 임시 저장소에 둔 표본 workspace 패키지(packages/sample). 입구는 Node가 그 폴더에서 푼다. */
function samplePackage(context, exports) {
  const root = mkdtempSync(path.join(tmpdir(), "eslint-imports-package-"));
  context.after(() => removeFolder(root));
  const folder = "packages/sample";
  const manifest = { name: "@babojubot/sample", exports };
  mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(
    path.join(root, folder, "package.json"),
    JSON.stringify(manifest)
  );
  return workspacePackage(folder, manifest, root);
}

test("resolves a workspace package entry as Node does: blocked, conditional and wildcard entries", (context) => {
  const pkg = samplePackage(context, {
    ".": { types: "./src/index.d.ts", import: "./src/index.ts" },
    "./testing": null,
    "./fixtures/*": "./src/fixtures/*.ts",
    "./browser": { browser: "./src/browser.ts" },
  });
  assert.deepEqual(
    [".", "./testing", "./fixtures/lifeline", "./browser", "./gone"].map(
      (entry) => [entry, packageEntry(pkg, entry)]
    ),
    [
      [".", { exported: true, file: "packages/sample/src/index" }],
      ["./testing", { exported: false, file: undefined }],
      [
        "./fixtures/lifeline",
        { exported: true, file: "packages/sample/src/fixtures/lifeline" },
      ],
      ["./browser", { exported: false, file: undefined }],
      ["./gone", { exported: false, file: undefined }],
    ]
  );
});

// Node 자신의 해석기와 같아야 한다(#289 외부 리뷰 SPEC-1·2): `..`·`node_modules` 대상은 가져올 수 없고, 접두사가 같은 와일드카드는 더
// 긴 키가 이긴다(선언 순서와 무관).
test("resolves workspace package entries with Node's own resolver: invalid targets and wildcard key order", (context) => {
  for (const order of ["short first", "long first"]) {
    const wildcards =
      order === "short first"
        ? { "./a/*": "./src/a/*.ts", "./a/*.js": "./src/aj/*.ts" }
        : { "./a/*.js": "./src/aj/*.ts", "./a/*": "./src/a/*.ts" };
    const pkg = samplePackage(context, {
      ".": "./src/index.ts",
      "./up": "./../outside.ts",
      "./nm": "./node_modules/x.ts",
      ...wildcards,
    });
    assert.deepEqual(
      ["./up", "./nm", "./a/x.js"].map((entry) => [
        entry,
        packageEntry(pkg, entry),
      ]),
      [
        ["./up", { exported: false, file: undefined }],
        ["./nm", { exported: false, file: undefined }],
        ["./a/x.js", { exported: true, file: "packages/sample/src/aj/x" }],
      ],
      order
    );
  }
});
