// 파일이 다른 모듈을 가져오는 자리를 한곳에서 판정한다(#266 리뷰 SPEC-1). 가져오기 경로나 가져온 이름을 보는 저장소 lint 규칙은
// 모두 이 판정을 쓴다. 규칙마다 "무엇을 가져오기로 볼지"를 따로 짜면 한 규칙은 require를 보고 다른 규칙은 못 보는 식으로 범위가 어긋난다.
//
// 본보기는 eslint-plugin-import(import-x)의 module visitor다. 그 플러그인의 가져오기 규칙은 모두 visitor 하나를 함께 쓰고, visitor는
// `import`·`export … from`·문자열 `import()`·TS `import x = require()`·`require("…")`(옵션)를 같은 콜백으로 넘긴다
// (https://github.com/un-ts/eslint-plugin-import-x/blob/master/src/utils/module-visitor.ts). 여기서는 같은 자리에 더해
// 이 저장소가 쓰는 길을 본다: `createRequire(…)`·`module.createRequire(…)`가 만든 함수(어떤 이름에 담아도), `.resolve("…")`,
// `process.getBuiltinModule("…")`. 그리고 규칙들이 가져온 이름(그룹 끄기 함수, 실행 함수, 시험의 출처)을 봐야 해서 이름도 함께 넘긴다.
// AMD(`define`)는 이 저장소에 없어 보지 않는다. 계산한 경로는 무엇을 가져오는지 알 수 없어 보지 않는다.
//
// 불러오는 함수(`require`·`createRequire`가 만든 함수·`getBuiltinModule`)는 글자 이름이 아니라 출처로 알아본다(#266 리뷰 SPEC-2).
// 본보기는 @eslint-community/eslint-utils의 ReferenceTracker다(https://github.com/eslint-community/eslint-utils/blob/main/src/reference-tracker.mjs):
// 가려지지 않은 전역에서 시작하고, 가져온 이름은 원래 이름으로 보고, 변수 별칭·구조 분해·속성 사슬을 따라간다. 그 도구는
// createRequire가 만든 함수와 dynamic import를 따라가지 않아(eslint-plugin-n도 getBuiltinModule을 따로 본다) 같은 설계를 여기 둔다.
// 가져오는 경로는 대상(패키지·exports 입구·파일)으로 풀어 판정할 수 있게 `targetOf`를 둔다(#266 리뷰 SPEC-3). 본보기는 import-x
// no-restricted-paths가 경로 철자가 아니라 풀린 대상 파일로 판정하는 방식이다.
import { builtinModules } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

const builtins = new Set(builtinModules);
/** Node 기본 모듈 이름은 `node:`를 떼어 한 철자로 본다. `node:test`처럼 접두사로만 있는 모듈은 그대로 둔다. */
const moduleName = (source) =>
  source.startsWith("node:") && builtins.has(source.slice(5))
    ? source.slice(5)
    : source;
/** 전역 객체(`globalThis`·`global`)를 거쳐 읽은 전역은 그 전역 자체로 본다. */
const globalObjects = new Set(["globalThis", "global"]);

