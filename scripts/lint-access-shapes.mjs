// 출처로 판정하는 lint 규칙의 시험에 쓰는 접근 모양 생성기(#266 리뷰 SPEC-8·9). 모양: 정식 이름 가져오기, 이름 바꾼 가져오기, const 별칭,
// 이름공간 속성, 모듈 객체 별칭, 구조 분해, require 구조 분해(전역은 const 별칭·구조 분해·전역 객체 속성), 그리고 같은 이름의 지역 값. 규칙 시험이 잘못된(또는 받는) 사례 하나를 정식 이름으로
// 주면, 같은 값에 닿는 다른 접근 모양으로 바꾼 사례와 같은 이름의 지역 값으로 바꾼 사례를 만든다. 규칙은 접근 모양이 달라도 같은 판정을,
// 같은 이름의 지역 값에는 반대 판정을 내야 한다.
//
// 선례: ESLint RuleTester는 valid·invalid 사례 배열을 받아 사례를 만들어 넘겨도 된다. eslint-plugin-n의 no-deprecated-api 시험은 API마다
// 접근 모양(`require('buffer').Buffer`, `var b = require('buffer'); new b.Buffer()`, `const {Buffer} = …`, `import {Buffer} …`)을 손으로
// 나열한다. @eslint-community/eslint-utils의 ReferenceTracker 시험은 표(description·code·expected)로 돈다. 여기서는 그 나열을 사례 하나에서
// 만들어, 규칙마다 모양 하나를 빠뜨리는 일을 막는다.

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
 * 모양마다 사례를 만든다. `use(ref)`는 그 값을 `ref`로 쓰는 시험 코드, `head`는 모든 사례 앞에 둘 코드다. 돌려주는 사례는
 * `{ shape, code, same }`이고, `same`이 참이면 정식 사례와 같은 판정, 거짓(같은 이름의 지역 값)이면 반대 판정이어야 한다.
 * `local: false`면 지역 값 사례를 만들지 않는다(그 이유를 `localSkipped`에 적는다).
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
  const { path } = value;
  const cases = [];
  const add = (shape, lines, ref, same = true) =>
    cases.push({ shape, code: `${lines}${head}${use(ref)}`, same });
  if (value.module !== undefined) {
    const [first, ...rest] = path;
    const from = JSON.stringify(value.module);
    const last = path.at(-1);
    const owner = path.slice(0, -1);
    if (first === "default") {
      // 기본 내보내기는 가져올 때 언제나 이름을 새로 붙이므로 정식 모양과 이름 바꾼 가져오기가 같다.
      add(
        "기본 가져오기",
        `import ${names.renamed} from ${from};\n`,
        member(names.renamed, rest)
      );
    } else {
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
    const imported =
      first === "default"
        ? `import ${names.renamed} from ${from};\n`
        : `import { ${first} } from ${from};\n`;
    const root = first === "default" ? names.renamed : first;
    add(
      "const 별칭",
      `${imported}const ${names.alias} = ${member(root, rest)};\n`,
      names.alias
    );
    add(
      "이름공간 속성",
      `import * as ${names.namespace} from ${from};\n`,
      member(names.namespace, path)
    );
    add(
      "모듈 객체 별칭",
      `import * as ${names.namespace} from ${from};\nconst ${names.module} = ${names.namespace};\n`,
      member(names.module, path)
    );
    add(
      "구조 분해",
      `import * as ${names.namespace} from ${from};\nconst { ${last}: ${names.picked} } = ${member(names.namespace, owner)};\n`,
      names.picked
    );
    add(
      "require 구조 분해",
      `const { ${first}: ${names.required} } = require(${from});\n`,
      member(names.required, rest)
    );
    // 같은 이름의 지역 값: 정식 모양과 같은 철자로 쓰지만 가져온 것이 아니다. 기본 내보내기는 정해진 철자가 없어 만들지 않는다.
    if (local && first !== "default")
      add(
        "같은 이름의 지역 값",
        `const ${first} = fakeValue;\n`,
        member(first, rest),
        false
      );
    return cases;
  }
  // 전역 값은 가져오는 모양(이름 바꾼 가져오기·이름공간·require)이 없다. 같은 값을 내보내는 모듈(node:process 등)은 그 모듈 값으로 따로
  // 넘긴다. 전역은 전역 객체의 속성으로도 닿는다.
  const { global } = value;
  add("정식 이름", "", member(global, path));
  add(
    "const 별칭",
    `const ${names.alias} = ${member(global, path)};\n`,
    names.alias
  );
  add(
    "구조 분해",
    path.length === 0
      ? `const { ${global}: ${names.picked} } = globalThis;\n`
      : `const { ${path.at(-1)}: ${names.picked} } = ${member(global, path.slice(0, -1))};\n`,
    names.picked
  );
  add("전역 객체 속성", "", member("globalThis", [global, ...path]));
  if (local)
    add(
      "같은 이름의 지역 값",
      `const ${global} = fakeValue;\n`,
      member(global, path),
      false
    );
  return cases;
}
