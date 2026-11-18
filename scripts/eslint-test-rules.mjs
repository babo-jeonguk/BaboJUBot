// 시험 코드 전용 lint 규칙. 선택자만으로는 판단할 수 없는 규칙(값이 어디로 가는지, 타이머가 무엇을 하는지)을 둔다.
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
 * 실제 시계로 초기화·대입한 변수에서 빼는 것도 경과 시간이다(`const finished = Date.now(); expect(finished - started)`).
 * 시각을 객체 속성이나 Promise에 담았다 빼는 것(`signal.at - term.at`)은 따라가지 않는다.
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

    /** 실제 시계를 읽은 값인가: `Date.now()`·`performance.now()` 호출, 또는 그 호출로 초기화·대입한 적이 있는 변수. */
    function isClockTime(node) {
      if (readsClock(node)) return true;
      if (node.type !== "Identifier") return false;
      const variable = findVariable(node);
      return (
        variable?.references.some(
          (reference) => reference.writeExpr && readsClock(reference.writeExpr)
        ) ?? false
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
        if (node.operator !== "-" || !isClockTime(node.left)) return;
        // 상수를 뺀 것은 지난 시각을 만드는 것이다.
        if (node.right.type === "Literal") return;
        if (follow(node, new Set()))
          context.report({ node, messageId: "elapsed" });
      },
    };
  },
};

const timerModules = /^(node:)?timers\/promises$/;
const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression";

/** `Promise.race([...])`·`Promise.any([...])`의 한쪽으로 바로 넣은 값인가. */
function raceMember(node) {
  const array = node.parent;
  if (array?.type !== "ArrayExpression") return false;
  const call = array.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments[0] === array &&
    call.callee.type === "MemberExpression" &&
    !call.callee.computed &&
    call.callee.object.type === "Identifier" &&
    call.callee.object.name === "Promise" &&
    (call.callee.property.name === "race" ||
      call.callee.property.name === "any")
  );
}

/** `node`를 품은 가장 가까운 `new Promise(executor)`의 executor. */
function enclosingExecutor(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (
      isFunction(parent) &&
      parent.parent?.type === "NewExpression" &&
      parent.parent.callee.type === "Identifier" &&
      parent.parent.callee.name === "Promise" &&
      parent.parent.arguments[0] === parent
    )
      return parent;
  return undefined;
}

/** 타이머 콜백이 `resolve`를 인자 없이 부르기만 하는가(`resolve` 자체, `() => resolve()`, `() => { resolve(); }`). */
function onlyWakes(callback, resolve) {
  if (callback?.type === "Identifier") return callback.name === resolve;
  if (!isFunction(callback)) return false;
  let body = callback.body;
  if (body.type === "BlockStatement") {
    if (body.body.length !== 1 || body.body[0].type !== "ExpressionStatement")
      return false;
    body = body.body[0].expression;
  }
  return (
    body.type === "CallExpression" &&
    body.callee.type === "Identifier" &&
    body.callee.name === resolve &&
    body.arguments.length === 0
  );
}

/**
 * 시험이 정해진 시간만큼 잠들어 기다리면 결과가 실행기 속도에 달린다(CODING_STANDARDS.md#시간).
 * 타이머가 잠든 쪽을 깨우기만 하면 기다림으로 보고 짚는다.
 * - `new Promise((r) => setTimeout(r, N))`·`setTimeout(() => r(), N)`: await하든, `.then`으로 잇든, 함수가 돌려주든(잠듦 도움 함수) 같다.
 * - `node:timers/promises`에서 가져온 것(`setTimeout`·`scheduler.wait` 등)의 호출, `.waitForTimeout(…)`(Playwright).
 * 타이머가 무언가를 하면 기다림이 아니다: 실패를 알리는 상한(`reject`·중단·kill), 값을 넘기는 타이머(가짜의 늦은 응답, 상한의 표지),
 * 가짜가 응답을 보내는 타이머, 깨어나 같은 조건을 다시 확인하는 타이머(`setTimeout(poll, N)`), 시계 주입 타이머(`clock.setTimeout`).
 * `Promise.race`·`Promise.any`의 한쪽으로 바로 넣은 타이머는 다른 쪽을 기다리는 상한이다. 지연이 0이거나 없는 것은 시간을 기다리지 않는다.
 * 그래서 표지 값으로 "아무 일도 없었다"를 확인하는 경주(`resolve("open")`)는 짚지 않는다. 다시 확인하는 반복의 상한 유무도 보지 않는다.
 */
