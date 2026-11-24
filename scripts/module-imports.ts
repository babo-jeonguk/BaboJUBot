// 코드 파일이 가져오는 모듈 지정자를 읽는 한 곳. 검사 설정의 가져오기 닫힘(.agents/scripts/protected-files.ts)과 CI의 설치 확인
// (scripts/ci-test-gate.test.mjs)이 함께 쓴다. 가져오는 자리와 불러오는 함수(`require`·createRequire가 만든 함수·getBuiltinModule)는
// lint 규칙들과 같은 판정(scripts/eslint-imports.mjs의 importSites·loaderOf)으로 찾는다: 부르는 모양이 아니라 출처로(이름 있는
// 가져오기·별칭·구조 분해·globalThis 포함). 따라갈 수 없는 불러오기(글자가 아닌 import()·불러오는 함수의 글자 아닌 이름, CommonJS 규칙으로
// 푸는 require, node:module의 불러오는 이름, 불러오는 함수를 값으로 넘기기)는 "가져오는 것 없음"으로 접지 않고 던진다.
import path from "node:path";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import { importSites, loaderOf } from "./eslint-imports.mjs";
import { codeFormatNames } from "./test-files.mjs";

/** Formats Node reads as CommonJS (.cjs, and TypeScript's .cts that compiles to it): codeFormats' names that start with c. */
const commonJsFormats = new Set(
  codeFormatNames.filter((name) => name.startsWith("c"))
);
/** Formats that hold JSX: codeFormats' names that end with x. */
const jsxFormats = new Set(
  codeFormatNames.filter((name) => name.endsWith("x"))
);

const moduleLoader = new Set(["module", "node:module"]);
/** What node:module exports that loads no module (https://nodejs.org/api/module.html). Its other exports can load one. */
const loadsNothing = new Set(["builtinModules", "isBuiltin"]);

type Node = Rule.Node;

/** The `key` property of a syntax node, or undefined. */
const field = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null && Object.hasOwn(node, key)
    ? Object.getOwnPropertyDescriptor(node, key)?.value
    : undefined;

/** Where a syntax node starts and how long it is. */
const rangeOf = (node: unknown) => {
  const range = field(node, "range");
  return Array.isArray(range) &&
    typeof range[0] === "number" &&
    typeof range[1] === "number"
    ? { at: range[0], length: range[1] - range[0] }
    : { at: 0, length: 0 };
};

/** Is `node` the string literal a load names. */
const literal = (node: unknown) =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  node.type === "Literal" &&
  "value" in node &&
  typeof node.value === "string";

/**
 * The module specifiers a code file imports: static imports and re-exports, TypeScript's import x = require("..."),
 * import() with a literal, and the built-in modules getBuiltinModule loads. A load it cannot follow throws rather than
 * drop out of the closure: import() or a loader called with a name that is not a string literal, require and the
 * functions createRequire makes (they resolve by CommonJS rules this check does not apply), node:module taken for
 * anything but the names that load nothing (createRequire, Module, register load modules), and a loader handed on as a
 * value.
 */
