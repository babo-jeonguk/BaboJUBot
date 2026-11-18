// 제품 코드 전용 lint 규칙. 설정은 eslint.config.js의 `productFiles` 범위에 걸고, 회귀 시험은 scripts/product-lint-rules.test.mjs가 맡는다.
// `no-restricted-syntax`는 설정 블록끼리 덮어써서 서버·runtime의 기존 금지와 함께 걸 수 없으므로 규칙으로 둔다.

const wrappers = new Set([
  "AwaitExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

/** `await`·`?.`·`!`·단정을 벗긴 값. `x as unknown as T`도 안쪽의 `x`를 본다. */
function unwrap(node) {
  let value = node;
  while (wrappers.has(value.type))
    value =
      value.type === "AwaitExpression" ? value.argument : value.expression;
  return value;
}

/** `JSON.parse(...)`, 응답 본문 `x.json()`, 그 값에 기본값을 붙이거나 `.catch`·`.then`으로 이어 받은 값인가. */
function readsOutsideData(node) {
  const value = unwrap(node);
  if (value.type === "LogicalExpression")
    return readsOutsideData(value.left) || readsOutsideData(value.right);
  if (value.type !== "CallExpression") return false;
  const { callee } = value;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  switch (callee.property.name) {
    case "parse":
      return (
        callee.object.type === "Identifier" && callee.object.name === "JSON"
      );
    case "json":
      return true;
    case "catch":
      return readsOutsideData(callee.object);
    case "then": {
      const [callback] = value.arguments;
      return (
        callback?.type === "ArrowFunctionExpression" &&
        callback.body.type !== "BlockStatement" &&
        readsOutsideData(callback.body)
      );
    }
    default:
      return false;
  }
}

/**
 * 문자열을 JSON으로 읽은 결과나 응답 본문에 바로 타입을 단정하면 잘못된 입력이 타입을 믿는 코드까지 내려간다.
 * `as unknown`은 확인 전의 값이라는 뜻이므로 허용한다.
 * 알려진 한계: 읽는 호출에 바로 붙은 단정만 본다. 타입 없는 중간 변수, 조건식, 블록 본문이나 함수 이름으로 넘긴 콜백,
 * `globalThis.JSON`을 거친 값의 단정은 잡지 못하며 그 경우는 리뷰가 본다.
 */
const noAssertionOnParsedData = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow asserting a type directly on parsed JSON or a response body",
    },
    schema: [],
    messages: {
      asserted:
        "읽자마자 타입을 단정하면 잘못된 입력이 그대로 내려갑니다. `const value: unknown = ...`으로 받고 스키마(safeParse)나 필드 확인으로 좁히세요.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (node.typeAnnotation.type === "TSUnknownKeyword") return;
        if (readsOutsideData(node.expression))
          context.report({ node, messageId: "asserted" });
      },
    };
  },
};

const childProcess = new Set(["child_process", "node:child_process"]);
const syncLaunchers = new Set(["execFileSync", "spawnSync", "execSync"]);

/** 상한이 없다는 뜻인 값: Node는 `timeout`이 0이거나 없으면 기다림에 끝을 두지 않는다. */
const unbounded = (value) =>
  (value.type === "Literal" && value.value === 0) ||
  (value.type === "Identifier" && value.name === "undefined");

/** 옵션 객체 리터럴이 `timeout` 속성을 직접 갖는가(`{ timeout: ms }`, `{ timeout }`). 0·undefined는 상한이 아니다. */
const hasTimeout = (node) =>
  node.type === "ObjectExpression" &&
  node.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" &&
        property.key.name === "timeout") ||
        (property.key.type === "Literal" &&
          property.key.value === "timeout")) &&
      !unbounded(property.value)
  );

/**
 * 외부 프로그램을 동기로 띄우면 그 프로그램이 끝날 때까지 이벤트 루프 전체가 멈춘다. 서버 시작·복구 중에 답하지 않는
 * 보조 명령(ps, PowerShell, taskkill)이 서버를 붙잡지 않도록, 동기 실행은 옵션 객체 리터럴에 `timeout`을 둘 때만 허용한다.
 * child_process에서 가져온 이름(바꾼 이름 포함)과 `모듈.execFileSync(...)` 모양의 호출을 본다. 옵션을 변수로 넘기면 상한을
 * 확인할 수 없으므로 짚는다. 계산한 경로로 가져오거나 구조 분해·다른 변수로 함수를 옮겨 부르는 것은 따라가지 않는다.
 */