const noFixedTimeWait = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow waiting a fixed time in tests instead of a state or a signal",
    },
    schema: [],
    messages: {
      fixed:
        "시험이 정해진 시간만큼 잠들어 기다립니다. 잠든 시간은 신호가 아니어서 느린 실행기에서는 기다리던 일이 아직 끝나지 않습니다. 상태·준비 줄·처리 끝 신호를 vi.waitFor·expect.poll·공용 상한(eventually·leadRun·pageLoad)으로 기다리고, 타이머 순서는 시계를 주입해(manualClock·가짜 타이머) 시험이 정하세요. CODING_STANDARDS.md#시간",
    },
  },
  create(context) {
    /** `timers/promises`에서 가져온 이름. */
    const timers = new Set();
    const report = (node) => context.report({ node, messageId: "fixed" });
    return {
      ImportDeclaration(node) {
        if (!timerModules.test(node.source.value)) return;
        for (const specifier of node.specifiers)
          timers.add(specifier.local.name);
      },
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.name === "waitForTimeout"
        )
          return report(node);
        if (callee.type === "Identifier" && timers.has(callee.name))
          return report(node);
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          timers.has(callee.object.name)
        )
          return report(node);
        if (callee.type !== "Identifier" || callee.name !== "setTimeout")
          return;
        const delay = node.arguments[1];
        if (!delay || (delay.type === "Literal" && delay.value === 0)) return;
        const executor = enclosingExecutor(node);
        const resolve = executor?.params[0];
        if (resolve?.type !== "Identifier" || raceMember(executor.parent))
          return;
        if (onlyWakes(node.arguments[0], resolve.name)) report(node);
      },
    };
  },
};

/** `node`가 `x.<이름>(…)` 호출이면 그 이름. */
const methodOf = (node) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier"
    ? node.callee.property.name
    : undefined;
const positions = new Set(["first", "last", "nth"]);
const queries = /^(getBy[A-Z][A-Za-z]*|locator)$/;
// 접근성 이름이나 글자로 찾는 검색.
const nameQueries = new Set([
  "getByText",
  "getByLabel",
  "getByTitle",
  "getByAltText",
  "getByPlaceholder",
]);
const hasOption = (argument, name) =>
  argument?.type === "ObjectExpression" &&
  argument.properties.some(
    (p) =>
      p.type === "Property" &&
      !p.computed &&
      p.key.type === "Identifier" &&
      p.key.name === name
  );
/** 이름·글자로 걸러 찾는 단계인가: `getByText(…)`·`getByRole(r, { name })`·`.filter({ hasText })` 등. */
function matchesByName(call) {
  const method = methodOf(call);
  return (
    nameQueries.has(method) ||
    (method === "getByRole" && hasOption(call.arguments[1], "name")) ||
    (method === "filter" && hasOption(call.arguments[0], "hasText"))
  );
}

