// 파일이 다른 모듈을 가져오는 자리를 한곳에서 판정한다(#266 리뷰 SPEC-1). 가져오기 경로나 가져온 이름을 보는 저장소 lint 규칙은
// 모두 이 판정을 쓴다. 규칙마다 "무엇을 가져오기로 볼지"를 따로 짜면 한 규칙은 require를 보고 다른 규칙은 못 보는 식으로 범위가 어긋난다.
//
// 본보기는 eslint-plugin-import(import-x)의 module visitor다. 그 플러그인의 가져오기 규칙은 모두 visitor 하나를 함께 쓰고, visitor는
// `import`·`export … from`·문자열 `import()`·TS `import x = require()`·`require("…")`(옵션)를 같은 콜백으로 넘긴다
// (https://github.com/un-ts/eslint-plugin-import-x/blob/master/src/utils/module-visitor.ts). 여기서는 같은 자리에 더해
// 이 저장소가 쓰는 길을 본다: `createRequire(…)`·`module.createRequire(…)`가 만든 함수(어떤 이름에 담아도), `.resolve("…")`,
// `process.getBuiltinModule("…")`. 그리고 규칙들이 가져온 이름(그룹 끄기 함수, 실행 함수, 시험의 출처)을 봐야 해서 이름도 함께 넘긴다.
// AMD(`define`)는 이 저장소에 없어 보지 않는다. 계산한 경로는 무엇을 가져오는지 알 수 없어 보지 않는다.

/**
 * 가져오는 자리 하나.
 * - `kind`: `import`(정적 가져오기), `export`(다시 내보내기), `dynamic`(문자열 `import()`), `require`(`require`·createRequire가 만든
 *   함수·`getBuiltinModule`·TS `import x = require()`로 불러오기), `resolve`(`.resolve("…")`로 경로만 찾기).
 * - `names`: 가져오거나 다시 내보낸 이름. `imported`는 원래 이름이고 기본 가져오기는 `default`, 모듈 객체를 통째로 받으면 `*`다.
 *   `local`은 이 파일에서 그 값을 담은 이름(없으면 비움), `typeOnly`는 그 이름만 타입으로 가져왔는지다. `resolve`는 이름이 없다.
 * - `loader`: 메시지에 쓰는 가져오는 방법(`import`, `require`, `createRequire(…)`, 담은 이름, `getBuiltinModule`, `import =`).
 * @typedef {{ node: object, source: string, sourceNode: object, kind: string, loader: string, typeOnly: boolean,
 *   names: Array<{ imported: string, local?: string, node: object, typeOnly?: boolean }> }} ImportSite
 */

/** 문자열 그대로 적은 경로인가. */
const literalPath = (node) =>
  node?.type === "Literal" && typeof node.value === "string";

/** 속성 이름. 계산한 이름이면 `undefined`, 문자열 그대로면 그 값. */
function propertyName(member) {
  if (!member.computed) return member.property.name;
  return member.property.type === "Literal"
    ? String(member.property.value)
    : undefined;
}

/** `createRequire(…)` 또는 `x.createRequire(…)` 호출인가. */
export function isCreateRequire(node) {
  if (node?.type !== "CallExpression") return false;
  const { callee } = node;
  return callee.type === "Identifier"
    ? callee.name === "createRequire"
    : callee.type === "MemberExpression" &&
        propertyName(callee) === "createRequire";
}

/** `getBuiltinModule` 또는 `x.getBuiltinModule`인가. */
const isBuiltinLoader = (callee) =>
  callee.type === "Identifier"
    ? callee.name === "getBuiltinModule"
    : callee.type === "MemberExpression" &&
      propertyName(callee) === "getBuiltinModule";

/**
 * 모듈 값을 만드는 식(`require(…)`·`await import(…)` 등)에서 꺼낸 이름. 구조 분해면 그 이름들, 이름 하나에 담으면 `*`,
 * 속성을 바로 읽으면 그 속성, 그 밖에는 통째로 쓴 것으로 `*`(담은 이름 없음)다.
 */
