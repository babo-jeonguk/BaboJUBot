// 가져오는 자리를 모으는 공용 판정(scripts/eslint-imports.mjs)이 모든 가져오기 모양에서 경로·종류·이름을 내는지 본다(#266 리뷰 SPEC-1).
// 가져오기를 보는 저장소 규칙은 모두 이 판정을 쓰므로, 여기서 한 모양을 놓치면 모든 규칙이 함께 놓친다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { importOfBinding, importSites } from "./eslint-imports.mjs";

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
              create: () =>
                importSites((site) =>
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

/** `code`에서 부른 이름마다 그 출처(`importOfBinding`)를 `이름: 출처 원래이름` 문자열로 모은다. 출처가 없으면 `이름: -`. */
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
              create: (context) => ({
                "CallExpression > Identifier.callee"(node) {
                  const variable = context.sourceCode
                    .getScope(node)
                    .references.find(
                      (ref) => ref.identifier === node
                    )?.resolved;
                  const origin = importOfBinding(variable);
                  origins.push(
                    `${node.name}: ${origin ? `${origin.source} ${origin.imported}` : "-"}`
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