/**
 * E2E가 대상을 화면 전체나 순서로 찾으면 같은 문구가 다른 영역에 생길 때 다른 요소를 잡거나 여럿이 잡힌다(CODING_STANDARDS.md#화면).
 * 세 모양을 짚는다. 페이지인지는 타입(Playwright `Page`)으로 가린다.
 * - 화면 전체에서 글자로 찾기: `page.getByText(…)`.
 * - 화면 전체에서 찾은 것 중 순서로 고르기: `page.getByRole(…)[.filter(…)·.and(…)].first()`·`.last()`·`.nth(…)`.
 * - 이름·글자로 찾은 것 중 순서로 고르기(영역 안이어도): `area.getByText(…).first()`, `getByRole(r, { name }).nth(i)`, `.filter({ hasText }).first()`.
 * 영역·대화상자·조작 요소를 페이지에서 찾는 것, 이름 없는 목록 항목을 순서로 고르는 것(순서 확인), `a.or(b).first()`(둘 중 먼저 뜨는 것)는 짚지 않는다.
 * 변수에 담은 locator는 따라가지 않는다. 화면에 하나뿐인지(오류·상태 안내, 이동 주소)는 판단이 필요해 CODING_STANDARDS.md에 둔다.
 */
const noPageWideLocator = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow finding an E2E target by text on the whole page or by position among page-wide or same-name matches",
    },
    schema: [],
    messages: {
      pageText:
        "화면 전체에서 글자로 대상을 찾습니다. 같은 글이 대화 목록·활동·알림 같은 다른 영역에 생기면 다른 요소를 잡거나 여럿이 잡혀 실패합니다. 그 조직·대화·영역 locator(영역 이름, 조직 ID로 고른 locator) 안에서 찾고, 기다릴 대상은 동작이 새로 만든 ID로 찾으세요. CODING_STANDARDS.md#화면",
      pagePosition:
        "화면 전체에서 찾은 여러 요소 중 순서(first·last·nth)로 하나를 고릅니다. 화면이 바뀌면 다른 요소를 고릅니다. 그 영역 locator 안에서 하나만 맞게 찾고, 동작이 새로 만든 것은 그 ID로 찾으세요. CODING_STANDARDS.md#화면",
      namePosition:
        "이름·글자로 찾은 요소가 여럿이라 순서(first·last·nth)로 고릅니다. 이번 동작의 것인지 가리지 못해, 앞서 있던 같은 이름을 잡고 기다리지 않고 통과할 수 있습니다. 동작이 새로 만든 ID(data 속성, 주소)로 하나만 고르거나 그 영역 안으로 좁히세요. 순서 자체를 확인할 때는 이름 없이 목록 항목을 순서로 고르세요. CODING_STANDARDS.md#화면",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program)
      throw new Error(
        "tests/no-page-wide-locator needs type information (parserOptions.projectService)"
      );
    /** Playwright `Page` 값인가. */
    const isPage = (node) =>
      services.getTypeAtLocation(node).getSymbol()?.getName() === "Page";
    return {
      CallExpression(node) {
        const method = methodOf(node);
        if (method === "getByText" && isPage(node.callee.object))
          return context.report({ node, messageId: "pageText" });
        if (!positions.has(method)) return;
        // 고르기 직전의 거르기(`filter`·`and`)를 건너 찾은 단계까지 내려간다.
        let found = node.callee.object;
        let byName = false;
        for (;;) {
          byName ||= matchesByName(found);
          const step = methodOf(found);
          if (step !== "filter" && step !== "and") break;
          found = found.callee.object;
        }
        if (queries.test(methodOf(found) ?? "") && isPage(found.callee.object))
          return context.report({ node, messageId: "pagePosition" });
        if (byName) context.report({ node, messageId: "namePosition" });
      },
    };
  },
};

/** 동기로 던지는 정리: `process.kill`(대상이 이미 사라지면 ESRCH)과 이름이 `Sync`로 끝나는 호출(`fs.rmSync`·`chmodSync` 등). */
function throwsSync(call) {
  const { callee } = call;
  if (callee.type === "Identifier") return /Sync$/.test(callee.name);
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const name = callee.property.name;
  return (
    /Sync$/.test(name) ||
    (name === "kill" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "process")
  );
}