function namesOfValue(value) {
  let at = value;
  if (at.parent?.type === "AwaitExpression") at = at.parent;
  const parent = at.parent;
  if (parent?.type === "VariableDeclarator" && parent.init === at) {
    if (parent.id.type === "Identifier")
      return [{ imported: "*", local: parent.id.name, node: parent.id }];
    if (parent.id.type === "ObjectPattern")
      return parent.id.properties.flatMap((property) => {
        if (property.type !== "Property") return [];
        const imported = propertyName({
          computed: property.computed,
          property: property.key,
        });
        if (imported === undefined) return [];
        const target =
          property.value.type === "AssignmentPattern"
            ? property.value.left
            : property.value;
        return [
          {
            imported,
            local: target.type === "Identifier" ? target.name : undefined,
            node: property,
          },
        ];
      });
    return [];
  }
  if (parent?.type === "MemberExpression" && parent.object === at) {
    const imported = propertyName(parent);
    return [{ imported: imported ?? "*", node: parent }];
  }
  return [{ imported: "*", node: at }];
}

/** import·export 선언의 지정자에서 꺼낸 이름. */
function specifierNames(node) {
  return node.specifiers.map((specifier) => {
    const typeOnly =
      specifier.importKind === "type" || specifier.exportKind === "type";
    if (specifier.type === "ImportDefaultSpecifier")
      return {
        imported: "default",
        local: specifier.local.name,
        node: specifier,
        typeOnly,
      };
    if (specifier.type === "ImportNamespaceSpecifier")
      return {
        imported: "*",
        local: specifier.local.name,
        node: specifier,
        typeOnly,
      };
    if (specifier.type === "ImportSpecifier")
      return {
        imported: specifier.imported.name ?? specifier.imported.value,
        local: specifier.local.name,
        node: specifier,
        typeOnly,
      };
    // ExportSpecifier: local은 가져오는 모듈 안의 이름, exported는 이 파일이 내보내는 이름이다.
    return {
      imported: specifier.local.name ?? specifier.local.value,
      local: specifier.exported.name ?? specifier.exported.value,
      node: specifier,
      typeOnly,
    };
  });
}

/**
 * 가져오는 자리마다 `onSite(site)`를 부르는 visitor. 규칙은 자기 visitor와 `combineVisitors`로 합친다.
 * @param {(site: ImportSite) => void} onSite
 */
export function importSites(onSite) {
  /** createRequire가 만든 함수를 담은 이름. 전역 `require`도 같은 함수로 본다. */
  const loaders = new Set(["require"]);
  const loaderOf = (callee) => {
    if (callee.type === "Identifier" && loaders.has(callee.name))
      return callee.name;
    if (isCreateRequire(callee)) return "createRequire(…)";
    if (isBuiltinLoader(callee)) return "getBuiltinModule";
    return undefined;
  };
  return {
    ImportDeclaration(node) {
      const names = specifierNames(node);
      onSite({
        node,
        source: node.source.value,
        sourceNode: node.source,
        kind: "import",
        loader: "import",
        typeOnly:
          node.importKind === "type" ||
          (names.length > 0 &&
            node.specifiers.every((each) => each.importKind === "type")),
        names,
      });
    },
    ExportNamedDeclaration(node) {
      if (!node.source) return;
      const names = specifierNames(node);
      onSite({
        node,
        source: node.source.value,
        sourceNode: node.source,
        kind: "export",
        loader: "export",
        typeOnly:
          node.exportKind === "type" ||
          (names.length > 0 &&
            node.specifiers.every((each) => each.exportKind === "type")),
        names,
      });
    },
    ExportAllDeclaration(node) {
      onSite({
        node,
        source: node.source.value,
        sourceNode: node.source,
        kind: "export",
        loader: "export",
        typeOnly: node.exportKind === "type",
        names: [
          {
            imported: "*",
            local: node.exported
              ? (node.exported.name ?? node.exported.value)
              : undefined,
            node,
          },
        ],
      });
    },
    ImportExpression(node) {
      if (!literalPath(node.source)) return;
      onSite({
        node,
        source: node.source.value,
        sourceNode: node.source,
        kind: "dynamic",
        loader: "import()",
        typeOnly: false,
        names: namesOfValue(node),
      });
    },
    TSImportEqualsDeclaration(node) {
      const reference = node.moduleReference;
      if (
        reference.type !== "TSExternalModuleReference" ||
        !literalPath(reference.expression)
      )
        return;
      onSite({
        node,
        source: reference.expression.value,
        sourceNode: reference.expression,
        kind: "require",
        loader: "import =",
        typeOnly: node.importKind === "type",
        names: [{ imported: "*", local: node.id.name, node: node.id }],
      });
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && isCreateRequire(node.init))
        loaders.add(node.id.name);
    },
    CallExpression(node) {
      const [first] = node.arguments;
      if (!literalPath(first)) return;
      const { callee } = node;
      const loader = loaderOf(callee);
      if (loader !== undefined)
        return onSite({
          node,
          source: first.value,
          sourceNode: first,
          kind: "require",
          loader,
          typeOnly: false,
          names: namesOfValue(node),
        });
      if (
        callee.type === "MemberExpression" &&
        propertyName(callee) === "resolve"
      ) {
        const base = loaderOf(callee.object);
        if (base !== undefined && base !== "getBuiltinModule")
          onSite({
            node,
            source: first.value,
            sourceNode: first,
            kind: "resolve",
            loader: `${base}.resolve`,
            typeOnly: false,
            names: [],
          });
      }
    },
  };
}

