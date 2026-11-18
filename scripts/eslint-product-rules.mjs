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

/** `JSON.parse(...)`, 응답 본문 `x.json()`, 그 실패를 받은 `x.json().catch(...)`인가. */
function readsOutsideData(node) {
  const call = unwrap(node);
  if (call.type !== "CallExpression") return false;
  const { callee } = call;
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
    default:
      return false;
  }
}

/**
 * 문자열을 JSON으로 읽은 결과나 응답 본문에 바로 타입을 단정하면 잘못된 입력이 타입을 믿는 코드까지 내려간다.
 * `as unknown`은 확인 전의 값이라는 뜻이므로 허용한다.
 * 알려진 한계: 읽는 자리만 본다. 타입 없는 중간 변수를 거친 값의 단정은 잡지 못하며 그 경우는 리뷰가 본다.
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

export default {
  rules: { "no-assertion-on-parsed-data": noAssertionOnParsedData },
};