/**
 * 시험의 `finally`에서 정리가 실패하면 그 오류가 시험의 원래 실패를 가리고, 앞 정리가 실패하면 뒤 정리를 건너뛴다
 * (CODING_STANDARDS.md#정리). 두 모양을 짚는다.
 * - `finally` 안의 기다림(`await`·`for await`). 하나뿐이어도, 끝나기만 하는 기다림이어도 짚는다. 이 모양이 남으면 실패할 수
 *   있는 새 정리가 그것을 따라 한다. 정리는 자원을 잡은 직후 `onTestFinished`·`withCleanup`에 등록한다.
 * - `finally` 안에서 `try…catch` 밖에 둔 동기 `process.kill`과 `*Sync` 호출. 살아 있는지 먼저 확인해도 그 사이에 끝날 수 있다.
 * `finally` 안에 정의한 함수의 몸은 따로 돈다고 보고 보지 않는다. 기다리지 않는 다른 호출(`clearTimeout`·`mockRestore`·`child.kill`)은
 * 던지는지 모양으로 알 수 없어 짚지 않는다.
 */
const noCleanupInFinally = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow waiting or calling a cleanup that can throw in a test's finally block",
    },
    schema: [],
    messages: {
      awaited:
        "finally에서 정리를 기다립니다. 정리가 실패하면 그 오류가 시험의 원래 실패를 가리고, 앞 정리가 실패하면 뒤 정리를 건너뛰어 프로그램·폴더가 남습니다. 자원을 잡은 직후 정리를 등록하세요: Vitest는 onTestFinished, 시험 중간·node:test·Playwright는 withCleanup(@babojubot/runtime/test-cleanup)의 defer. 등록한 정리는 역순으로 모두 돌고 그 실패는 원래 실패와 함께 보고됩니다. 앞 단계가 끝나야 하는 정리(프로그램을 끈 뒤 그 폴더 지우기)는 한 등록 안에 차례로 두고, 서로 무관한 단계는 cleanUpAll로 모두 시도하세요. CODING_STANDARDS.md#정리",
      thrown:
        "finally에서 던질 수 있는 동기 정리(process.kill·*Sync)를 부릅니다. 대상이 이미 끝났거나 지우기가 실패하면 그 오류가 시험의 원래 실패를 가리고 뒤 정리를 건너뜁니다. 이미 사라진 대상만 넘어가는 끄기 함수(killAndWait 등)를 쓰고, 정리는 자원을 잡은 직후 onTestFinished나 withCleanup(@babojubot/runtime/test-cleanup)의 defer로 등록하세요. CODING_STANDARDS.md#정리",
    },
  },
  create(context) {
    const reported = new Set();
    /**
     * `node`가 함수 경계를 넘지 않고 닿는 `finally` 블록. `guardable`이면 그 사이의 `try…catch` 본문 안은 지킨 것으로 보고 넘긴다.
     */
    function enclosingFinally(node, guardable) {
      let child = node;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (isFunction(parent) || parent.type === "FunctionDeclaration")
          return undefined;
        if (parent.type === "TryStatement") {
          if (parent.finalizer === child) return parent.finalizer;
          if (guardable && parent.block === child && parent.handler)
            return undefined;
        }
        child = parent;
      }
      return undefined;
    }
    const awaited = (node) => {
      const block = enclosingFinally(node, false);
      // 한 블록은 한 번만 알린다. 정리를 옮기면 블록의 기다림이 모두 없어진다.
      if (!block || reported.has(block)) return;
      reported.add(block);
      context.report({ node, messageId: "awaited" });
    };
    return {
      AwaitExpression: awaited,
      ForOfStatement(node) {
        if (node.await) awaited(node);
      },
      CallExpression(node) {
        if (throwsSync(node) && enclosingFinally(node, true))
          context.report({ node, messageId: "thrown" });
      },
    };
  },
};

export default {
  meta: { name: "babojubot-tests" },
  rules: {
    "no-cleanup-in-finally": noCleanupInFinally,
    "no-elapsed-time-assertion": noElapsedTimeAssertion,
    "no-fixed-time-wait": noFixedTimeWait,
    "no-page-wide-locator": noPageWideLocator,
  },
};