/** visitor 여럿을 하나로 합친다. 같은 노드 종류는 차례로 모두 부른다. */
export function combineVisitors(...visitors) {
  const combined = {};
  for (const visitor of visitors)
    for (const [key, handler] of Object.entries(visitor)) {
      const before = combined[key];
      combined[key] = before
        ? (node) => {
            before(node);
            handler(node);
          }
        : handler;
    }
  return combined;
}

/** 이름이 가리키는 변수(`scope`에서 위로 찾아 올라감). */
function variableNamed(scope, name) {
  for (let at = scope; at; at = at.upper) {
    const variable = at.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

/** 불러오기 호출이 createRequire가 만든 함수를 담은 이름으로 부른 것인가(변수의 정의를 본다). */
function isLoaderVariable(scope, callee) {
  if (callee.type !== "Identifier") return false;
  if (callee.name === "require") return true;
  const variable = variableNamed(scope, callee.name);
  const init = variable?.defs[0]?.node?.init;
  return isCreateRequire(init);
}

/**
 * 변수가 가져온 값이면 그 출처(`{ source, imported }`), 아니면 `undefined`. `imported`는 가져온 이름이고 기본 가져오기는 `default`,
 * 모듈 객체는 `*`다. 정적 import와 같게 `require`·createRequire가 만든 함수·`getBuiltinModule`·`await import(…)`의 결과를
 * 구조 분해하거나 담은 변수도 본다(`importSites`와 같은 판정).
 */
export function importOfBinding(variable) {
  const def = variable?.defs[0];
  if (!def) return undefined;
  if (def.type === "ImportBinding") {
    const specifier = def.node;
    if (specifier.type === "TSImportEqualsDeclaration") {
      const reference = specifier.moduleReference;
      return reference.type === "TSExternalModuleReference" &&
        literalPath(reference.expression)
        ? { source: reference.expression.value, imported: "*" }
        : undefined;
    }
    const imported =
      specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : specifier.type === "ImportNamespaceSpecifier"
          ? "*"
          : (specifier.imported.name ?? specifier.imported.value);
    return { source: def.parent.source.value, imported };
  }
  if (def.type !== "Variable") return undefined;
  let init = def.node.init;
  if (init?.type === "AwaitExpression") init = init.argument;
  let source;
  if (init?.type === "ImportExpression" && literalPath(init.source))
    source = init.source.value;
  else if (
    init?.type === "CallExpression" &&
    literalPath(init.arguments[0]) &&
    (isLoaderVariable(variable.scope, init.callee) ||
      isCreateRequire(init.callee) ||
      isBuiltinLoader(init.callee))
  )
    source = init.arguments[0].value;
  if (source === undefined) return undefined;
  if (def.node.id.type === "Identifier") return { source, imported: "*" };
  const property = def.node.id.properties?.find(
    (each) =>
      each.type === "Property" &&
      (each.value === def.name ||
        (each.value.type === "AssignmentPattern" &&
          each.value.left === def.name))
  );
  const imported =
    property &&
    propertyName({ computed: property.computed, property: property.key });
  return imported === undefined ? undefined : { source, imported };
}
