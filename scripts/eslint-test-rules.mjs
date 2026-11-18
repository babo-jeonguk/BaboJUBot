// 시험 코드 전용 lint 규칙. 코드 모양만으로는 판단할 수 없고 값이 어디로 가는지 따라가야 하는 규칙을 둔다.
// 설정은 eslint.config.js의 `testFiles` 범위에 걸고, 회귀 시험은 scripts/lint-rules.test.mjs가 맡는다.

const clocks = new Set(["Date", "performance"]);
// 실제 시계를 읽는 `Date.now()`·`performance.now()`.
const readsClock = (node) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.name === "now" &&
  node.callee.object.type === "Identifier" &&
  clocks.has(node.callee.object.name);

/** `expect(...)`·`expect(...).toBe(...)`·`assert(...)`·`assert.ok(...)`처럼 이름이 expect·assert로 시작하는 호출인가. */
function isAssertion(call) {
  let callee = call.callee;
  for (;;) {
    if (callee.type === "MemberExpression") callee = callee.object;
    else if (callee.type === "CallExpression") callee = callee.callee;
    else break;
  }
  return (
    callee.type === "Identifier" &&
    (callee.name === "expect" || callee.name === "assert")
  );
}

/** 값이 계산을 거쳐도 경과 시간인 채로 남는 자리: 산술·비교(`ms / 1000`, `ms < 500`), 부정, 타입 단언, `Math.round(ms)` 같은 계산. */
function keepsValue(parent, child) {
  switch (parent.type) {
    case "BinaryExpression":
    case "UnaryExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ChainExpression":
      return true;
    case "CallExpression":
      return (
        parent.arguments.includes(child) &&
        parent.callee.type === "MemberExpression" &&
        parent.callee.object.type === "Identifier" &&
        parent.callee.object.name === "Math"
      );
    default:
      return false;
  }
}

/**
 * 시험이 실제 시계로 잰 경과 시간(`Date.now() - 시작`)을 단언하면 결과가 실행기 속도에 달린다(CODING_STANDARDS.md#시간).
 * 경과 시간이 계산·비교를 거쳐 단언 호출의 인자가 되면 짚는다(`expect(Date.now() - t)`, `assert.ok(Date.now() - t < 5000)`).
 * 변수에 담은 경과 시간은 그 변수를 읽는 곳까지 따라간다. 시작 시각이 상수인 것(`Date.now() - 60_000`, 지난 시각 만들기)과
 * 객체·`new Date(...)`·다른 함수에 넘긴 값, 로그·측정값으로 남기는 것, 남은 시간(`시한 - Date.now()`), 시한 비교(`Date.now() < deadline`)는 짚지 않는다.
 * 경과 시간으로 시험의 흐름을 가르는 것(`Date.now() - t < 900 ? a : b`)은 대기 상한과 모양으로 구분되지 않아 짚지 않는다.
 */
const noElapsedTimeAssertion = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow asserting real elapsed time measured with Date.now() or performance.now() in tests",
    },
    schema: [],
    messages: {
      elapsed:
        "시험이 실제로 잰 경과 시간을 단언합니다. 결과가 실행기 속도에 달려 느린 실행기에서 깨집니다. 시한·타이머 순서는 가짜 시계(packages/runtime/src/providers/test-support.ts `manualClock`)를 주입해 시험이 정하고, 그 밖에는 걸린 시간 대신 순서·상태(처리 끝 신호, 시한을 적은 진단, 시험 시한)를 단언하세요. CODING_STANDARDS.md#시간",
    },
  },
  create(context) {
    const { sourceCode } = context;

    /** `node`의 값이 단언에 닿는지 위로 따라간다. 변수에 담기면 그 변수를 읽는 곳마다 다시 따라간다. */
    function follow(node, seen) {
      let child = node;
      for (let parent = child.parent; parent; parent = child.parent) {
        if (
          parent.type === "CallExpression" &&
          parent.arguments.includes(child) &&
          isAssertion(parent)
        )
          return true;
        if (
          parent.type === "VariableDeclarator" &&
          parent.init === child &&
          parent.id.type === "Identifier"
        )
          return sourceCode
            .getDeclaredVariables(parent)
            .some((variable) => readsReach(variable, seen));
        if (
          parent.type === "AssignmentExpression" &&
          parent.right === child &&
          parent.left.type === "Identifier"
        ) {
          const variable = findVariable(parent.left);
          return variable ? readsReach(variable, seen) : false;
        }
        // 객체·다른 함수·문·함수 경계에 닿으면 더 따라가지 않는다(반환값도 따라가지 않는다).
        if (!keepsValue(parent, child)) return false;
        child = parent;
      }
      return false;
    }

    function readsReach(variable, seen) {
      if (seen.has(variable)) return false;
      seen.add(variable);
      return variable.references.some(
        (reference) => reference.isRead() && follow(reference.identifier, seen)
      );
    }

    function findVariable(identifier) {
      for (
        let scope = sourceCode.getScope(identifier);
        scope;
        scope = scope.upper
      ) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
      }
      return undefined;
    }

    return {
      BinaryExpression(node) {
        if (node.operator !== "-" || !readsClock(node.left)) return;
        // 상수를 뺀 것은 지난 시각을 만드는 것이다.
        if (node.right.type === "Literal") return;
        if (follow(node, new Set()))
          context.report({ node, messageId: "elapsed" });
      },
    };
  },
};

export default {
  meta: { name: "babojubot-tests" },
  rules: { "no-elapsed-time-assertion": noElapsedTimeAssertion },
};