/** 이 scope에서 위로 올라가며 이름이 가리키는 변수. */
function variableIn(scope, name) {
  for (let at = scope; at; at = at.upper) {
    const variable = at.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

/** 구조 분해 `pattern`에서 `target` 이름 노드에 이르는 속성 이름들. 찾지 못하면 `undefined`. */
function patternPath(pattern, target) {
  if (pattern === target) return [];
  if (pattern?.type === "AssignmentPattern")
    return patternPath(pattern.left, target);
  if (pattern?.type !== "ObjectPattern") return undefined;
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const key = propertyName({
      computed: property.computed,
      property: property.key,
    });
    const rest = patternPath(property.value, target);
    if (rest !== undefined && key !== undefined) return [key, ...rest];
  }
  return undefined;
}

/** 출처에 속성 하나를 더한다. 기본 모듈의 기본 가져오기(`default`)는 모듈 객체 자체이고, 전역 객체를 거친 전역은 그 전역이다. */
function extend(origin, name) {
  if (
    origin.global &&
    origin.path.length === 0 &&
    globalObjects.has(origin.global)
  )
    return { global: name, path: [] };
  if (
    origin.module &&
    origin.path.length === 0 &&
    name === "default" &&
    builtins.has(origin.module)
  )
    return origin;
  return { ...origin, path: [...origin.path, name] };
}

const same = (origin, expected) =>
  origin !== undefined &&
  origin.global === expected.global &&
  origin.module === expected.module &&
  origin.path.length === expected.path.length &&
  origin.path.every((name, i) => name === expected.path[i]);

/** createRequire가 만든 불러오는 함수의 출처. */
const madeRequire = { module: "module", path: ["createRequire()"] };

/**
 * 식이 어디서 왔는가. 가져온 모듈에서 왔으면 `{ module, path }`(모듈 이름은 `node:`를 뗌), 가려지지 않은 전역에서 왔으면
 * `{ global, path }`, 알 수 없으면(지역 값, 매개변수, 계산한 이름) `undefined`. `scope`는 `node`가 있는 자리의 scope다.
 */
export function originOf(scope, node, depth = 0) {
  if (!node || depth > 30) return undefined;
  switch (node.type) {
    case "ChainExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
      return originOf(scope, node.expression, depth + 1);
    case "AwaitExpression":
      return originOf(scope, node.argument, depth + 1);
    case "ImportExpression":
      return literalPath(node.source)
        ? { module: moduleName(node.source.value), path: [] }
        : undefined;
    case "MemberExpression": {
      const name = propertyName(node);
      const base = originOf(scope, node.object, depth + 1);
      return name === undefined || !base ? undefined : extend(base, name);
    }
    case "CallExpression": {
      const loaded = loadOf(scope, node, depth + 1);
      if (loaded) return { module: moduleName(loaded.source), path: [] };
      // createRequire(…)는 불러오는 함수를 만든다.
      return same(originOf(scope, node.callee, depth + 1), {
        module: "module",
        path: ["createRequire"],
      })
        ? madeRequire
        : undefined;
    }
    case "Identifier": {
      const variable = variableIn(scope, node.name);
      if (!variable) {
        // 선언 없는 전역. 어디서든 대입했으면 무엇을 담는지 따라가지 않는다.
        let global = scope;
        while (global.upper) global = global.upper;
        const written = global.through.some(
          (ref) => ref.identifier.name === node.name && ref.isWrite()
        );
        return written ? undefined : { global: node.name, path: [] };
      }
      return originOfVariable(variable, node.name, depth + 1);
    }
    default:
      return undefined;
  }
}

/** 변수가 어디서 왔는가(`originOf`와 같은 판정). 정의가 없는 전역 이름이면 전역, 다시 대입한 변수는 알 수 없다. */
function originOfVariable(variable, name, depth = 0) {
  if (
    !variable ||
    (variable.scope.type === "global" && variable.defs.length === 0)
  ) {
    const written = variable?.references.some((ref) => ref.isWrite());
    return written ? undefined : { global: name, path: [] };
  }
  const def = variable.defs[0];
  if (def.type === "ImportBinding") {
    const specifier = def.node;
    if (specifier.type === "TSImportEqualsDeclaration") {
      const reference = specifier.moduleReference;
      return reference.type === "TSExternalModuleReference" &&
        literalPath(reference.expression)
        ? { module: moduleName(reference.expression.value), path: [] }
        : undefined;
    }
    const module = { module: moduleName(def.parent.source.value), path: [] };
    if (specifier.type === "ImportNamespaceSpecifier") return module;
    return extend(
      module,
      specifier.type === "ImportDefaultSpecifier"
        ? "default"
        : (specifier.imported.name ?? specifier.imported.value)
    );
  }
  if (def.type !== "Variable" || !def.node.init) return undefined;
  // 처음 값 말고 다시 대입하면 무엇을 담는지 따라가지 않는다.
  if (variable.references.filter((ref) => ref.isWrite()).length > 1)
    return undefined;
  const keys = patternPath(def.node.id, def.name);
  if (keys === undefined) return undefined;
  let origin = originOf(variable.scope, def.node.init, depth + 1);
  for (const key of keys) origin = origin && extend(origin, key);
  return origin;
}

/** 부른 함수가 불러오는 함수면 그 이름(메시지용): `require`, createRequire가 만든 함수를 담은 이름·`createRequire(…)`, `getBuiltinModule`. */
function loaderOf(scope, callee, depth = 0) {
  const origin = originOf(scope, callee, depth);
  if (same(origin, { global: "require", path: [] })) return "require";
  if (same(origin, madeRequire))
    return callee.type === "Identifier" ? callee.name : "createRequire(…)";
  if (
    same(origin, { global: "process", path: ["getBuiltinModule"] }) ||
    same(origin, { module: "process", path: ["getBuiltinModule"] })
  )
    return "getBuiltinModule";
  return undefined;
}

/** 호출이 모듈을 불러오면 그 경로와 방법, 아니면 `undefined`. */
function loadOf(scope, call, depth = 0) {
  const [first] = call.arguments;
  if (!literalPath(first)) return undefined;
  const loader = loaderOf(scope, call.callee, depth);
  return loader === undefined ? undefined : { source: first.value, loader };
}

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
 * 가져오는 자리마다 `onSite(site)`를 부르는 visitor. 규칙은 자기 visitor와 `combineVisitors`로 합친다. `context`는 규칙의 문맥이다
 * (불러오는 함수의 출처를 그 자리의 scope에서 찾는다).
 * @param {(site: ImportSite) => void} onSite
 */
export function importSites(context, onSite) {
  const scopeOf = (node) => context.sourceCode.getScope(node);
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
    CallExpression(node) {
      const [first] = node.arguments;
      if (!literalPath(first)) return;
      const { callee } = node;
      const scope = scopeOf(node);
      const loaded = loadOf(scope, node);
      if (loaded)
        return onSite({
          node,
          source: first.value,
          sourceNode: first,
          kind: "require",
          loader: loaded.loader,
          typeOnly: false,
          names: namesOfValue(node),
        });
      if (
        callee.type === "MemberExpression" &&
        propertyName(callee) === "resolve"
      ) {
        const base = loaderOf(scope, callee.object);
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

/**
 * 변수가 가져온 값이면 그 출처(`{ source, imported }`), 아니면 `undefined`. `imported`는 가져온 이름이고 기본 가져오기는 `default`,
 * 모듈 객체는 `*`다. 모듈 이름은 `node:`를 뗀 철자다. 정적 import와 같게 `require`·createRequire가 만든 함수·`getBuiltinModule`·
 * `await import(…)`의 결과를 구조 분해하거나 담은 변수, 그 별칭도 본다(`originOf`와 같은 판정).
 */
export function importOfBinding(variable) {
  if (!variable) return undefined;
  const origin = originOfVariable(variable, variable.name);
  if (!origin?.module) return undefined;
  return { source: origin.module, imported: origin.path[0] ?? "*" };
}

/** 저장소 뿌리. */
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const withoutExtension = (file) =>
  file.replace(/\.(ts|tsx|mts|mjs|js|cjs)$/, "");

/**
 * 저장소의 workspace 패키지(apps·packages 아래 package.json): 폴더, 이름, 내보낸 입구(`exports`의 키)와 그 입구가 가리키는 파일
 * (확장자를 뗀 저장소 기준 경로).
 */
export const workspacePackages = ["apps", "packages"].flatMap((group) =>
  readdirSync(path.join(repositoryRoot, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const folder = `${group}/${entry.name}`;
      const manifest = path.join(repositoryRoot, folder, "package.json");
      if (!existsSync(manifest)) return [];
      const { name, exports = {} } = JSON.parse(readFileSync(manifest, "utf8"));
      const files = Object.fromEntries(
        Object.entries(exports).flatMap(([entry, target]) =>
          typeof target === "string"
            ? [[entry, withoutExtension(path.posix.join(folder, target))]]
            : []
        )
      );
      return [{ folder, name, entries: Object.keys(exports), files }];
    })
);

/** 저장소 기준 경로(`/` 구분). */
export const repositoryPath = (filename) =>
  path.relative(repositoryRoot, filename).replaceAll("\\", "/");

/**
 * 가져오는 경로가 가리키는 대상(#266 리뷰 SPEC-3). 같은 대상을 상대 경로·자기 패키지 이름·확장자 없는 철자로 적어도 같은 답이다.
 * - `package`: 대상이 든 workspace 패키지(없으면 저장소 밖).
 * - `entry`: 패키지 이름으로 적었으면 그 하위 경로(`.`·`./recovery`), 상대 경로면 그 파일을 내보내는 입구(없으면 `undefined`).
 * - `exported`: 패키지 이름으로 적은 하위 경로가 exports에 있는가.
 * - `file`: 대상 파일(확장자를 뗀 저장소 기준 경로). 패키지 이름으로 적었는데 exports에 없으면 `undefined`.
 * - `relative`: 상대 경로로 적었는가.
 * workspace 패키지가 아닌 이름(저장소 밖 라이브러리, Node 기본 모듈)은 `undefined`다.
 */
export function targetOf(filename, source) {
  if (typeof source !== "string") return undefined;
  if (source.startsWith(".")) {
    const file = withoutExtension(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(repositoryPath(filename)), source)
      )
    );
    const pkg = workspacePackages.find((each) =>
      file.startsWith(`${each.folder}/`)
    );
    const entry = pkg
      ? Object.keys(pkg.files).find((key) => pkg.files[key] === file)
      : undefined;
    return {
      package: pkg,
      entry,
      exported: entry !== undefined,
      file,
      relative: true,
    };
  }
  const pkg = workspacePackages.find(
    (each) => source === each.name || source.startsWith(`${each.name}/`)
  );
  if (!pkg) return undefined;
  const entry = source === pkg.name ? "." : `.${source.slice(pkg.name.length)}`;
  const exported = pkg.entries.includes(entry);
  return {
    package: pkg,
    entry,
    exported,
    file: exported ? pkg.files[entry] : undefined,
    relative: false,
  };
}