export function importedSpecifiers(file: string, text: string): string[] {
  const found: string[] = [];
  /** What cannot be followed, with where it is: the earliest and innermost place is told first. */
  const refusals: { at: number; length: number; why: string }[] = [];
  const collect: Rule.RuleModule = {
    create(context) {
      const scopeOf = (node: Node) => context.sourceCode.getScope(node);
      const refuseAt = (node: unknown, why: string) =>
        refusals.push({ ...rangeOf(node), why });
      const sites = importSites(context, (site) => {
        const refuse = (why: string) => refuseAt(site.node, why);
        if (site.kind === "resolve") return;
        if (moduleLoader.has(site.source)) {
          if (site.loader === "getBuiltinModule")
            return refuse(
              `loads "${site.source}" through getBuiltinModule, which can load a module by rules this check does not follow`
            );
          const loader = site.names.find(
            (name) =>
              !name.typeOnly &&
              !site.typeOnly &&
              !loadsNothing.has(name.imported)
          );
          if (loader !== undefined)
            return refuse(
              loader.imported === "*"
                ? `takes the whole module from "${site.source}", which can load a module by rules this check does not follow`
                : `takes "${loader.imported}" from "${site.source}", which can load a module by rules this check does not follow`
            );
        }
        if (
          site.kind === "require" &&
          site.loader !== "getBuiltinModule" &&
          site.loader !== "import ="
        )
          return refuse(
            site.loader === "require"
              ? "calls require, which this check does not follow"
              : `loads "${site.source}" through ${site.loader}, which resolves by CommonJS rules this check does not follow`
          );
        found.push(site.source);
      }) as Rule.RuleListener;
      /** A loader may be called, aliased (a variable's initial value) or asked for `.resolve`; anything else hands it on. */
      const handsOn = (node: Node) => {
        const parent = field(node, "parent");
        const type = field(parent, "type");
        if (type === "CallExpression" && field(parent, "callee") === node)
          return false;
        if (type === "VariableDeclarator" && field(parent, "init") === node)
          return field(field(parent, "id"), "type") !== "Identifier";
        const property = field(parent, "property");
        if (
          type === "MemberExpression" &&
          field(parent, "object") === node &&
          field(parent, "computed") === false &&
          field(property, "type") === "Identifier" &&
          field(property, "name") === "resolve"
        )
          return false;
        return true;
      };
      const checkValue = (node: Node) => {
        // Declaration places (patterns, import specifiers) and property names are not values.
        const parent = field(node, "parent");
        const type = field(parent, "type");
        if (
          node.type === "Identifier" &&
          ((type === "MemberExpression" &&
            field(parent, "property") === node &&
            field(parent, "computed") === false) ||
            (type === "Property" &&
              field(field(parent, "parent"), "type") === "ObjectPattern") ||
            (type === "VariableDeclarator" && field(parent, "id") === node) ||
            (typeof type === "string" && type.startsWith("Import")))
        )
          return;
        const loader: unknown = loaderOf(scopeOf(node), node);
        if (loader === undefined || !handsOn(node)) return;
        refuseAt(
          node,
          `hands on a module loader (${context.sourceCode.getText(node)}) as a value, which this check cannot follow`
        );
      };
      return {
        ...sites,
        ImportExpression(node) {
          sites.ImportExpression?.(node);
          if (!literal(node.source))
            refuseAt(
              node,
              "loads a module through import() with a name that is not a string literal, which this check does not follow"
            );
        },
        CallExpression(node: Node & { type: "CallExpression" }) {
          sites.CallExpression?.(node);
          const loader: unknown = loaderOf(scopeOf(node), node.callee);
          if (typeof loader === "string" && !literal(node.arguments[0]))
            refuseAt(
              node,
              `calls ${loader} with a name that is not a string literal, which this check does not follow`
            );
          checkValue(node);
        },
        Identifier: checkValue,
        MemberExpression: checkValue,
      };
    },
  };
  const format = path.extname(file).slice(1);
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    text,
    [
      {
        // A pattern that ends in `*` alone does not make ESLint lint a file; name the code formats.
        files: [`**/*.{${codeFormatNames.join(",")}}`],
        languageOptions: {
          parser: tseslint.parser,
          ecmaVersion: "latest",
          sourceType: commonJsFormats.has(format) ? "commonjs" : "module",
          parserOptions: { ecmaFeatures: { jsx: jsxFormats.has(format) } },
        },
        plugins: { imports: { rules: { collect } } },
        rules: { "imports/collect": "error" },
      },
    ],
    file
  );
  // The rule reports nothing, so any message (a parse error, no matching configuration) means the file was not read.
  const [unread] = messages;
  if (unread) throw new Error(`${file} was not read: ${unread.message}`);
  const [first] = refusals.sort((a, b) => a.at - b.at || a.length - b.length);
  if (first)
    throw new Error(
      `${file} ${first.why}; load a repository file with import and a string literal so its target can be followed (scripts/module-imports.ts)`
    );
  return found;
}
