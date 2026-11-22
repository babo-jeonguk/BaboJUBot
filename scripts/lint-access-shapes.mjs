// 출처로 판정하는 lint 규칙의 시험에 쓰는 접근 모양 생성기(#266 리뷰 SPEC-8·9·10). 규칙 시험이 잘못된(또는 받는) 사례 하나를 정식 이름으로
// 주면, 같은 값에 닿는 다른 접근 모양으로 바꾼 사례와 같은 이름의 지역 값으로 바꾼 사례를 만든다. 규칙은 접근 모양이 달라도 같은 판정을,
// 같은 이름의 지역 값에는 반대 판정을 내야 한다. 모양: 정식 이름 가져오기, 이름 바꾼 가져오기, const 별칭, 이름공간 속성, 모듈 객체 별칭,
// 구조 분해, require(전역은 const 별칭·구조 분해·전역 객체 속성). 모듈마다 실제 내보내기 형식(Node 내장·CJS·ESM·두 입구)을 설치된
// 패키지에서 판정해(`moduleFacts`) 그 형식에서 실제로 같은 값에 닿는 모양만 만든다. 만든 모양이 같은 값인지는
// scripts/lint-access-shapes.test.mjs가 실제로 평가해 확인한다.
//
// 선례: ESLint RuleTester는 valid·invalid 사례 배열을 받아 사례를 만들어 넘겨도 된다. eslint-plugin-n의 no-deprecated-api 시험은 API마다
// 접근 모양(`require('buffer').Buffer`, `var b = require('buffer'); new b.Buffer()`, `const {Buffer} = …`, `import {Buffer} …`)을 손으로
// 나열한다. @eslint-community/eslint-utils의 ReferenceTracker 시험은 표(description·code·expected)로 돈다. 여기서는 그 나열을 사례 하나에서
// 만들어, 규칙마다 모양 하나를 빠뜨리는 일을 막는다.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
/** 저장소의 package.json(뿌리, apps·packages 아래). 모듈은 그것을 의존성으로 선언한 패키지 자리에서 찾는다. */
const manifests = [
  ".",
  ...["apps", "packages"].flatMap((group) =>
    readdirSync(path.join(repository, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`)
  ),
]
  .filter((dir) => existsSync(path.join(repository, dir, "package.json")))
  .map((dir) => ({
    dir,
    json: readJson(path.join(repository, dir, "package.json")),
  }));

const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

/** exports 안 어딘가에 `import` 조건이 있는가. */
const hasImportCondition = (exports) =>
  exports !== null &&
  typeof exports === "object" &&
  Object.entries(exports).some(
    ([key, target]) => key === "import" || hasImportCondition(target)
  );

/** 설치된 패키지의 package.json: 저장소 패키지는 그 폴더, 그 밖에는 require가 찾은 파일에서 위로 올라가 이름이 같은 것. */
function installedManifest(load, specifier, name) {
  const workspace = manifests.find(({ json }) => json.name === name);
  if (workspace) return workspace.json;
  for (
    let dir = path.dirname(load.resolve(specifier));
    ;
    dir = path.dirname(dir)
  ) {
    const file = path.join(dir, "package.json");
    if (existsSync(file) && readJson(file).name === name) return readJson(file);
    if (path.dirname(dir) === dir) return {};
  }
}

const facts = new Map();
/**
 * 설치된 모듈의 내보내기 형식(사실, #266 리뷰 SPEC-10). 손으로 적지 않고 설치된 패키지에서 판정한다.
 * - `builtin`: Node 내장 모듈. 기본 가져오기·require 결과가 모듈 객체이고 이름 내보내기는 그 속성이다.
 * - `required`: 그 모듈을 선언한 패키지 자리에서 require해 본 결과. `"namespace"`(ESM 모듈을 require한 결과), `"value"`(CJS의
 *   module.exports). 던지면 `requireError`에 오류 첫 줄(vitest의 CJS 입구처럼 require를 막는 패키지).
 * - `esmEntry`: import가 ESM 입구로 가는가(package.json의 `type: "module"`이거나 exports에 `import` 조건).
 * @typedef {{ builtin?: boolean, required?: "namespace" | "value", requireError?: string, esmEntry?: boolean }} ModuleFacts
 */
function moduleFacts(specifier) {
  if (facts.has(specifier)) return facts.get(specifier);
  /** @type {ModuleFacts} */
  let found;
  if (isBuiltin(specifier)) found = { builtin: true };
  else {
    const name = packageName(specifier);
    const home =
      manifests.find(({ json }) =>
        [json.name === name, json.dependencies, json.devDependencies].some(
          (each) => each === true || (each && name in each)
        )
      ) ?? manifests[0];
    if (!home) throw new Error("저장소에서 package.json을 찾지 못했다");
    const load = createRequire(path.join(repository, home.dir, "package.json"));
    found = {};
    try {
      found.required =
        Object.prototype.toString.call(load(specifier)) === "[object Module]"
          ? "namespace"
          : "value";
    } catch (error) {
      found.requireError = String(
        error instanceof Error ? error.message : error
      ).split("\n")[0];
    }
    const manifest = installedManifest(load, specifier, name);
    found.esmEntry =
      manifest.type === "module" || hasImportCondition(manifest.exports);
  }
  facts.set(specifier, found);
  return found;
}

/** 생성한 이름. 시험 사례의 다른 이름과 겹치지 않게 고른다. */
const names = {
  renamed: "renamedTool",
  alias: "aliasTool",
  namespace: "namespaceTool",
  picked: "pickedTool",
  required: "requiredTool",
  module: "moduleTool",
};

const member = (root, path) => [root, ...path].join(".");

/**
 * 값 `value`(`{ module, path }`: 모듈 `module`이 내보낸 `path[0]`과 그 속성, 또는 `{ global, path }`: 전역 `global`과 그 속성)에 닿는 접근
 * 모양 계획. 모듈의 실제 형식(`moduleFacts`)에 맞는 모양만 `shapes`(`{ shape, lines, ref, same }`)에 넣고, 만들지 않는 모양은
 * `skipped`(`{ shape, reason }`)에 이유와 함께 둔다.
 */
function plan(value, local) {
  const { path: valuePath } = value;
  const shapes = [];
  const skipped = [];
  const add = (shape, lines, ref, same = true) =>
    shapes.push({ shape, lines, ref, same });
  const skip = (shape, reason) => skipped.push({ shape, reason });
  if (value.module === undefined) {
    // 전역 값은 가져오는 모양(이름 바꾼 가져오기·이름공간·require)이 없다. 같은 값을 내보내는 모듈(node:process 등)은 그 모듈 값으로
    // 따로 넘긴다. 전역은 전역 객체의 속성으로도 닿는다.
    const { global } = value;
    add("정식 이름", "", member(global, valuePath));
    add(
      "const 별칭",
      `const ${names.alias} = ${member(global, valuePath)};\n`,
      names.alias
    );
    add(
      "구조 분해",
      valuePath.length === 0
        ? `const { ${global}: ${names.picked} } = globalThis;\n`
        : `const { ${valuePath.at(-1)}: ${names.picked} } = ${member(global, valuePath.slice(0, -1))};\n`,
      names.picked
    );
    add("전역 객체 속성", "", member("globalThis", [global, ...valuePath]));
    skip("가져오기·이름공간·require", "전역 값은 가져오는 모양이 없다");
    if (local)
      add(
        "같은 이름의 지역 값",
        `const ${global} = fakeValue;\n`,
        member(global, valuePath),
        false
      );
    return { shapes, skipped };
  }
  const known = moduleFacts(value.module);
  const [first, ...rest] = valuePath;
  const from = JSON.stringify(value.module);
  const last = valuePath.at(-1);
  const owner = valuePath.slice(0, -1);
  const isDefault = first === "default";
  // ESM으로 가져오는 모양: 내장 모듈·ESM 입구는 이름 내보내기가 그대로 닿는다. ESM 입구가 없는 CJS는 기본 가져오기가 module.exports이고,
  // 이름 내보내기가 import로 닿는지는 Node의 정적 분석(cjs-module-lexer)에 달려 만들지 않는다.
  const importable = known.builtin || known.esmEntry || isDefault;
  if (!importable)
    skip(
      "가져오기·이름공간",
      "ESM 입구가 없는 CJS 모듈의 이름 내보내기가 import로 닿는지는 Node의 정적 분석에 달려 있다"
    );
  else {
    if (isDefault)
      // 기본 내보내기는 가져올 때 언제나 이름을 새로 붙이므로 정식 모양과 이름 바꾼 가져오기가 같다. CJS면 그 값은 module.exports다.
      add(
        "기본 가져오기",
        `import ${names.renamed} from ${from};\n`,
        member(names.renamed, rest)
      );
    else {
      add(
        "정식 이름 가져오기",
        `import { ${first} } from ${from};\n`,
        member(first, rest)
      );
      add(
        "이름 바꾼 가져오기",
        `import { ${first} as ${names.renamed} } from ${from};\n`,
        member(names.renamed, rest)
      );
    }
    const imported = isDefault
      ? `import ${names.renamed} from ${from};\n`
      : `import { ${first} } from ${from};\n`;
    add(
      "const 별칭",
      `${imported}const ${names.alias} = ${member(isDefault ? names.renamed : first, rest)};\n`,
      names.alias
    );
    // 이름공간 객체는 부를 수 없다. CJS 함수 모듈도 `ns.default`로 닿는다(`ns()`는 만들지 않는다).
    add(
      "이름공간 속성",
      `import * as ${names.namespace} from ${from};\n`,
      member(names.namespace, valuePath)
    );
    add(
      "모듈 객체 별칭",
      `import * as ${names.namespace} from ${from};\nconst ${names.module} = ${names.namespace};\n`,
      member(names.module, valuePath)
    );
    add(
      "구조 분해",
      `import * as ${names.namespace} from ${from};\nconst { ${last}: ${names.picked} } = ${member(names.namespace, owner)};\n`,
      names.picked
    );
  }
  // require 모양(CJS 파일·createRequire가 만든 함수에서 쓰는 모양). require가 던지는 모듈, CJS와 ESM 입구가 따로인 모듈(두 입구가 같은
  // 값을 준다는 보장이 없다)은 만들지 않는다. CJS·내장 모듈의 기본 값은 require 결과 자체, ESM 모듈을 require한 결과는 이름공간이다.
  if (known.requireError)
    skip("require", `require하면 던진다: ${known.requireError}`);
  else if (known.required === "value" && known.esmEntry)
    skip(
      "require",
      "CJS 입구와 ESM 입구가 따로라 같은 값을 준다는 보장이 없다"
    );
  else if (isDefault && known.required !== "namespace")
    add(
      "require 결과",
      `const ${names.required} = require(${from});\n`,
      member(names.required, rest)
    );
  else
    add(
      "require 구조 분해",
      `const { ${first}: ${names.required} } = require(${from});\n`,
      member(names.required, rest)
    );
  // 같은 이름의 지역 값: 정식 모양과 같은 철자로 쓰지만 가져온 것이 아니다. 기본 내보내기는 정해진 철자가 없어 만들지 않는다.
  if (local && !isDefault)
    add(
      "같은 이름의 지역 값",
      `const ${first} = fakeValue;\n`,
      member(first, rest),
      false
    );
  return { shapes, skipped };
}

/**
 * 값 `value`에 닿는 접근 모양마다 사례를 만든다(`plan`). `use(ref)`는 그 값을 `ref`로 쓰는 시험 코드, `head`는 모든 사례 앞에 둘 코드다.
 * 돌려주는 사례는 `{ shape, code, same }`이고, `same`이 참이면 정식 사례와 같은 판정, 거짓(같은 이름의 지역 값)이면 반대 판정이어야 한다.
 * `local: false`면 지역 값 사례를 만들지 않는다(그 이유를 `localSkipped`에 적는다).
 * @param {{ value: { module?: string, global?: string, path: string[] }, use: (ref: string) => string, head?: string,
 *   local?: boolean, localSkipped?: string }} options
 */
export function accessShapes({
  value,
  use,
  head = "",
  local = true,
  localSkipped,
}) {
  if (local === false && !localSkipped)
    throw new Error("a case that skips the same-named local needs the reason");
  return plan(value, local).shapes.map(({ shape, lines, ref, same }) => ({
    shape,
    code: `${lines}${head}${use(ref)}`,
    same,
  }));
}

/** 값 `value`에 만들지 않는 모양과 그 이유(`{ shape, reason }`). */
export const skippedShapes = (value) => plan(value, false).skipped;
