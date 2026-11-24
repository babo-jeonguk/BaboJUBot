// 코드 파일이 가져오는 모듈 지정자를 구문 트리로 읽는 한 곳. 검사 설정의 가져오기 닫힘(.agents/scripts/protected-files.ts)과 CI의 설치
// 확인(scripts/ci-test-gate.test.mjs)이 함께 쓴다. 따라갈 수 없는 불러오기(글자가 아닌 import(), require, node:module의 불러오기)는
// "가져오는 것 없음"으로 접지 않고 던진다.
import ts from "typescript";

const moduleLoader = new Set(["module", "node:module"]);
/** What node:module exports that loads no module (https://nodejs.org/api/module.html). Its other exports can load one. */
const loadsNothing = new Set(["builtinModules", "isBuiltin"]);

/**
 * The module specifiers a code file imports: static imports and re-exports, TypeScript's import x = require("..."), and
 * import() with a literal. A load it cannot follow throws rather than drop out of the closure: import() with a computed
 * name, CommonJS require, and node:module's loaders (createRequire, Module, register: any import of it but the names that
 * load nothing, or the module reached with getBuiltinModule), which resolve by rules this check does not apply.
 */
export function importedSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const refuse = (why: string) =>
    new Error(
      `${file} ${why}; load a repository file with import and a string literal so its target can be followed (scripts/module-imports.ts)`
    );
  const wholeLoader = (specifier: string) =>
    refuse(
      `takes the whole module from "${specifier}", which can load a module by rules this check does not follow`
    );
  /** The names an import or re-export of node:module takes, or undefined when it takes the whole module. */
  const takenNames = (node: ts.ImportDeclaration | ts.ExportDeclaration) => {
    if (ts.isExportDeclaration(node))
      return node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map(
            (element) => (element.propertyName ?? element.name).text
          )
        : undefined;
    const clause = node.importClause;
    if (!clause || clause.phaseModifier === ts.SyntaxKind.TypeKeyword)
      return [];
    if (clause.name) return undefined;
    const bindings = clause.namedBindings;
    if (!bindings) return [];
    if (ts.isNamespaceImport(bindings)) return undefined;
    return bindings.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text);
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (moduleLoader.has(specifier)) {
        const taken = takenNames(node);
        if (taken === undefined) throw wholeLoader(specifier);
        const loader = taken.find((name) => !loadsNothing.has(name));
        if (loader !== undefined)
          throw refuse(
            `takes "${loader}" from "${specifier}", which can load a module by rules this check does not follow`
          );
      }
      found.push(specifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const specifier = node.moduleReference.expression.text;
      if (moduleLoader.has(specifier)) throw wholeLoader(specifier);
      found.push(specifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [name] = node.arguments;
      if (!name || !ts.isStringLiteralLike(name))
        throw refuse(
          "loads a module through import() with a name that is not a string literal, which this check does not follow"
        );
      if (moduleLoader.has(name.text)) throw wholeLoader(name.text);
      found.push(name.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    )
      throw refuse("calls require, which this check does not follow");
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "getBuiltinModule"
    ) {
      const [name] = node.arguments;
      if (!name || !ts.isStringLiteralLike(name))
        throw refuse(
          "calls getBuiltinModule with a name that is not a string literal, which this check does not follow"
        );
      if (moduleLoader.has(name.text))
        throw refuse(
          `loads "${name.text}" through getBuiltinModule, which can load a module by rules this check does not follow`
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