const syncCommandTimeout = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require a timeout option on synchronous child_process calls in product code",
    },
    schema: [],
    messages: {
      missing:
        "{{name}} 호출은 프로그램이 끝날 때까지 서버 전체를 멈춥니다. 비동기 실행(execFile·spawn, runtime 연결 코드는 providers/process.ts의 runProbe)을 쓰거나, 동기 실행이 꼭 필요하면 옵션 객체 리터럴에 timeout을 두고 상한이 지난 결과(error.code === \"ETIMEDOUT\")를 '모름'으로 처리하세요.",
    },
  },
  create(context) {
    /** 이 파일에서 child_process의 동기 실행 함수를 가리키는 지역 이름 → 원래 이름. */
    const imported = new Map();
    return {
      ImportDeclaration(node) {
        if (!childProcess.has(node.source.value)) return;
        for (const specifier of node.specifiers)
          if (
            specifier.type === "ImportSpecifier" &&
            syncLaunchers.has(specifier.imported.name)
          )
            imported.set(specifier.local.name, specifier.imported.name);
      },
      CallExpression(node) {
        const { callee } = node;
        const name =
          callee.type === "Identifier"
            ? imported.get(callee.name)
            : callee.type === "MemberExpression" &&
                !callee.computed &&
                syncLaunchers.has(callee.property.name)
              ? callee.property.name
              : undefined;
        if (!name || node.arguments.some(hasTimeout)) return;
        context.report({ node, messageId: "missing", data: { name } });
      },
    };
  },
};

const ignoredErrorGuide =
  "버려야 하면 @babojubot/contracts의 이름 붙은 함수를 쓰세요: orIfMissing(없으면 기본값), continueAfterFailure(실패해도 진행), orIfUnreadable(읽을 수 없으면 아님), settled(순서만 지킴). CODING_STANDARDS.md#제품-코드";

/** 오류를 받는 처리기의 자리: `.catch(처리기)`, `.then(성공, 처리기)`. */
const handlerPositions = new Map([
  ["catch", 0],
  ["then", 1],
]);
const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

/** 본문이 다른 오류를 던지는 한 문장뿐인가(`catch { throw new Refusal() }`, `.catch(() => { throw … })`). */
function onlyThrows(body) {
  return (
    body.type === "BlockStatement" &&
    body.body.length === 1 &&
    body.body[0].type === "ThrowStatement"
  );
}

/** `_`로 시작해 쓰지 않는다고 표시한 오류 이름인가. */
const markedUnused = (param) =>
  param?.type === "Identifier" && param.name.startsWith("_");

/**
 * 오류를 받지 않고 버리면 의도한 처리(파일 없음은 없는 것)와 실수(권한 오류까지 빈 결과로 바꿈)가 코드에서 같아 보인다.
 * 오류 변수가 없는 `catch`, 인자 없는 `.catch` 처리기와 `.then`의 거부 처리기, `_`를 붙인 오류 이름을 막는다.
 * 다른 오류를 던지는 한 문장뿐인 처리는 버리는 것이 아니므로 허용한다. 받고 쓰지 않는 오류는 `no-unused-vars`가 막는다.
 * 알려진 한계: 이름으로 넘긴 처리기(`.then(settle, settle)`), `void error`처럼 쓰는 척만 하는 처리, 이름 붙은 함수를
 * 의도와 다르게 쓰는 것(바깥 입출력을 `orIfUnreadable`로 감싸기)은 판정하지 않으며 리뷰가 본다.
 */
const noIgnoredError = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow dropping an error without naming it or the intent in product code",
    },
    schema: [],
    messages: {
      unnamed: `오류를 받지 않고 버리면 왜 버리는지 보이지 않습니다. 오류를 받아 검사하거나 다시 던지세요. ${ignoredErrorGuide}`,
      underscore: `\`_\`를 붙여 쓰지 않는 오류도 버리는 것입니다. 오류를 받아 검사하거나 다시 던지세요. ${ignoredErrorGuide}`,
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        if (markedUnused(node.param))
          context.report({ node: node.param, messageId: "underscore" });
        else if (!node.param && !onlyThrows(node.body))
          context.report({ node, messageId: "unnamed" });
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const position = handlerPositions.get(callee.property.name);
        const handler =
          position === undefined ? undefined : node.arguments[position];
        if (!handler || !functionTypes.has(handler.type)) return;
        if (markedUnused(handler.params[0]))
          context.report({ node: handler.params[0], messageId: "underscore" });
        else if (handler.params.length === 0 && !onlyThrows(handler.body))
          context.report({ node: handler, messageId: "unnamed" });
      },
    };
  },
};

export default {
  rules: {
    "no-assertion-on-parsed-data": noAssertionOnParsedData,
    "sync-command-timeout": syncCommandTimeout,
    "no-ignored-error": noIgnoredError,
  },
};
